// Small helpers shared by Scale Now, scale events and schedules.
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  refLabel,
  refProblem,
  validateCapacity,
  type AsgRef,
  type AwsAccount,
  type CapacityChangeRequest,
  type CapacitySettings,
  type Tenant,
  type TimelineEntry,
} from '@cloud-ops/shared';
import { assumeAccessRole, REGION_PATTERN, type TempCredentials } from './aws.js';
import { getAccount, writeAudit } from './db.js';
import { ecsClients, readEcs, writeEcs } from './ecs.js';
import { HttpError } from './http.js';
import type { Caller } from './tenant.js';

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

  /** Current min/desired/max of an ASG or ECS service. */
  async read(account: AwsAccount, ref: AsgRef): Promise<CapacitySettings> {
    if (ref.kind === 'ecs') return readEcs(ecsClients(ref.region, await this.credentials(account)), ref.cluster!, ref.asgName);
    return readCapacity(await this.autoscaling(account, ref), ref.asgName);
  }

  async write(account: AwsAccount, ref: AsgRef, c: CapacitySettings): Promise<void> {
    if (ref.kind === 'ecs') return writeEcs(ecsClients(ref.region, await this.credentials(account)), ref.cluster!, ref.asgName, c);
    return writeCapacity(await this.autoscaling(account, ref), ref.asgName, c);
  }
}

export function entry(level: TimelineEntry['level'], message: string): TimelineEntry {
  return { at: new Date().toISOString(), level, message };
}

export const fmt = (c: CapacitySettings) => `${c.min}/${c.desired}/${c.max}`;

// ---------------------------------------------------------------------------
// Scale Now (PUT /asgs/capacity), also run when an approval is granted
// ---------------------------------------------------------------------------

export function validateCapacityRequest(req: CapacityChangeRequest): void {
  const { asg, capacity } = req ?? ({} as CapacityChangeRequest);
  if (!asg?.accountId || !asg.asgName || !REGION_PATTERN.test(asg.region ?? '')) {
    throw new HttpError(400, 'asg must include accountId, region and asgName.');
  }
  const invalid = refProblem(asg) ?? (capacity ? validateCapacity(capacity) : 'capacity is required.');
  if (invalid) throw new HttpError(400, invalid);
}

/** Like operableAccount, with the status codes Scale Now has always returned. */
export async function capacityAccount(tenantId: string, accountId: string): Promise<AwsAccount> {
  const account = await getAccount(tenantId, accountId);
  if (!account || account.status !== 'connected') throw new HttpError(404, 'That account is not connected.');
  if (account.accessLevel !== 'Operate') {
    throw new HttpError(403, 'This account is connected read-only. Redeploy the role with AccessLevel=Operate.');
  }
  return account;
}

export async function applyCapacityChange(
  tenant: Tenant,
  account: AwsAccount,
  actor: Caller,
  req: CapacityChangeRequest,
  message = req.reason,
): Promise<{ asg: AsgRef; before: CapacitySettings; after: CapacitySettings }> {
  const { asg, capacity } = req;
  const pool = new ClientPool(tenant);
  const what = asg.kind === 'ecs' ? 'ECS service' : 'ASG';

  let before: CapacitySettings;
  try {
    before = await pool.read(account, asg);
  } catch (err) {
    if (/AccessDenied|not authorized/i.test(`${(err as Error).name} ${(err as Error).message}`)) {
      throw new HttpError(403, `The role can't read this ${what}. ${asg.kind === 'ecs' ? 'Update the access role to the latest onboarding template (adds ECS permissions).' : ''}`.trim());
    }
    throw new HttpError(404, `${what} ${refLabel(asg)} not found in ${asg.region}.`);
  }

  const audit = { tenantId: tenant.tenantId, actor: { userId: actor.userId, email: actor.email }, action: 'asg.capacity-changed' as const, asg, before, after: capacity };
  try {
    await pool.write(account, asg, capacity);
  } catch (err) {
    const msg = (err as Error).message;
    await writeAudit({ ...audit, result: 'failure', message: msg });
    if (/AccessDenied/.test((err as Error).name) || /not authorized/i.test(msg)) {
      throw new HttpError(403, `The role was not allowed to scale this ${what}. If the role is tag-restricted, tag it CloudOpsManaged=true${asg.kind === 'ecs' ? ' (the service, and its auto scaling target if it has one)' : ''}.`);
    }
    throw new HttpError(502, `AWS rejected the change: ${msg}`);
  }
  await writeAudit({ ...audit, result: 'success', message });
  return { asg, before, after: capacity };
}
