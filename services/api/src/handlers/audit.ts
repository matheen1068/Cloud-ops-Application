// GET /audit?limit=50&cursor=...   activity history, newest first
import type { AuditPage } from '@cloud-ops/shared';
import { listAudit } from '../lib/db.js';
import { handle, json } from '../lib/http.js';
import { filterByAccounts, visibleAccountIds } from '../lib/scope.js';
import { getCaller, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const { tenant, membership } = await resolveTenant(getCaller(event));
  const limit = Math.min(100, Math.max(1, Number(event.queryStringParameters?.limit ?? 50) || 50));
  const cursor = event.queryStringParameters?.cursor;
  const page: AuditPage = await listAudit(tenant.tenantId, limit, cursor?.startsWith('AUDIT#') ? cursor : undefined);
  // Scoped users only see entries about their clients' accounts.
  const visible = await visibleAccountIds(tenant.tenantId, membership);
  page.entries = filterByAccounts(page.entries, visible, (e) => [e.asg?.accountId ?? e.accountId]);
  return json(200, page);
});
