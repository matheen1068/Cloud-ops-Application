// Connecting AWS accounts: one at a time (POST /accounts) or in bulk after org discovery.
import type { AccessLevel, AwsAccount, ConnectionMethod, Tenant } from '@cloud-ops/shared';
import { accountIdFromRoleArn, accountIdOf, assumeAccessRole, REGION_PATTERN } from './aws.js';
import { listClients, putAccount, writeAudit } from './db.js';
import { HttpError } from './http.js';
import type { Caller } from './tenant.js';

export interface ConnectInput {
  roleArn: string;
  alias: string;
  regions: string[];
  accessLevel: AccessLevel;
  connectionMethod: ConnectionMethod;
  clientId?: string;
}

export function cleanRegions(regions: unknown): string[] {
  const list = Array.isArray(regions) && regions.length ? regions : [process.env.AWS_REGION ?? 'us-east-1'];
  const bad = list.find((r) => typeof r !== 'string' || !REGION_PATTERN.test(r));
  if (bad !== undefined) throw new HttpError(400, `Unknown region: ${String(bad)}`);
  return [...new Set(list as string[])];
}

export function cleanAccessLevel(level: unknown): AccessLevel {
  const value = level ?? 'Operate';
  if (value !== 'ReadOnly' && value !== 'Operate') throw new HttpError(400, 'accessLevel must be ReadOnly or Operate.');
  return value;
}

export async function assertClient(tenantId: string, clientId: string | undefined): Promise<void> {
  if (clientId && !(await listClients(tenantId)).some((c) => c.clientId === clientId)) {
    throw new HttpError(400, `Unknown client: ${clientId}`);
  }
}

/** Proves the role works and lives in the account its ARN names, then saves the account. */
export async function connectAccount(tenant: Tenant, caller: Caller, input: ConnectInput, existing: AwsAccount[]): Promise<{ account: AwsAccount; reconnected: boolean }> {
  const alias = input.alias.trim();
  if (alias.length < 1 || alias.length > 64) throw new HttpError(400, 'alias must be 1-64 characters.');
  const accountId = accountIdFromRoleArn(input.roleArn)!;
  const previous = existing.find((a) => a.accountId === accountId);

  const credentials = await assumeAccessRole(input.roleArn, tenant.externalId, tenant.tenantId);
  if ((await accountIdOf(credentials)) !== accountId) {
    throw new HttpError(400, 'The role answered from a different account than its ARN says.');
  }

  const account: AwsAccount = {
    tenantId: tenant.tenantId,
    accountId,
    alias,
    clientId: input.clientId ?? previous?.clientId,
    roleArn: input.roleArn,
    accessLevel: input.accessLevel,
    connectionMethod: input.connectionMethod,
    status: 'connected',
    regions: input.regions,
    // Reconnecting keeps the approval setting.
    requireApproval: previous?.requireApproval,
    lastCheckedAt: new Date().toISOString(),
  };
  await putAccount(account);
  await writeAudit({
    tenantId: tenant.tenantId,
    actor: { userId: caller.userId, email: caller.email },
    action: 'account.connected',
    accountId,
    result: 'success',
    message: [previous ? 'Reconnected' : undefined, input.connectionMethod === 'organization' ? 'via organization' : undefined].filter(Boolean).join(', ') || undefined,
  });
  return { account, reconnected: !!previous };
}
