// GET /accounts: list connected accounts.
// POST /accounts: connect an account (the customer already created CloudOpsAccessRole).
import { PLAN_LIMITS, type AwsAccount, type ConnectAccountRequest } from '@cloud-ops/shared';
import {
  accountIdFromRoleArn,
  accountIdOf,
  assumeAccessRole,
  REGION_PATTERN,
  ROLE_ARN_PATTERN,
} from '../lib/aws.js';
import { listAccounts, putAccount, writeAudit } from '../lib/db.js';
import { handle, HttpError, json, parseBody } from '../lib/http.js';
import { ADMIN_ROLES, getCaller, requireRole, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const caller = getCaller(event);
  const { tenant, membership } = await resolveTenant(caller);
  const existing = await listAccounts(tenant.tenantId);

  if (event.requestContext.http.method === 'GET') {
    return json(200, { accounts: existing });
  }

  // POST: connect
  requireRole(membership, ADMIN_ROLES);
  const req = parseBody<ConnectAccountRequest>(event);

  // 1. Validate the input
  if (typeof req.roleArn !== 'string' || !ROLE_ARN_PATTERN.test(req.roleArn)) {
    throw new HttpError(400, 'roleArn must look like arn:aws:iam::123456789012:role/CloudOpsAccessRole');
  }
  const alias = typeof req.alias === 'string' ? req.alias.trim() : '';
  if (alias.length < 1 || alias.length > 64) throw new HttpError(400, 'alias must be 1-64 characters.');

  const regions = req.regions?.length ? req.regions : [process.env.AWS_REGION ?? 'us-east-1'];
  const badRegion = regions.find((r) => typeof r !== 'string' || !REGION_PATTERN.test(r));
  if (badRegion !== undefined) throw new HttpError(400, `Unknown region: ${String(badRegion)}`);

  const accessLevel = req.accessLevel ?? 'Operate';
  if (accessLevel !== 'ReadOnly' && accessLevel !== 'Operate') {
    throw new HttpError(400, 'accessLevel must be ReadOnly or Operate.');
  }

  const accountId = accountIdFromRoleArn(req.roleArn)!;
  const isReconnect = existing.some((a) => a.accountId === accountId);

  // 2. Plan limit (reconnecting an existing account doesn't count)
  const limit = PLAN_LIMITS[tenant.plan].maxAwsAccounts;
  if (!isReconnect && limit !== null && existing.length >= limit) {
    throw new HttpError(403, `Your ${tenant.plan} plan allows ${limit} AWS accounts.`);
  }

  // 3. Prove the role works and really lives in that account
  const credentials = await assumeAccessRole(req.roleArn, tenant.externalId, tenant.tenantId);
  const realAccountId = await accountIdOf(credentials);
  if (realAccountId !== accountId) {
    throw new HttpError(400, 'The role answered from a different account than its ARN says.');
  }

  // 4. Save it
  const account: AwsAccount = {
    tenantId: tenant.tenantId,
    accountId,
    alias,
    clientId: req.clientId,
    roleArn: req.roleArn,
    accessLevel,
    connectionMethod: 'single-account',
    status: 'connected',
    regions: [...new Set(regions)],
    lastCheckedAt: new Date().toISOString(),
  };
  await putAccount(account);
  await writeAudit({
    tenantId: tenant.tenantId,
    actor: { userId: caller.userId, email: caller.email },
    action: 'account.connected',
    accountId,
    result: 'success',
    message: isReconnect ? 'Reconnected' : undefined,
  });

  return json(isReconnect ? 200 : 201, { account });
});
