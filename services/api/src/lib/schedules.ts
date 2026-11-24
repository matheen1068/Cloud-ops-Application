/**
 * Recurring schedules: switch ASGs off outside working hours and back on, restoring
 * the capacity they had when they were switched off. Fired by EventBridge Scheduler
 * in the schedule's own timezone.
 */
import { randomUUID } from 'node:crypto';
import {
  asgKey,
  refLabel,
  refProblem,
  WEEKDAYS,
  type CreateScheduleRequest,
  type ScaleSchedule,
  type Tenant,
} from '@cloud-ops/shared';
import { REGION_PATTERN } from './aws.js';
import { ClientPool, entry, fmt, operableAccount } from './capacity.js';
import {
  deleteScheduleItem,
  getAccount,
  getSchedule,
  getTenant,
  listEvents,
  listSchedules,
  putSchedule,
  writeAudit,
} from './db.js';
import { HttpError } from './http.js';
import { notify } from './notify.js';
import { cronAt, scheduleRecurring, unschedule } from './scheduler.js';
import type { Gate } from './approvals.js';
import type { Caller } from './tenant.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const offName = (id: string) => `sch-${id}-off`;
export const onName = (id: string) => `sch-${id}-on`;

function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** One notification per run when some ASGs couldn't be switched. */
async function reportErrors(schedule: ScaleSchedule, phase: 'off' | 'on'): Promise<void> {
  const failed = schedule.targets.filter((t) => t.state === 'error');
  if (failed.length === 0) return;
  await notify(schedule.tenantId, {
    kind: 'failure',
    level: 'warn',
    title: `Schedule "${schedule.name}": ${failed.length} ASG(s) could not switch ${phase}`,
    lines: failed.map((t) => `${t.asg.asgName} (${t.asg.accountId}, ${t.asg.region}): ${t.message}`),
    incident: {
      id: `cloudops-${schedule.scheduleId}-${phase}-${new Date().toISOString().slice(0, 10)}`,
      priority: 'MEDIUM',
      service: 'Cloud-Ops schedule',
    },
  });
}

/** Keeps only the last 50 timeline entries so recurring schedules don't grow forever. */
function trim(schedule: ScaleSchedule): void {
  if (schedule.timeline.length > 50) schedule.timeline = schedule.timeline.slice(-50);
}

export async function createSchedule(
  tenant: Tenant,
  caller: Caller,
  req: CreateScheduleRequest,
  opts: { gate?: Gate } = {},
): Promise<ScaleSchedule> {
  const name = typeof req.name === 'string' ? req.name.trim() : '';
  if (name.length < 1 || name.length > 80) throw new HttpError(400, 'name must be 1-80 characters.');
  if (typeof req.timezone !== 'string' || !isTimezone(req.timezone)) throw new HttpError(400, 'Unknown timezone.');
  const days = [...new Set(req.days ?? [])];
  if (days.length === 0 || days.some((d) => !WEEKDAYS.includes(d))) throw new HttpError(400, 'Pick at least one valid day.');
  if (!HHMM.test(req.onAt ?? '') || !HHMM.test(req.offAt ?? '')) throw new HttpError(400, 'Times must be HH:MM.');
  if (req.offAt <= req.onAt) throw new HttpError(400, 'The off time must be later than the on time on the same day.');
  if (!Array.isArray(req.asgs) || req.asgs.length < 1 || req.asgs.length > 50) throw new HttpError(400, 'A schedule needs 1-50 ASGs.');

  const keys = new Set<string>();
  for (const asg of req.asgs) {
    if (!asg?.accountId || !asg.asgName || !REGION_PATTERN.test(asg.region ?? '')) {
      throw new HttpError(400, 'Each ASG needs accountId, region and asgName.');
    }
    const refIssue = refProblem(asg);
    if (refIssue) throw new HttpError(400, refIssue);
    keys.add(asgKey(asg));
    await operableAccount(tenant.tenantId, asg.accountId);
  }
  for (const other of await listSchedules(tenant.tenantId)) {
    const clash = other.targets.find((t) => keys.has(asgKey(t.asg)));
    if (clash) throw new HttpError(409, `${clash.asg.asgName} is already in schedule "${other.name}".`);
  }
  await opts.gate?.(req.asgs.map((a) => a.accountId));

  // Keep days in calendar order for readable cron expressions.
  const orderedDays = WEEKDAYS.filter((d) => days.includes(d));
  const schedule: ScaleSchedule = {
    tenantId: tenant.tenantId,
    scheduleId: randomUUID(),
    name,
    targets: req.asgs.map((asg) => ({ asg, state: 'on' as const })),
    timezone: req.timezone,
    days: orderedDays,
    onAt: req.onAt,
    offAt: req.offAt,
    timeline: [entry('info', `Created by ${caller.email}. First switch-off at the next ${req.offAt} (${req.timezone}).`)],
    createdBy: caller.email,
    createdAt: new Date().toISOString(),
  };
  await putSchedule(schedule);

  const payload = { kind: 'schedule' as const, tenantId: tenant.tenantId, id: schedule.scheduleId };
  try {
    await scheduleRecurring(offName(schedule.scheduleId), cronAt(req.offAt, orderedDays), req.timezone, { ...payload, phase: 'off' });
    await scheduleRecurring(onName(schedule.scheduleId), cronAt(req.onAt, orderedDays), req.timezone, { ...payload, phase: 'on' });
  } catch (err) {
    await unschedule(offName(schedule.scheduleId));
    await deleteScheduleItem(tenant.tenantId, schedule.scheduleId);
    throw new HttpError(502, `Could not create the schedule: ${(err as Error).message}`);
  }

  await writeAudit({
    tenantId: tenant.tenantId,
    actor: { userId: caller.userId, email: caller.email },
    action: 'schedule.created',
    result: 'success',
    message: `${name} (${schedule.targets.length} ASGs)`,
  });
  return schedule;
}

