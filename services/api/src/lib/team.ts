/**
 * Team management: invites, roles, removing people, switching workspaces.
 *
 * Invites are matched by email. Cognito only signs someone in after they confirm their email
 * with a code, so a verified email claim proves they own that inbox.
 */
import { randomUUID } from 'node:crypto';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import {
  PLAN_LIMITS,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type Invite,
  type Member,
  type Membership,
  type PendingInvite,
  type TeamView,
  type Tenant,
  type UpdateMemberRequest,
  type UserRole,
  type WorkspaceRef,
} from '@cloud-ops/shared';
import {
  deleteMembership,
  getMembership,
  getTenant,
  listInvites,
  listInvitesForEmail,
  listMembers,
  listMembershipsForUser,
  putInvite,
  putMembership,
  setActiveTenantId,
  writeAudit,
} from './db.js';
import { validClientIds } from './clients.js';
import { HttpError } from './http.js';
import type { Caller } from './tenant.js';

const ROLES: UserRole[] = ['owner', 'admin', 'operator', 'viewer'];
const ADMINS: UserRole[] = ['owner', 'admin'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_DAYS = 7;
const ses = new SESv2Client({});

const actorOf = (c: Caller) => ({ userId: c.userId, email: c.email });
const isLive = (i: Invite) => i.status === 'pending' && new Date(i.expiresAt).getTime() > Date.now();

function requireAdmin(m: Membership): void {
  if (!ADMINS.includes(m.role)) throw new HttpError(403, `Your role (${m.role}) can't manage the team.`);
}

async function otherOwnerExists(tenantId: string, exceptUserId: string): Promise<boolean> {
  return (await listMembers(tenantId)).some((m) => m.role === 'owner' && m.userId !== exceptUserId);
}

export async function teamView(tenant: Tenant, membership: Membership): Promise<TeamView> {
  const members = await listMembers(tenant.tenantId);
  // Workspaces created before team support have no team-side item for their owner yet.
  if (!members.some((m) => m.userId === membership.userId)) {
    const self: Member = { ...membership };
    await putMembership(self);
    members.push(self);
  }
  members.sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.email.localeCompare(b.email));
  const invites = ADMINS.includes(membership.role) ? (await listInvites(tenant.tenantId)).filter(isLive) : [];
  return { members, invites, maxUsers: PLAN_LIMITS[tenant.plan].maxUsers };
}

export async function createInvite(
  tenant: Tenant,
  caller: Caller,
  membership: Membership,
  req: CreateInviteRequest,
): Promise<CreateInviteResponse> {
  requireAdmin(membership);
  const email = typeof req.email === 'string' ? req.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
  if (!ROLES.includes(req.role)) throw new HttpError(400, 'role must be owner, admin, operator or viewer.');
  if (req.role === 'owner' && membership.role !== 'owner') throw new HttpError(403, 'Only owners can invite owners.');
  let clientIds: string[] | undefined;
  if (req.clientIds !== undefined && req.clientIds !== null) {
    if (ADMINS.includes(req.role)) throw new HttpError(400, 'Owners and admins always see every client. Limit operators or viewers instead.');
    clientIds = await validClientIds(tenant, req.clientIds);
  }

  const { members, invites } = await teamView(tenant, membership);
  if (members.some((m) => m.email.toLowerCase() === email)) throw new HttpError(409, `${email} is already in this workspace.`);
  if (invites.some((i) => i.email === email)) throw new HttpError(409, `${email} already has a pending invite. Revoke it to send a new one.`);

  const max = PLAN_LIMITS[tenant.plan].maxUsers;
  if (max !== null && members.length + invites.length >= max) {
    throw new HttpError(403, `Your ${tenant.plan} plan allows ${max} ${max === 1 ? 'user' : 'users'}, including pending invites.`);
  }

  const now = new Date();
  const invite: Invite = {
    inviteId: randomUUID(),
    tenantId: tenant.tenantId,
    email,
    role: req.role,
    clientIds,
    invitedBy: actorOf(caller),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000).toISOString(),
    status: 'pending',
  };
  await putInvite(invite);
  await writeAudit({
    tenantId: tenant.tenantId, actor: actorOf(caller), action: 'member.invited',
    result: 'success', message: `${email} as ${req.role}`,
  });

  const link = `${process.env.WEB_URL ?? ''}/?invite=${invite.inviteId}`;
  const emailed = await sendInviteEmail(invite, tenant.name, link);
  return { invite, link, emailed };
}

