// GET /plan                              usage of the active workspace against its plan (any member)
// GET /platform/tenants                  every workspace (platform operator only)
// PUT /platform/tenants/{tenantId}       change a workspace's plan: { plan }
import type { PlanId } from '@cloud-ops/shared';
import { handle, HttpError, json, parseBody } from '../lib/http.js';
import { platformTenants, requireOperator, setPlan, usageOf } from '../lib/plans.js';
import { getCaller, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const caller = getCaller(event);
  switch (event.routeKey) {
    case 'GET /plan': {
      const { tenant } = await resolveTenant(caller);
      return json(200, { usage: await usageOf(tenant) });
    }
    case 'GET /platform/tenants':
      requireOperator(caller);
      return json(200, { tenants: await platformTenants() });
    case 'PUT /platform/tenants/{tenantId}': {
      const { plan } = parseBody<{ plan: PlanId }>(event);
      return json(200, { tenant: await setPlan(caller, event.pathParameters?.tenantId ?? '', plan) });
    }
    default:
      throw new HttpError(404, 'Not found.');
  }
});