/** ASGs in an active scale event are left alone: the event owns their capacity. */
async function busyAsgs(tenantId: string): Promise<Set<string>> {
  const busy = new Set<string>();
  for (const e of await listEvents(tenantId)) {
    if (['scaling-up', 'active', 'scaling-down'].includes(e.status)) e.targets.forEach((t) => busy.add(asgKey(t.asg)));
  }
  return busy;
}

/** Switch off: remember current capacity, then set min and desired to 0 (max is kept). */
export async function switchOff(tenantId: string, scheduleId: string): Promise<void> {
  const tenant = await getTenant(tenantId);
  const schedule = await getSchedule(tenantId, scheduleId);
  if (!tenant || !schedule) return;
  const busy = await busyAsgs(tenantId);
  const pool = new ClientPool(tenant);
  let changed = 0;

  for (const t of schedule.targets) {
    if (t.state === 'off') continue; // already off (retry or manual)
    if (busy.has(asgKey(t.asg))) {
      schedule.timeline.push(entry('warn', `${refLabel(t.asg)}: skipped, it's in an active scale event.`));
      continue;
    }
    try {
      const account = await getAccount(tenantId, t.asg.accountId);
      if (!account || account.accessLevel !== 'Operate') throw new Error('account is not connected with Operate access');
      const current = await pool.read(account, t.asg);
      await pool.write(account, t.asg, { min: 0, desired: 0, max: current.max });
      t.baseline = current;
      t.state = 'off';
      t.message = undefined;
      changed++;
      schedule.timeline.push(entry('info', `${refLabel(t.asg)}: off (was ${fmt(current)})`));
    } catch (err) {
      t.state = 'error';
      t.message = (err as Error).message;
      schedule.timeline.push(entry('error', `${refLabel(t.asg)}: could not switch off: ${t.message}`));
    }
  }
  trim(schedule);
  await putSchedule(schedule);
  if (changed > 0) {
    await writeAudit({ tenantId, actor: 'system', action: 'schedule.switched-off', result: 'success', message: `${schedule.name}: ${changed} ASGs` });
  }
  await reportErrors(schedule, 'off');
}

/** Switch on: restore the capacity captured at switch-off. */
export async function switchOn(tenantId: string, scheduleId: string, schedule?: ScaleSchedule): Promise<void> {
  const tenant = await getTenant(tenantId);
  schedule ??= await getSchedule(tenantId, scheduleId);
  if (!tenant || !schedule) return;
  const busy = await busyAsgs(tenantId);
  const pool = new ClientPool(tenant);
  let changed = 0;

  for (const t of schedule.targets) {
    if (t.state !== 'off' || !t.baseline) continue;
    if (busy.has(asgKey(t.asg))) {
      schedule.timeline.push(entry('warn', `${refLabel(t.asg)}: left as is, it's in an active scale event.`));
      continue;
    }
    try {
      const account = await getAccount(tenantId, t.asg.accountId);
      if (!account) throw new Error('account was disconnected');
      await pool.write(account, t.asg, t.baseline);
      t.state = 'on';
      t.message = undefined;
      changed++;
      schedule.timeline.push(entry('info', `${refLabel(t.asg)}: on (${fmt(t.baseline)})`));
    } catch (err) {
      t.state = 'error';
      t.message = (err as Error).message;
      schedule.timeline.push(entry('error', `${refLabel(t.asg)}: could not switch on: ${t.message}`));
    }
  }
  trim(schedule);
  await putSchedule(schedule);
  if (changed > 0) {
    await writeAudit({ tenantId, actor: 'system', action: 'schedule.switched-on', result: 'success', message: `${schedule.name}: ${changed} ASGs` });
  }
  await reportErrors(schedule, 'on');
}

/** Deletes a schedule. ASGs that are currently off are switched back on first. */
export async function deleteSchedule(tenant: Tenant, caller: Caller, scheduleId: string): Promise<void> {
  const schedule = await getSchedule(tenant.tenantId, scheduleId);
  if (!schedule) throw new HttpError(404, 'Schedule not found.');
  await unschedule(offName(scheduleId));
  await unschedule(onName(scheduleId));
  if (schedule.targets.some((t) => t.state === 'off')) {
    await switchOn(tenant.tenantId, scheduleId, schedule);
  }
  await deleteScheduleItem(tenant.tenantId, scheduleId);
  await writeAudit({
    tenantId: tenant.tenantId,
    actor: { userId: caller.userId, email: caller.email },
    action: 'schedule.deleted',
    result: 'success',
    message: schedule.name,
  });
}
