// GET    /schedules                 list
// POST   /schedules                 create (off-hours schedule)
// DELETE /schedules/{scheduleId}    delete (switches ASGs back on first if they're off)
import type { CreateScheduleRequest } from '@cloud-ops/shared';
import { approvalGate, describeSchedule } from '../lib/approvals.js';
import { getSchedule, listSchedules } from '../lib/db.js';
import { assertAccountsVisible, filterByAccounts, visibleAccountIds } from '../lib/scope.js';
import { handle, HttpError, json, parseBody } from '../lib/http.js';
import { createSchedule, deleteSchedule } from '../lib/schedules.js';
import { getCaller, OPERATOR_ROLES, requireRole, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const caller = getCaller(event);
  const { tenant, membership } = await resolveTenant(caller);
  const visible = await visibleAccountIds(tenant.tenantId, membership);
  const accountsOf = (s: { targets: { asg: { accountId: string } }[] }) => s.targets.map((t) => t.asg.accountId);

  switch (event.routeKey) {
    case 'GET /schedules': {
      const schedules = filterByAccounts(await listSchedules(tenant.tenantId), visible, accountsOf);
      schedules.sort((a, b) => a.name.localeCompare(b.name));
      return json(200, { schedules });
    }
    case 'POST /schedules': {
      requireRole(membership, OPERATOR_ROLES);
      const req = parseBody<CreateScheduleRequest>(event);
      if (Array.isArray(req.asgs)) await assertAccountsVisible(tenant.tenantId, membership, req.asgs.map((a) => a?.accountId));
      const gate = approvalGate(tenant, caller, 'schedule', req, (accounts) => describeSchedule(req, accounts));
      const created = await createSchedule(tenant, caller, req, { gate });
      return json(201, { schedule: created });
    }
    case 'DELETE /schedules/{scheduleId}': {
      requireRole(membership, OPERATOR_ROLES);
      const id = event.pathParameters?.scheduleId;
      const found = id ? await getSchedule(tenant.tenantId, id) : undefined;
      if (!id || !found || filterByAccounts([found], visible, accountsOf).length === 0) throw new HttpError(404, 'Schedule not found.');
      await deleteSchedule(tenant, caller, id);
      return json(200, { deleted: id });
    }
    default:
      throw new HttpError(404, 'Not found.');
  }
});
