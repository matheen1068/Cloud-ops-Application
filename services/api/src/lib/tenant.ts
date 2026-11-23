import type { Membership, Tenant, UserRole } from '@cloud-ops/shared';
import { createTenantForUser, getMembershipForUser, getTenant } from './db.js';
import { HttpError, type ApiEvent } from './http.js';

export interface Caller {
  userId: string;
  email: string;
}

/** Reads the signed-in user from the Cognito ID token (already verified by API Gateway). */
export function getCaller(event: ApiEvent): Caller {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const userId = claims.sub;
  const email = claims.email;
  if (typeof userId !== 'string' || typeof email !== 'string') {
    throw new HttpError(401, 'Sign in with a Cognito ID token.');
  }
  return { userId, email };
}

/** Finds the caller's workspace, creating a free one on first sign-in. */
export async function resolveTenant(caller: Caller): Promise<{ tenant: Tenant; membership: Membership }> {
  let membership = await getMembershipForUser(caller.userId);
  if (!membership) {
    await createTenantForUser(caller.userId, caller.email);
    membership = await getMembershipForUser(caller.userId);
  }
  const tenant = membership && (await getTenant(membership.tenantId));
  if (!membership || !tenant) throw new HttpError(500, 'Workspace could not be loaded.');
  return { tenant, membership };
}

export const ADMIN_ROLES: UserRole[] = ['owner', 'admin'];
export const OPERATOR_ROLES: UserRole[] = ['owner', 'admin', 'operator'];

export function requireRole(membership: Membership, allowed: UserRole[]): void {
  if (!allowed.includes(membership.role)) {
    throw new HttpError(403, `Your role (${membership.role}) can't do this.`);
  }
}