async function sendInviteEmail(invite: Invite, workspace: string, link: string): Promise<boolean> {
  const from = process.env.SENDER_EMAIL;
  if (!from) return false;
  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [invite.email] },
        Content: {
          Simple: {
            Subject: { Data: `${invite.invitedBy.email} invited you to ${workspace} on Cloud-Ops` },
            Body: {
              Text: {
                Data: [
                  `${invite.invitedBy.email} invited you to join "${workspace}" on Cloud-Ops as ${invite.role}.`,
                  '',
                  `Open ${link} and sign up or sign in with ${invite.email}.`,
                  `The invite expires on ${new Date(invite.expiresAt).toUTCString()}.`,
                ].join('\n'),
              },
            },
          },
        },
      }),
    );
    return true;
  } catch (err) {
    console.error('Invite email failed', (err as Error).message);
    return false;
  }
}

export async function revokeInvite(tenant: Tenant, caller: Caller, membership: Membership, inviteId: string): Promise<void> {
  requireAdmin(membership);
  const invite = (await listInvites(tenant.tenantId)).find((i) => i.inviteId === inviteId);
  if (!invite || invite.status !== 'pending') throw new HttpError(404, 'No pending invite with that id.');
  await putInvite({ ...invite, status: 'revoked' });
  await writeAudit({
    tenantId: tenant.tenantId, actor: actorOf(caller), action: 'invite.revoked',
    result: 'success', message: invite.email,
  });
}

/** Adds the caller to the inviting workspace and makes it their active one. */
export async function acceptInvite(invite: Invite, caller: Caller): Promise<Membership> {
  if (!caller.emailVerified) throw new HttpError(403, 'Confirm your email address first.');
  if (invite.email !== caller.email) throw new HttpError(403, 'This invite was sent to a different email.');
  if (!isLive(invite)) throw new HttpError(410, 'This invite has expired or was revoked. Ask for a new one.');

  const existing = await getMembership(caller.userId, invite.tenantId);
  const membership: Member = existing ?? {
    tenantId: invite.tenantId,
    userId: caller.userId,
    email: caller.email,
    role: invite.role,
    clientIds: invite.clientIds,
    joinedAt: new Date().toISOString(),
  };
  if (!existing) await putMembership(membership);
  await putInvite({ ...invite, status: 'accepted' });
  await setActiveTenantId(caller.userId, invite.tenantId);
  await writeAudit({
    tenantId: invite.tenantId, actor: actorOf(caller), action: 'member.joined',
    result: 'success', message: `${caller.email} as ${membership.role}`,
  });
  return membership;
}

async function findMyInvite(caller: Caller, inviteId: string): Promise<Invite> {
  if (!caller.emailVerified) throw new HttpError(403, 'Confirm your email address first.');
  const invite = (await listInvitesForEmail(caller.email)).find((i) => i.inviteId === inviteId);
  if (!invite) throw new HttpError(404, 'No pending invite with that id for your email.');
  return invite;
}

export async function acceptInviteById(caller: Caller, inviteId: string): Promise<Membership> {
  return acceptInvite(await findMyInvite(caller, inviteId), caller);
}

export async function declineInvite(caller: Caller, inviteId: string): Promise<void> {
  const invite = await findMyInvite(caller, inviteId);
  await putInvite({ ...invite, status: 'declined' });
}

