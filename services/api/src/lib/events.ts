/**
 * Scale events: pre-scale before a known spike, hold, then scale back to the
 * capacity captured just before scale-up. Start/end are fired by EventBridge
 * Scheduler; every step is idempotent so scheduler retries are safe.
 */
import { randomUUID } from 'node:crypto';
import {
  asgKey,
  validateCapacity,
  type CreateScaleEventRequest,
  type ScaleEvent,
  type ScaleTarget,
  type Tenant,
} from '@cloud-ops/shared';
import { REGION_PATTERN } from './aws.js';
import { ClientPool, entry, fmt, operableAccount, readCapacity, writeCapacity } from './capacity.js';
import { getAccount, getEvent, getTenant, listEvents, putEvent, writeAudit } from './db.js';
import { HttpError } from './http.js';
import { checkReadiness } from './readiness.js';
import { scheduleOnce, unschedule } from './scheduler.js';
import type { Caller } from './tenant.js';

const ACTIVE: ScaleEvent['status'][] = ['scheduled', 'scaling-up', 'active', 'scaling-down'];
export const startName = (id: string) => `evt-${id}-start`;
export const endName = (id: string) => `evt-${id}-end`;

export function scaleUpAt(e: Pick<ScaleEvent, 'startsAt' | 'prescaleMinutes'>): Date {
  return new Date(new Date(e.startsAt).getTime() - e.prescaleMinutes * 60_000);
}

export async function createEvent(tenant: Tenant, caller: Caller, req: CreateScaleEventRequest): Promise<ScaleEvent> {
  // 1. Validate
  const name = typeof req.name === 'string' ? req.name.trim() : '';
  if (name.length < 1 || name.length > 80) throw new HttpError(400, 'name must be 1-80 characters.');
  const startsAt = new Date(req.startsAt);
  const endsAt = new Date(req.endsAt);
  if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime())) throw new HttpError(400, 'startsAt and endsAt must be ISO timestamps.');
  if (endsAt <= startsAt) throw new HttpError(400, 'The event must end after it starts.');
  if (endsAt.getTime() < Date.now() + 5 * 60_000) throw new HttpError(400, 'The event must end at least 5 minutes from now.');
  if (endsAt.getTime() - startsAt.getTime() > 14 * 24 * 3600_000) throw new HttpError(400, 'Events can last at most 14 days.');
  const prescaleMinutes = req.prescaleMinutes ?? 30;
  if (!Number.isInteger(prescaleMinutes) || prescaleMinutes < 0 || prescaleMinutes > 240) {
    throw new HttpError(400, 'prescaleMinutes must be 0-240.');
  }
  if (!Array.isArray(req.targets) || req.targets.length < 1 || req.targets.length > 20) {
    throw new HttpError(400, 'An event needs 1-20 ASGs.');
  }

  const seen = new Set<string>();
  for (const t of req.targets) {
    if (!t?.asg?.accountId || !t.asg.asgName || !REGION_PATTERN.test(t.asg.region ?? '')) {
      throw new HttpError(400, 'Each target needs accountId, region and asgName.');
    }
    const invalid = t.target ? validateCapacity(t.target) : 'target capacity is required.';
    if (invalid) throw new HttpError(400, `${t.asg.asgName}: ${invalid}`);
    if (seen.has(asgKey(t.asg))) throw new HttpError(400, `${t.asg.asgName} is listed twice.`);
    seen.add(asgKey(t.asg));
    await operableAccount(tenant.tenantId, t.asg.accountId);
  }

  // 2. Overlapping events on the same ASG would fight over the baseline.
  const upAt = scaleUpAt({ startsAt: req.startsAt, prescaleMinutes });
  for (const other of await listEvents(tenant.tenantId)) {
    if (!ACTIVE.includes(other.status)) continue;
    const overlaps = upAt < new Date(other.endsAt) && endsAt > scaleUpAt(other);
    const shared = other.targets.find((t) => seen.has(asgKey(t.asg)));
    if (overlaps && shared) {
      throw new HttpError(409, `${shared.asg.asgName} is already in "${other.name}" during that window.`);
    }
  }

  // 3. Save, then schedule start and end
  const event: ScaleEvent = {
    tenantId: tenant.tenantId,
    eventId: randomUUID(),
    name,
    targets: req.targets.map((t) => ({ asg: t.asg, target: t.target, state: 'pending' as const })),
    startsAt: startsAt.toISOString(),
    prescaleMinutes,
    endsAt: endsAt.toISOString(),
    status: 'scheduled',
    timeline: [entry('info', `Created by ${caller.email}. Scale-up at ${upAt.toISOString()}.`)],
    createdBy: caller.email,
    createdAt: new Date().toISOString(),
  };
  await putEvent(event);

  const payload = { kind: 'event' as const, tenantId: tenant.tenantId, id: event.eventId };
  const firesAt = new Date(Math.max(upAt.getTime(), Date.now() + 60_000)); // at least 1 minute out
  try {
    await scheduleOnce(startName(event.eventId), firesAt, { ...payload, phase: 'start' });
    await scheduleOnce(endName(event.eventId), endsAt, { ...payload, phase: 'end' });
  } catch (err) {
    await unschedule(startName(event.eventId));
    event.status = 'failed';
    event.timeline.push(entry('error', `Could not schedule the event: ${(err as Error).message}`));
    await putEvent(event);
    throw new HttpError(502, `Could not schedule the event: ${(err as Error).message}`);
  }

  await writeAudit({
    tenantId: tenant.tenantId,
    actor: { userId: caller.userId, email: caller.email },
    action: 'scale-event.created',
    result: 'success',
    message: `${name} (${event.targets.length} ASGs)`,
  });
  return event;
}

