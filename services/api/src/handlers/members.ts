// GET    /members                      team and pending invites
// POST   /members/invites              invite someone by email (owners and admins)
// DELETE /members/invites/{inviteId}   revoke an invite
// PUT    /members/{userId}             change role and client access: { role?, clientIds? }
// DELETE /members/{userId}             remove someone (or yourself: leave the workspace)
// POST   /invites/{inviteId}/accept    join a workspace you were invited to
// POST   /invites/{inviteId}/decline
import type { CreateInviteRequest, UpdateMemberRequest } from '@cloud-ops/shared';
import { handle, HttpError, json, parseBody } from '../lib/http.js';
import {
  acceptInviteById,
  createInvite,
  declineInvite,
  removeMember,
  revokeInvite,
  teamView,
  updateMember,
} from '../lib/team.js';
import { getCaller, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const caller = getCaller(event);
  const p = event.pathParameters ?? {};

  // Invite responses don't depend on the active workspace.
  switch (event.routeKey) {
    case 'POST /invites/{inviteId}/accept': {
      const membership = await acceptInviteById(caller, p.inviteId ?? '');
      return json(200, { tenantId: membership.tenantId, role: membership.role });
    }
    case 'POST /invites/{inviteId}/decline':
      await declineInvite(caller, p.inviteId ?? '');
      return json(200, { declined: p.inviteId });
  }

  const { tenant, membership } = await resolveTenant(caller);
  switch (event.routeKey) {
    case 'GET /members':
      return json(200, await teamView(tenant, membership));
    case 'POST /members/invites':
      return json(201, await createInvite(tenant, caller, membership, parseBody<CreateInviteRequest>(event)));
    case 'DELETE /members/invites/{inviteId}':
      await revokeInvite(tenant, caller, membership, p.inviteId ?? '');
      return json(200, { revoked: p.inviteId });
    case 'PUT /members/{userId}':
      return json(200, { member: await updateMember(tenant, caller, membership, p.userId ?? '', parseBody<UpdateMemberRequest>(event)) });
    case 'DELETE /members/{userId}':
      await removeMember(tenant, caller, membership, p.userId ?? '');
      return json(200, { removed: p.userId });
    default:
      throw new HttpError(404, 'Not found.');
  }
});
