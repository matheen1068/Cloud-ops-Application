// GET  /scale-events                     list (newest first)
// POST /scale-events                     create and schedule
// POST /scale-events/{eventId}/cancel    cancel a scheduled event, or end an active one now
// POST /scale-events/{eventId}/investigate  send problems to the customer's AWS DevOps Agent
import type { CreateScaleEventRequest } from '@cloud-ops/shared';
import { approvalGate, describeEvent } from '../lib/approvals.js';
import { cancelEvent, createEvent, investigateEvent } from '../lib/events.js';
import { getEvent, listEvents } from '../lib/db.js';
import { assertAccountsVisible, filterByAccounts, visibleAccountIds } from '../lib/scope.js';
import { handle, HttpError, json, parseBody } from '../lib/http.js';
import { getCaller, OPERATOR_ROLES, requireRole, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const caller = getCaller(event);
  const { tenant, membership } = await resolveTenant(caller);
  const visible = await visibleAccountIds(tenant.tenantId, membership);
  const accountsOf = (e: { targets: { asg: { accountId: string } }[] }) => e.targets.map((t) => t.asg.accountId);
  const visibleEvent = async (id: string | undefined) => {
    const found = id ? await getEvent(tenant.tenantId, id) : undefined;
    if (!found || filterByAccounts([found], visible, accountsOf).length === 0) throw new HttpError(404, 'Event not found.');
    return found.eventId;
  };

  switch (event.routeKey) {
    case 'GET /scale-events': {
      const events = filterByAccounts(await listEvents(tenant.tenantId), visible, accountsOf);
      events.sort((a, b) => b.startsAt.localeCompare(a.startsAt));
      return json(200, { events });
    }
    case 'POST /scale-events': {
      requireRole(membership, OPERATOR_ROLES);
      const req = parseBody<CreateScaleEventRequest>(event);
      if (Array.isArray(req.targets)) await assertAccountsVisible(tenant.tenantId, membership, req.targets.map((t) => t?.asg?.accountId));
      const gate = approvalGate(tenant, caller, 'scale-event', req, (accounts) => describeEvent(req, accounts));
      const created = await createEvent(tenant, caller, req, { gate });
      return json(201, { event: created });
    }
    case 'POST /scale-events/{eventId}/cancel': {
      requireRole(membership, OPERATOR_ROLES);
      const id = await visibleEvent(event.pathParameters?.eventId);
      return json(200, { event: await cancelEvent(tenant, caller, id) });
    }
    case 'POST /scale-events/{eventId}/investigate': {
      requireRole(membership, OPERATOR_ROLES);
      const id = await visibleEvent(event.pathParameters?.eventId);
      await investigateEvent(tenant, caller, id);
      return json(200, { sent: true });
    }
    default:
      throw new HttpError(404, 'Not found.');
  }
});
