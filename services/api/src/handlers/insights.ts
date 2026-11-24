// GET  /insights       latest insights (from the 6-hourly sweep)
// POST /insights/run   run the checks now for this workspace
import { getInsightsReport } from '../lib/db.js';
import { handle, HttpError, json } from '../lib/http.js';
import { computeInsights } from '../lib/insights.js';
import { visibleAccountIds } from '../lib/scope.js';
import type { InsightsReport } from '@cloud-ops/shared';
import { getCaller, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const { tenant, membership } = await resolveTenant(getCaller(event));
  const visible = await visibleAccountIds(tenant.tenantId, membership);
  const scoped = (r: InsightsReport | undefined) =>
    r && visible
      ? { ...r, insights: r.insights.filter((i) => visible.has(i.asg.accountId)), errors: r.errors.filter((e) => visible.has(e.accountId)) }
      : r ?? null;
  switch (event.routeKey) {
    case 'GET /insights':
      return json(200, { report: scoped(await getInsightsReport(tenant.tenantId)) });
    case 'POST /insights/run':
      return json(200, { report: scoped(await computeInsights(tenant)) });
    default:
      throw new HttpError(404, 'Not found.');
  }
});
