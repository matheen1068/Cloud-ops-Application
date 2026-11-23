// GET  /scale-events                     list (newest first)
// POST /scale-events                     create and schedule
// POST /scale-events/{eventId}/cancel    cancel a scheduled event, or end an active one now
import type { CreateScaleEventRequest } from '@cloud-ops/shared';
import { cancelEvent, createEvent } from '../lib/events.js';
import { listEvents } from '../lib/db.js';
import { handle, HttpError, json, parseBody } from '../lib/http.js';
import { getCaller, OPERATOR_ROLES, requireRole, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const caller = getCaller(event);
  const { tenant, membership } = await resolveTenant(caller);

  switch (event.routeKey) {
    case 'GET /scale-events': {
      const events = await listEvents(tenant.tenantId);
      events.sort((a, b) => b.startsAt.localeCompare(a.startsAt));
      return json(200, { events });
    }
    case 'POST /scale-events': {
      requireRole(membership, OPERATOR_ROLES);
      const created = await createEvent(tenant, caller, parseBody<CreateScaleEventRequest>(event));
      return json(201, { event: created });
    }
    case 'POST /scale-events/{eventId}/cancel': {
      requireRole(membership, OPERATOR_ROLES);
      const id = event.pathParameters?.eventId;
      if (!id) throw new HttpError(400, 'eventId is required.');
      return json(200, { event: await cancelEvent(tenant, caller, id) });
    }
    default:
      throw new HttpError(404, 'Not found.');
  }
});
