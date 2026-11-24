// GET  /me            who am I, which workspace, my other workspaces and pending invites,
//                     and (for admins) what to put in the onboarding template.
// POST /me/workspace  switch the active workspace: { tenantId }
import { PLAN_LIMITS, type MeResponse } from '@cloud-ops/shared';
import { requireEnv } from '../lib/db.js';
import { handle, HttpError, json, parseBody } from '../lib/http.js';
import { isOperator } from '../lib/plans.js';
import { pendingInvitesFor, switchWorkspace, workspacesFor } from '../lib/team.js';
import { ADMIN_ROLES, getCaller, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const caller = getCaller(event);

  if (event.routeKey === 'POST /me/workspace') {
    const { tenantId } = parseBody<{ tenantId?: string }>(event);
    if (typeof tenantId !== 'string' || !tenantId) throw new HttpError(400, 'tenantId is required.');
    await switchWorkspace(caller, tenantId);
  }

  const { tenant, membership } = await resolveTenant(caller);
  const workspaces = await workspacesFor(caller);

  const body: MeResponse = {
    user: { userId: caller.userId, email: caller.email, role: membership.role },
    tenant: {
      tenantId: tenant.tenantId,
      name: tenant.name,
      plan: tenant.plan,
      limits: PLAN_LIMITS[tenant.plan],
    },
    workspaces,
    invites: await pendingInvitesFor(caller, workspaces.map((w) => w.tenantId)),
    platformOperator: isOperator(caller) || undefined,
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
