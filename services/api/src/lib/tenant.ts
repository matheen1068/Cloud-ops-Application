import type { Membership, Tenant, UserRole } from '@cloud-ops/shared';
import {
  createTenantForUser,
  deleteProfile,
  getActiveTenantId,
  getMembership,
  getTenant,
  listInvitesForEmail,
  listMembershipsForUser,
  setActiveTenantId,
} from './db.js';
import { HttpError, type ApiEvent } from './http.js';
import { acceptInvite } from './team.js';

export interface Caller {
  userId: string;
  email: string; // lower case
  /** Cognito confirmed the email (sign-up code). Required before an invite can be used. */
  emailVerified?: boolean;
}

/** Reads the signed-in user from the Cognito ID token (already verified by API Gateway). */
export function getCaller(event: ApiEvent): Caller {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const userId = claims.sub;
  const email = claims.email;
  if (typeof userId !== 'string' || typeof email !== 'string') {
    throw new HttpError(401, 'Sign in with a Cognito ID token.');
  }
  const verified = claims.email_verified;
  return { userId, email: email.toLowerCase(), emailVerified: verified === true || verified === 'true' };
}

/**
 * Finds the caller's active workspace.
 * - The workspace they last switched to, if they're still a member.
 * - Otherwise any workspace they belong to.
 * - A brand-new user with a pending invite joins the inviting workspace.
 * - Anyone else gets a free workspace of their own.
 */
export async function resolveTenant(caller: Caller): Promise<{ tenant: Tenant; membership: Membership }> {
  const activeId = await getActiveTenantId(caller.userId);
  let membership = activeId ? await getMembership(caller.userId, activeId) : undefined;

  if (!membership) {
    membership = (await listMembershipsForUser(caller.userId))[0];
    if (!membership && caller.emailVerified) {
      const [invite] = await listInvitesForEmail(caller.email);
      if (invite) membership = await acceptInvite(invite, caller);
    }
    if (!membership) {
      // A stale PROFILE (removed from their only workspace) would block creating a new one.
      if (activeId) await deleteProfile(caller.userId);
      await createTenantForUser(caller.userId, caller.email);
      membership = (await listMembershipsForUser(caller.userId))[0];
    } else if (membership.tenantId !== activeId) {
      await setActiveTenantId(caller.userId, membership.tenantId);
    }
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
