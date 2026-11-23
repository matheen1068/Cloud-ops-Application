// GET  /insights       latest insights (from the 6-hourly sweep)
// POST /insights/run   run the checks now for this workspace
import { getInsightsReport } from '../lib/db.js';
import { handle, HttpError, json } from '../lib/http.js';
import { computeInsights } from '../lib/insights.js';
import { getCaller, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const { tenant } = await resolveTenant(getCaller(event));
  switch (event.routeKey) {
    case 'GET /insights':
      return json(200, { report: (await getInsightsReport(tenant.tenantId)) ?? null });
    case 'POST /insights/run':
      return json(200, { report: await computeInsights(tenant) });
    default:
      throw new HttpError(404, 'Not found.');
  }
});
