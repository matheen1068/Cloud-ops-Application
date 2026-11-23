// Small helpers shared by Scale Now, scale events and schedules.
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import type { AsgRef, AwsAccount, CapacitySettings, Tenant, TimelineEntry } from '@cloud-ops/shared';
import { assumeAccessRole, type TempCredentials } from './aws.js';
import { getAccount } from './db.js';
import { HttpError } from './http.js';

export async function readCapacity(client: AutoScalingClient, asgName: string): Promise<CapacitySettings> {
  const res = await client.send(new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asgName] }));
  const g = res.AutoScalingGroups?.[0];
  if (!g) throw new Error(`ASG ${asgName} not found`);
  return { min: g.MinSize ?? 0, desired: g.DesiredCapacity ?? 0, max: g.MaxSize ?? 0 };
}

export async function writeCapacity(client: AutoScalingClient, asgName: string, c: CapacitySettings): Promise<void> {
  await client.send(
    new UpdateAutoScalingGroupCommand({
      AutoScalingGroupName: asgName,
      MinSize: c.min,
      DesiredCapacity: c.desired,
      MaxSize: c.max,
    }),
  );
}

/** Loads the account and checks Cloud-Ops may change capacity there. */
export async function operableAccount(tenantId: string, accountId: string): Promise<AwsAccount> {
  const account = await getAccount(tenantId, accountId);
  if (!account || account.status !== 'connected') throw new HttpError(400, `Account ${accountId} is not connected.`);
  if (account.accessLevel !== 'Operate') {
    throw new HttpError(400, `Account ${account.alias} is connected read-only, so Cloud-Ops can't scale it.`);
  }
  return account;
}

/** Assumes each account's role once per run and hands out AWS clients. */
export class ClientPool {
  private creds = new Map<string, Promise<TempCredentials>>();

  constructor(private readonly tenant: Tenant) {}

  credentials(account: AwsAccount): Promise<TempCredentials> {
    let pending = this.creds.get(account.accountId);
    if (!pending) {
      pending = assumeAccessRole(account.roleArn, this.tenant.externalId, this.tenant.tenantId);
      this.creds.set(account.accountId, pending);
    }
    return pending;
  }

  async autoscaling(account: AwsAccount, asg: AsgRef): Promise<AutoScalingClient> {
    return new AutoScalingClient({ region: asg.region, credentials: await this.credentials(account) });
  }
}

export function entry(level: TimelineEntry['level'], message: string): TimelineEntry {
  return { at: new Date().toISOString(), level, message };
}

export const fmt = (c: CapacitySettings) => `${c.min}/${c.desired}/${c.max}`;