export async function updateMember(
  tenant: Tenant,
  caller: Caller,
  membership: Membership,
  userId: string,
  req: UpdateMemberRequest,
): Promise<Member> {
  requireAdmin(membership);
  const target = await getMembership(userId, tenant.tenantId);
  if (!target) throw new HttpError(404, 'That person is not in this workspace.');
  const role = req.role ?? target.role;
  if (!ROLES.includes(role)) throw new HttpError(400, 'role must be owner, admin, operator or viewer.');
  if ((role === 'owner' || target.role === 'owner') && membership.role !== 'owner') {
    throw new HttpError(403, 'Only owners can make or change owners.');
  }
  if (target.role === 'owner' && role !== 'owner' && !(await otherOwnerExists(tenant.tenantId, userId))) {
    throw new HttpError(409, 'A workspace needs at least one owner. Make someone else owner first.');
  }
  // Owners and admins always see every client; others can be limited.
  let clientIds = target.clientIds;
  if (ADMINS.includes(role)) {
    if (req.clientIds) throw new HttpError(400, 'Owners and admins always see every client. Limit operators or viewers instead.');
    clientIds = undefined;
  } else if (req.clientIds === null) {
    clientIds = undefined;
  } else if (req.clientIds !== undefined) {
    clientIds = await validClientIds(tenant, req.clientIds);
  }
  const updated: Member = { ...target, role, clientIds };
  await putMembership(updated);
  const scope = clientIds ? `${clientIds.length} client${clientIds.length === 1 ? '' : 's'}` : 'all clients';
  await writeAudit({
    tenantId: tenant.tenantId, actor: actorOf(caller), action: 'member.role-changed',
    result: 'success', message: `${target.email}: ${target.role} → ${role}, ${scope}`,
  });
  return updated;
}

/** Admins remove people; anyone can remove themselves (leave). */
export async function removeMember(tenant: Tenant, caller: Caller, membership: Membership, userId: string): Promise<void> {
  const leaving = userId === caller.userId;
  if (!leaving) requireAdmin(membership);
  const target = leaving ? membership : await getMembership(userId, tenant.tenantId);
  if (!target) throw new HttpError(404, 'That person is not in this workspace.');
  if (target.role === 'owner' && !leaving && membership.role !== 'owner') {
    throw new HttpError(403, 'Only owners can remove an owner.');
  }
  if (target.role === 'owner' && !(await otherOwnerExists(tenant.tenantId, userId))) {
    throw new HttpError(409, 'A workspace needs at least one owner. Make someone else owner first.');
  }
  await deleteMembership(tenant.tenantId, userId);
  await writeAudit({
    tenantId: tenant.tenantId, actor: actorOf(caller), action: 'member.removed',
    result: 'success', message: leaving ? `${target.email} left` : target.email,
  });
}

export async function switchWorkspace(caller: Caller, tenantId: string): Promise<void> {
  if (!(await getMembership(caller.userId, tenantId))) throw new HttpError(404, "You're not a member of that workspace.");
  await setActiveTenantId(caller.userId, tenantId);
}

export async function workspacesFor(caller: Caller): Promise<WorkspaceRef[]> {
  const memberships = await listMembershipsForUser(caller.userId);
  const refs = await Promise.all(
    memberships.map(async (m) => ({ tenantId: m.tenantId, name: (await getTenant(m.tenantId))?.name ?? 'Workspace', role: m.role })),
  );
  return refs.sort((a, b) => a.name.localeCompare(b.name));
}

export async function pendingInvitesFor(caller: Caller, memberOf: string[]): Promise<PendingInvite[]> {
  if (!caller.emailVerified) return [];
  const invites = (await listInvitesForEmail(caller.email)).filter((i) => isLive(i) && !memberOf.includes(i.tenantId));
  return Promise.all(
    invites.map(async (i) => ({
      inviteId: i.inviteId,
      tenantId: i.tenantId,
      tenantName: (await getTenant(i.tenantId))?.name ?? 'A workspace',
      role: i.role,
      invitedBy: i.invitedBy.email,
      expiresAt: i.expiresAt,
    })),
  );
}
