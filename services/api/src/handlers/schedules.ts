// GET    /schedules                 list
// POST   /schedules                 create (off-hours schedule)
// DELETE /schedules/{scheduleId}    delete (switches ASGs back on first if they're off)
import type { CreateScheduleRequest } from '@cloud-ops/shared';
import { approvalGate, describeSchedule } from '../lib/approvals.js';
import { listSchedules } from '../lib/db.js';
import { handle, HttpError, json, parseBody } from '../lib/http.js';
import { createSchedule, deleteSchedule } from '../lib/schedules.js';
import { getCaller, OPERATOR_ROLES, requireRole, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const caller = getCaller(event);
  const { tenant, membership } = await resolveTenant(caller);

  switch (event.routeKey) {
    case 'GET /schedules': {
      const schedules = await listSchedules(tenant.tenantId);
      schedules.sort((a, b) => a.name.localeCompare(b.name));
      return json(200, { schedules });
    }
    case 'POST /schedules': {
      requireRole(membership, OPERATOR_ROLES);
      const req = parseBody<CreateScheduleRequest>(event);
      const gate = approvalGate(tenant, caller, 'schedule', req, (accounts) => describeSchedule(req, accounts));
      const created = await createSchedule(tenant, caller, req, { gate });
      return json(201, { schedule: created });
    }
    case 'DELETE /schedules/{scheduleId}': {
      requireRole(membership, OPERATOR_ROLES);
      const id = event.pathParameters?.scheduleId;
      if (!id) throw new HttpError(400, 'scheduleId is required.');
      await deleteSchedule(tenant, caller, id);
      return json(200, { deleted: id });
    }
    default:
      throw new HttpError(404, 'Not found.');
  }
});
