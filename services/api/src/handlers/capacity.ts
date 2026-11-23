// PUT /asgs/capacity: "scale now". Changes min/desired/max on one ASG and writes an audit entry.
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import { validateCapacity, type CapacityChangeRequest, type CapacitySettings } from '@cloud-ops/shared';
import { assumeAccessRole, REGION_PATTERN } from '../lib/aws.js';
import { getAccount, writeAudit } from '../lib/db.js';
import { handle, HttpError, json, parseBody } from '../lib/http.js';
import { getCaller, OPERATOR_ROLES, requireRole, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const caller = getCaller(event);
  const { tenant, membership } = await resolveTenant(caller);
  requireRole(membership, OPERATOR_ROLES);

  const req = parseBody<CapacityChangeRequest>(event);
  const { asg, capacity } = req;
  if (!asg?.accountId || !asg.asgName || !REGION_PATTERN.test(asg.region ?? '')) {
    throw new HttpError(400, 'asg must include accountId, region and asgName.');
  }
  const invalid = capacity ? validateCapacity(capacity) : 'capacity is required.';
  if (invalid) throw new HttpError(400, invalid);

  const account = await getAccount(tenant.tenantId, asg.accountId);
  if (!account || account.status !== 'connected') throw new HttpError(404, 'That account is not connected.');
  if (account.accessLevel !== 'Operate') {
    throw new HttpError(403, 'This account is connected read-only. Redeploy the role with AccessLevel=Operate.');
  }

  const credentials = await assumeAccessRole(account.roleArn, tenant.externalId, tenant.tenantId);
  const autoscaling = new AutoScalingClient({ region: asg.region, credentials });

  const found = await autoscaling.send(
    new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asg.asgName] }),
  );
  const group = found.AutoScalingGroups?.[0];
  if (!group) throw new HttpError(404, `ASG ${asg.asgName} not found in ${asg.region}.`);

  const before: CapacitySettings = {
    min: group.MinSize ?? 0,
    desired: group.DesiredCapacity ?? 0,
    max: group.MaxSize ?? 0,
  };
  const actor = { userId: caller.userId, email: caller.email };

  try {
    await autoscaling.send(
      new UpdateAutoScalingGroupCommand({
        AutoScalingGroupName: asg.asgName,
        MinSize: capacity.min,
        DesiredCapacity: capacity.desired,
        MaxSize: capacity.max,
      }),
    );
  } catch (err) {
    const message = (err as Error).message;
    await writeAudit({
      tenantId: tenant.tenantId, actor, action: 'asg.capacity-changed', asg,
      before, after: capacity, result: 'failure', message,
    });
    if ((err as Error).name === 'AccessDenied' || /not authorized/i.test(message)) {
      throw new HttpError(403, 'The role was not allowed to scale this ASG. If the role is tag-restricted, tag the ASG CloudOpsManaged=true.');
    }
    throw new HttpError(502, `AWS rejected the change: ${message}`);
  }

  await writeAudit({
    tenantId: tenant.tenantId, actor, action: 'asg.capacity-changed', asg,
    before, after: capacity, result: 'success', message: req.reason,
  });
  return json(200, { asg, before, after: capacity });
});
