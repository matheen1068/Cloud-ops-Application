// GET  /accounts                         connected accounts (scoped users see their clients' only)
// POST /accounts                         connect one account (the customer already created CloudOpsAccessRole)
// PUT  /accounts/{accountId}             rename, regions, approvals, client (admins)
// POST /accounts/{accountId}/discover    list the organization's accounts from a management account (admins)
// POST /accounts/bulk                    connect several discovered accounts at once (admins)
import {
  PLAN_LIMITS,
  type BulkConnectRequest,
  type BulkConnectResponse,
  type ConnectAccountRequest,
  type UpdateAccountRequest,
} from '@cloud-ops/shared';
import { assertClient, cleanAccessLevel, cleanRegions, connectAccount } from '../lib/accounts.js';
import { accountIdFromRoleArn, REGION_PATTERN, ROLE_ARN_PATTERN } from '../lib/aws.js';
import { requireClientGroups } from '../lib/clients.js';
import { getAccount, listAccounts, putAccount, writeAudit } from '../lib/db.js';
import { handle, HttpError, json, parseBody } from '../lib/http.js';
import { discoverOrganization, mapLimit, memberRoleArn } from '../lib/org.js';
import { canSeeAccount } from '../lib/scope.js';
import { ADMIN_ROLES, getCaller, requireRole, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const caller = getCaller(event);
  const { tenant, membership } = await resolveTenant(caller);
  const existing = await listAccounts(tenant.tenantId);
  const method = event.requestContext.http.method;
  const limit = PLAN_LIMITS[tenant.plan].maxAwsAccounts;

  if (method === 'GET') {
    return json(200, { accounts: existing.filter((a) => canSeeAccount(membership, a)) });
  }
  requireRole(membership, ADMIN_ROLES);

  if (event.routeKey === 'POST /accounts/{accountId}/discover') {
    const management = existing.find((a) => a.accountId === event.pathParameters?.accountId && a.status === 'connected');
    if (!management) throw new HttpError(404, 'That account is not connected.');
    return json(200, await discoverOrganization(tenant, management, existing));
  }

  if (event.routeKey === 'POST /accounts/bulk') {
    const req = parseBody<BulkConnectRequest>(event);
    if (!Array.isArray(req.accounts) || req.accounts.length < 1 || req.accounts.length > 50) {
      throw new HttpError(400, 'Send 1-50 accounts.');
    }
    const management = existing.find((a) => a.connectionMethod === 'single-account' && a.status === 'connected');
    const regions = cleanRegions(req.regions);
    const accessLevel = cleanAccessLevel(req.accessLevel);
    const known = new Set(existing.map((a) => a.accountId));
    const newCount = new Set(req.accounts.map((a) => a.accountId).filter((id) => !known.has(id))).size;
    if (limit !== null && existing.length + newCount > limit) {
      throw new HttpError(403, `Your ${tenant.plan} plan allows ${limit} AWS accounts (${existing.length} connected).`);
    }

    const result: BulkConnectResponse = { connected: [], failed: [] };
    // 5 at a time keeps 50 accounts well inside API Gateway's 30-second limit.
    await mapLimit(req.accounts, 5, async (item) => {
      try {
        if (typeof item.accountId !== 'string' || !/^\d{12}$/.test(item.accountId)) throw new HttpError(400, 'Invalid account id.');
        await assertClient(tenant.tenantId, item.clientId);
        const roleArn = memberRoleArn(management?.roleArn ?? 'arn:aws:', item.accountId);
        const { account } = await connectAccount(
          tenant,
          caller,
          { roleArn, alias: String(item.alias ?? item.accountId), regions, accessLevel, connectionMethod: 'organization', clientId: item.clientId },
          existing,
        );
        result.connected.push(account);
      } catch (err) {
        result.failed.push({ accountId: String(item.accountId), message: (err as Error).message });
      }
    });
    result.connected.sort((a, b) => a.alias.localeCompare(b.alias));
    return json(200, result);
  }

  if (method === 'PUT') {
    const account = await getAccount(tenant.tenantId, event.pathParameters?.accountId ?? '');
    if (!account) throw new HttpError(404, 'That account is not connected.');
    const req = parseBody<UpdateAccountRequest>(event);
    const changes: string[] = [];
    if (req.alias !== undefined) {
      const alias = typeof req.alias === 'string' ? req.alias.trim() : '';
      if (alias.length < 1 || alias.length > 64) throw new HttpError(400, 'alias must be 1-64 characters.');
      changes.push(`alias "${account.alias}" → "${alias}"`);
      account.alias = alias;
    }
    if (req.regions !== undefined) {
      if (!Array.isArray(req.regions) || req.regions.length === 0 || req.regions.some((r) => typeof r !== 'string' || !REGION_PATTERN.test(r))) {
        throw new HttpError(400, 'regions must be a non-empty list of region names.');
      }
      account.regions = [...new Set(req.regions)];
      changes.push(`regions ${account.regions.join(', ')}`);
    }
    if (req.requireApproval !== undefined) {
      if (typeof req.requireApproval !== 'boolean') throw new HttpError(400, 'requireApproval must be true or false.');
      account.requireApproval = req.requireApproval || undefined;
      changes.push(req.requireApproval ? 'approvals required' : 'approvals off');
    }
    if (req.clientId !== undefined) {
      if (req.clientId !== null) {
        requireClientGroups(tenant);
        await assertClient(tenant.tenantId, req.clientId);
      }
      account.clientId = req.clientId ?? undefined;
      changes.push(req.clientId ? 'assigned to a client' : 'removed from client');
    }
    await putAccount(account);
    await writeAudit({
      tenantId: tenant.tenantId, actor: { userId: caller.userId, email: caller.email },
      action: 'account.updated', accountId: account.accountId, result: 'success', message: changes.join(', '),
    });
    return json(200, { account });
  }

  // POST /accounts: connect one
  const req = parseBody<ConnectAccountRequest>(event);
  if (typeof req.roleArn !== 'string' || !ROLE_ARN_PATTERN.test(req.roleArn)) {
    throw new HttpError(400, 'roleArn must look like arn:aws:iam::123456789012:role/CloudOpsAccessRole');
  }
  if (typeof req.alias !== 'string') throw new HttpError(400, 'alias must be 1-64 characters.');
  const regions = cleanRegions(req.regions);
  const accessLevel = cleanAccessLevel(req.accessLevel);
  await assertClient(tenant.tenantId, req.clientId);

  const isReconnect = existing.some((a) => a.accountId === accountIdFromRoleArn(req.roleArn));
  if (!isReconnect && limit !== null && existing.length >= limit) {
    throw new HttpError(403, `Your ${tenant.plan} plan allows ${limit} AWS accounts.`);
  }
  const { account, reconnected } = await connectAccount(
    tenant,
    caller,
    { roleArn: req.roleArn, alias: req.alias, regions, accessLevel, connectionMethod: 'single-account', clientId: req.clientId },
    existing,
  );
  return json(reconnected ? 200 : 201, { account });
});
