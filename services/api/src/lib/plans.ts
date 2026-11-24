/**
 * Plans. Customers see their usage against the plan limits. The platform operator
 * (emails in OPERATOR_EMAILS, set at deploy time) sees every workspace and changes plans,
 * until billing (Stripe or AWS Marketplace) does it automatically.
 */
import { PLAN_IDS, PLAN_LIMITS, type PlanId, type PlanUsage, type PlatformTenant, type Tenant } from '@cloud-ops/shared';
import { getTenant, listAccounts, listInvites, listMembers, listTenants, putTenant, writeAudit } from './db.js';
import { HttpError } from './http.js';
import type { Caller } from './tenant.js';

export function isOperator(caller: Caller): boolean {
  if (!caller.emailVerified) return false;
  const allowed = (process.env.OPERATOR_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(caller.email);
}

export function requireOperator(caller: Caller): void {
  if (!isOperator(caller)) throw new HttpError(403, 'Only the platform operator can do this.');
}

export async function usageOf(tenant: Tenant): Promise<PlanUsage> {
  const [accounts, members, invites] = await Promise.all([
    listAccounts(tenant.tenantId),
    listMembers(tenant.tenantId),
    listInvites(tenant.tenantId),
  ]);
  const pending = invites.filter((i) => i.status === 'pending' && new Date(i.expiresAt).getTime() > Date.now()).length;
  return {
    plan: tenant.plan,
    limits: PLAN_LIMITS[tenant.plan],
    accounts: accounts.length,
    // Workspaces from before team support may not have their owner on the team list yet.
    users: Math.max(1, members.length) + pending,
  };
}

export async function platformTenants(): Promise<PlatformTenant[]> {
  const tenants = (await listTenants()).slice(0, 500);
  const rows = await Promise.all(
    tenants.map(async (t) => {
      const [accounts, members] = await Promise.all([listAccounts(t.tenantId), listMembers(t.tenantId)]);
      return {
        tenantId: t.tenantId,
        name: t.name,
        plan: t.plan,
        createdAt: t.createdAt,
        owners: members.filter((m) => m.role === 'owner').map((m) => m.email),
        accounts: accounts.length,
        members: members.length,
      };
    }),
  );
  return rows.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/** Downgrades are allowed: nothing is removed, the workspace just can't add more past the new limits. */
export async function setPlan(caller: Caller, tenantId: string, plan: PlanId): Promise<Tenant> {
  requireOperator(caller);
  if (!PLAN_IDS.includes(plan)) throw new HttpError(400, `plan must be one of ${PLAN_IDS.join(', ')}.`);
  const tenant = await getTenant(tenantId);
  if (!tenant) throw new HttpError(404, 'Workspace not found.');
  const previous = tenant.plan;
  const updated = { ...tenant, plan };
  await putTenant(updated);
  await writeAudit({
    tenantId,
    actor: { userId: caller.userId, email: caller.email },
    action: 'plan.changed',
    result: 'success',
    message: `${previous} → ${plan} (by the platform operator)`,
  });
  return updated;
}
