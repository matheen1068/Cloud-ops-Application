// GET /me: who am I, which workspace, and (for admins) what to put in the onboarding template.
import { PLAN_LIMITS, type MeResponse } from '@cloud-ops/shared';
import { requireEnv } from '../lib/db.js';
import { handle, json } from '../lib/http.js';
import { ADMIN_ROLES, getCaller, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const caller = getCaller(event);
  const { tenant, membership } = await resolveTenant(caller);

  const body: MeResponse = {
    user: { userId: caller.userId, email: caller.email, role: membership.role },
    tenant: {
      tenantId: tenant.tenantId,
      name: tenant.name,
      plan: tenant.plan,
      limits: PLAN_LIMITS[tenant.plan],
    },
    onboarding: ADMIN_ROLES.includes(membership.role)
      ? {
          platformAccountId: requireEnv('PLATFORM_ACCOUNT_ID'),
          platformRoleName: requireEnv('PLATFORM_ROLE_NAME'),
          accessRoleName: requireEnv('ACCESS_ROLE_NAME'),
          externalId: tenant.externalId,
        }
      : undefined,
  };
  return json(200, body);
});