/** Scale-up: capture each ASG's current capacity as the baseline, then apply the target. */
export async function startEvent(tenantId: string, eventId: string): Promise<void> {
  const tenant = await getTenant(tenantId);
  const event = await getEvent(tenantId, eventId);
  if (!tenant || !event || event.status !== 'scheduled') return; // cancelled, or a retry after success

  event.status = 'scaling-up';
  event.timeline.push(entry('info', 'Scaling up.'));
  await putEvent(event);

  const pool = new ClientPool(tenant);
  await Promise.all(event.targets.map((t) => scaleUpTarget(tenant, pool, event, t)));

  const scaled = event.targets.filter((t) => t.state === 'scaled').length;
  event.status = scaled === 0 ? 'failed' : 'active';
  event.timeline.push(
    entry(scaled === event.targets.length ? 'info' : 'warn', `Scaled ${scaled} of ${event.targets.length} ASGs.`),
  );
  await putEvent(event);
  await writeAudit({
    tenantId,
    actor: 'system',
    action: scaled === 0 ? 'scale-event.failed' : 'scale-event.started',
    result: scaled === 0 ? 'failure' : 'success',
    message: `${event.name}: ${scaled}/${event.targets.length} scaled`,
  });
}

async function scaleUpTarget(tenant: Tenant, pool: ClientPool, event: ScaleEvent, t: ScaleTarget): Promise<void> {
  try {
    const account = await getAccount(tenant.tenantId, t.asg.accountId);
    if (!account || account.accessLevel !== 'Operate') throw new Error('account is not connected with Operate access');
    const client = await pool.autoscaling(account, t.asg);

    // Readiness at start time: logged, never blocking (the event is already due).
    const readiness = await checkReadiness(await pool.credentials(account), t.asg, t.target).catch(() => null);
    for (const c of readiness?.checks ?? []) {
      if (c.status !== 'pass') event.timeline.push(entry(c.status === 'fail' ? 'error' : 'warn', `${t.asg.asgName}: ${c.title}. ${c.detail}`));
    }

    t.baseline = await readCapacity(client, t.asg.asgName);
    await writeCapacity(client, t.asg.asgName, t.target);
    t.state = 'scaled';
    event.timeline.push(entry('info', `${t.asg.asgName}: ${fmt(t.baseline)} → ${fmt(t.target)}`));
  } catch (err) {
    t.state = 'failed';
    t.message = (err as Error).message;
    event.timeline.push(entry('error', `${t.asg.asgName}: ${t.message}`));
  }
}

/** Scale-back: restore every ASG that was scaled to its captured baseline. */
export async function endEvent(tenantId: string, eventId: string, reason = 'Event ended.'): Promise<void> {
  const tenant = await getTenant(tenantId);
  const event = await getEvent(tenantId, eventId);
  if (!tenant || !event || !['active', 'failed', 'scaling-up'].includes(event.status)) return;
  if (event.status === 'failed' && !event.targets.some((t) => t.state === 'scaled')) return;

  event.status = 'scaling-down';
  event.timeline.push(entry('info', `${reason} Scaling back to baseline.`));
  await putEvent(event);

  const pool = new ClientPool(tenant);
  await Promise.all(
    event.targets
      .filter((t) => t.state === 'scaled' && t.baseline)
      .map(async (t) => {
        try {
          const account = await getAccount(tenantId, t.asg.accountId);
          if (!account) throw new Error('account was disconnected');
          const client = await pool.autoscaling(account, t.asg);
          await writeCapacity(client, t.asg.asgName, t.baseline!);
          t.state = 'reverted';
          event.timeline.push(entry('info', `${t.asg.asgName}: back to ${fmt(t.baseline!)}`));
        } catch (err) {
          t.state = 'revert-failed';
          t.message = (err as Error).message;
          event.timeline.push(entry('error', `${t.asg.asgName}: scale-back failed: ${t.message}`));
        }
      }),
  );

  const failed = event.targets.some((t) => t.state === 'revert-failed');
  event.status = failed ? 'failed' : 'completed';
  event.timeline.push(entry(failed ? 'error' : 'info', failed ? 'Some ASGs did not scale back. Check them now.' : 'Completed.'));
  await putEvent(event);
  await writeAudit({
    tenantId,
    actor: 'system',
    action: failed ? 'scale-event.failed' : 'scale-event.completed',
    result: failed ? 'failure' : 'success',
    message: event.name,
  });
}

/** Cancel a scheduled event, or end an active one right now. */
export async function cancelEvent(tenant: Tenant, caller: Caller, eventId: string): Promise<ScaleEvent> {
  const event = await getEvent(tenant.tenantId, eventId);
  if (!event) throw new HttpError(404, 'Event not found.');

  if (event.status === 'scheduled') {
    await unschedule(startName(eventId));
    await unschedule(endName(eventId));
    event.status = 'cancelled';
    event.timeline.push(entry('info', `Cancelled by ${caller.email}.`));
    await putEvent(event);
  } else if (['active', 'scaling-up', 'failed'].includes(event.status)) {
    await unschedule(endName(eventId));
    await endEvent(tenant.tenantId, eventId, `Ended early by ${caller.email}.`);
  } else {
    throw new HttpError(409, `The event is already ${event.status}.`);
  }

  await writeAudit({
    tenantId: tenant.tenantId,
    actor: { userId: caller.userId, email: caller.email },
    action: 'scale-event.cancelled',
    result: 'success',
    message: event.name,
  });
  return (await getEvent(tenant.tenantId, eventId))!;
}
