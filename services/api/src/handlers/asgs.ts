// GET /asgs[?accountId=123456789012]: every Auto Scaling group across the tenant's
// connected accounts and regions. One slow or broken account doesn't fail the whole list.
import {
  AutoScalingClient,
  paginateDescribeAutoScalingGroups,
  type AutoScalingGroup,
} from '@aws-sdk/client-auto-scaling';
import { EC2Client, paginateDescribeInstances } from '@aws-sdk/client-ec2';
import type { AutoScalingGroupSummary, AwsAccount, ListAsgsResponse } from '@cloud-ops/shared';
import { assumeAccessRole, type TempCredentials } from '../lib/aws.js';
import { listAccounts } from '../lib/db.js';
import { handle, json } from '../lib/http.js';
import { canSeeAccount } from '../lib/scope.js';
import { getCaller, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const { tenant, membership } = await resolveTenant(getCaller(event));
  const onlyAccount = event.queryStringParameters?.accountId;

  const accounts = (await listAccounts(tenant.tenantId)).filter(
    (a) => a.status === 'connected' && canSeeAccount(membership, a) && (!onlyAccount || a.accountId === onlyAccount),
  );

  const result: ListAsgsResponse = { asgs: [], errors: [] };

  await Promise.all(
    accounts.map(async (account) => {
      let credentials: TempCredentials;
      try {
        credentials = await assumeAccessRole(account.roleArn, tenant.externalId, tenant.tenantId);
      } catch (err) {
        result.errors.push({ accountId: account.accountId, message: (err as Error).message });
        return;
      }

      // TS: Promise.allSettled waits for all regions, even if some fail.
      const perRegion = await Promise.allSettled(
        account.regions.map((region) => listAsgsInRegion(account, region, credentials)),
      );
      perRegion.forEach((outcome, i) => {
        if (outcome.status === 'fulfilled') result.asgs.push(...outcome.value);
        else
          result.errors.push({
            accountId: account.accountId,
            region: account.regions[i],
            message: (outcome.reason as Error).message,
          });
      });
    }),
  );

  result.asgs.sort((a, b) => a.accountId.localeCompare(b.accountId) || a.asgName.localeCompare(b.asgName));
  return json(200, result);
});

async function listAsgsInRegion(
  account: AwsAccount,
  region: string,
  credentials: TempCredentials,
): Promise<AutoScalingGroupSummary[]> {
  const autoscaling = new AutoScalingClient({ region, credentials });
  const groups: AutoScalingGroup[] = [];
  for await (const page of paginateDescribeAutoScalingGroups({ client: autoscaling }, {})) {
    groups.push(...(page.AutoScalingGroups ?? []));
  }

  const spotIds = await findSpotInstances(region, credentials, groups);
  const now = new Date().toISOString();

  return groups.map((g) => {
    const instances = g.Instances ?? [];
    const spot = instances.filter((i) => i.InstanceId && spotIds.has(i.InstanceId)).length;
    const tags = Object.fromEntries((g.Tags ?? []).map((t) => [t.Key ?? '', t.Value ?? '']));
    return {
      accountId: account.accountId,
      region,
      asgName: g.AutoScalingGroupName ?? '',
      arn: g.AutoScalingGroupARN ?? '',
      capacity: { min: g.MinSize ?? 0, desired: g.DesiredCapacity ?? 0, max: g.MaxSize ?? 0 },
      inServiceInstances: instances.filter((i) => i.LifecycleState === 'InService').length,
      onDemandInstances: instances.length - spot,
      spotInstances: spot,
      instanceTypes: [...new Set(instances.map((i) => i.InstanceType).filter((t): t is string => !!t))],
      managedByCloudOps: tags.CloudOpsManaged === 'true',
      tags,
      lastSyncedAt: now,
    };
  });
}

/** ASG data doesn't say which instances are Spot, so ask EC2 (a filter, so terminated IDs don't error). */
async function findSpotInstances(
  region: string,
  credentials: TempCredentials,
  groups: AutoScalingGroup[],
): Promise<Set<string>> {
  const ids = groups.flatMap((g) => (g.Instances ?? []).map((i) => i.InstanceId).filter((id): id is string => !!id));
  const spot = new Set<string>();
  if (ids.length === 0) return spot;

  const ec2 = new EC2Client({ region, credentials });
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const pages = paginateDescribeInstances(
      { client: ec2 },
      { Filters: [{ Name: 'instance-id', Values: chunk }] },
    );
    for await (const page of pages) {
      for (const reservation of page.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          if (instance.InstanceLifecycle === 'spot' && instance.InstanceId) spot.add(instance.InstanceId);
        }
      }
    }
  }
  return spot;
}
