// GET    /clients              client groups with account counts (scoped users see theirs only)
// POST   /clients              create (admins, MSP plan): { name }
// PUT    /clients/{clientId}   rename: { name }
// DELETE /clients/{clientId}   delete (its accounts become unassigned)
import type { ClientRequest } from '@cloud-ops/shared';
import { clientViews, createClient, removeClient, renameClient } from '../lib/clients.js';
import { handle, HttpError, json, parseBody } from '../lib/http.js';
import { ADMIN_ROLES, getCaller, requireRole, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const caller = getCaller(event);
  const { tenant, membership } = await resolveTenant(caller);
  const id = event.pathParameters?.clientId ?? '';

  if (event.routeKey === 'GET /clients') return json(200, { clients: await clientViews(tenant, membership) });
  requireRole(membership, ADMIN_ROLES);
  switch (event.routeKey) {
    case 'POST /clients':
      return json(201, { client: await createClient(tenant, caller, parseBody<ClientRequest>(event)) });
    case 'PUT /clients/{clientId}':
      return json(200, { client: await renameClient(tenant, caller, id, parseBody<ClientRequest>(event)) });
    case 'DELETE /clients/{clientId}':
      await removeClient(tenant, caller, id);
      return json(200, { deleted: id });
    default:
      throw new HttpError(404, 'Not found.');
  }
});
