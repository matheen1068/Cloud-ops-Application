// GET /audit?limit=50&cursor=...   activity history, newest first
import type { AuditPage } from '@cloud-ops/shared';
import { listAudit } from '../lib/db.js';
import { handle, json } from '../lib/http.js';
import { getCaller, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const { tenant } = await resolveTenant(getCaller(event));
  const limit = Math.min(100, Math.max(1, Number(event.queryStringParameters?.limit ?? 50) || 50));
  const cursor = event.queryStringParameters?.cursor;
  const page: AuditPage = await listAudit(tenant.tenantId, limit, cursor?.startsWith('AUDIT#') ? cursor : undefined);
  return json(200, page);
});
