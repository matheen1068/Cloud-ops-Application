/**
 * Scale events: pre-scale before a known spike, hold, then scale back to the
 * capacity captured just before scale-up. Start/end are fired by EventBridge
 * Scheduler; every step is idempotent so scheduler retries are safe.
 */
import { randomUUID } from 'node:crypto';
import { DescribeScalingActivitiesCommand, type AutoScalingClient } from '@aws-sdk/client-auto-scaling';
import {
  asgKey,
  validateCapacity,
  type CreateScaleEventRequest,
  type ScaleEvent,
  type ScaleTarget,
  type TargetReport,
  type Tenant,
} from '@cloud-ops/shared';
import { REGION_PATTERN } from './aws.js';
import { ClientPool, entry, fmt, operableAccount, readCapacity, writeCapacity } from './capacity.js';
import { getAccount, getEvent, getTenant, listEvents, putEvent, writeAudit } from './db.js';
import { HttpError } from './http.js';
import { notify, sendToDevOpsAgent } from './notify.js';
import { checkReadiness } from './readiness.js';
import { getSettings } from './settings.js';
import { scheduleOnce, unschedule } from './scheduler.js';
import type { Gate } from './approvals.js';
import type { Caller } from './tenant.js';

const ACTIVE: ScaleEvent['status'][] = ['scheduled', 'scaling-up', 'active', 'scaling-down'];
export const startName = (id: string) => `evt-${id}-start`;
export const endName = (id: string) => `evt-${id}-end`;

export function scaleUpAt(e: Pick<ScaleEvent, 'startsAt' | 'prescaleMinutes'>): Date {
  return new Date(new Date(e.startsAt).getTime() - e.prescaleMinutes * 60_000);
}

export async function createEvent(
  tenant: Tenant,
  caller: Caller,
  req: CreateScaleEventRequest,
  opts: { gate?: Gate } = {},
): Promise<ScaleEvent> {
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

  // Protected accounts: stop here and save an approval request instead (must be approved before scale-up).
  await opts.gate?.(req.targets.map((t) => t.asg.accountId), upAt);

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
  event.scaledUpAt = new Date().toISOString();
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

  const lines = event.targets.map((t) =>
    t.state === 'scaled' ? `${t.asg.asgName}: ${fmt(t.baseline!)} → ${fmt(t.target)}` : `${t.asg.asgName}: FAILED, ${t.message}`,
  );
  if (scaled === event.targets.length) {
    await notify(tenantId, { kind: 'event-started', level: 'info', title: `Scale event "${event.name}" is live`, lines });
  } else {
    await notify(tenantId, {
      kind: 'failure',
      level: scaled === 0 ? 'error' : 'warn',
      title: `Scale event "${event.name}": ${scaled} of ${event.targets.length} ASGs scaled up`,
      lines: [...lines, ...problemLines(event)],
      incident: { id: `cloudops-${eventId}-start`, priority: scaled === 0 ? 'HIGH' : 'MEDIUM', service: 'Cloud-Ops scale event' },
    });
  }
}

/** Warnings and errors from the timeline, for notifications and investigations. */
function problemLines(event: ScaleEvent): string[] {
  return event.timeline.filter((t) => t.level !== 'info').map((t) => t.message).slice(-10);
}

/** How the scale-up went, from the ASG's own scaling activity history. */
async function measure(client: AutoScalingClient, asgName: string, sinceIso: string): Promise<TargetReport> {
  const res = await client.send(new DescribeScalingActivitiesCommand({ AutoScalingGroupName: asgName, MaxRecords: 100 }));
  const since = new Date(sinceIso).getTime();
  const recent = (res.Activities ?? []).filter((a) => a.StartTime && a.StartTime.getTime() >= since - 5000);
  const launches = recent.filter((a) => a.StatusCode === 'Successful' && /^launching/i.test(a.Description ?? ''));
  const lastEnd = Math.max(0, ...launches.map((a) => a.EndTime?.getTime() ?? 0));
  return {
    launches: launches.length,
    failedLaunches: recent.filter((a) => a.StatusCode === 'Failed').length,
    readyAfterSeconds: launches.length && lastEnd ? Math.round((lastEnd - since) / 1000) : undefined,
  };
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
          if (event.scaledUpAt) t.report = await measure(client, t.asg.asgName, event.scaledUpAt).catch(() => undefined);
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

  // Post-event report
  const hours = event.scaledUpAt ? (Date.now() - new Date(event.scaledUpAt).getTime()) / 3600_000 : 0;
  const scaledTargets = event.targets.filter((t) => t.baseline && (t.state === 'reverted' || t.state === 'revert-failed'));
  const readyTimes = scaledTargets.map((t) => t.report?.readyAfterSeconds).filter((n): n is number => n !== undefined);
  event.report = {
    extraInstanceHours: Math.round(scaledTargets.reduce((sum, t) => sum + Math.max(0, t.target.desired - t.baseline!.desired), 0) * hours * 10) / 10,
    launches: scaledTargets.reduce((sum, t) => sum + (t.report?.launches ?? 0), 0),
    failedLaunches: scaledTargets.reduce((sum, t) => sum + (t.report?.failedLaunches ?? 0), 0),
    slowestReadySeconds: readyTimes.length ? Math.max(...readyTimes) : undefined,
  };
  event.timeline.push(entry(failed ? 'error' : 'info', failed ? 'Some ASGs did not scale back. Check them now.' : 'Completed.'));
  await putEvent(event);
  await writeAudit({
    tenantId,
    actor: 'system',
    action: failed ? 'scale-event.failed' : 'scale-event.completed',
    result: failed ? 'failure' : 'success',
    message: event.name,
  });

  const r = event.report;
  const summary = [
    `${r.launches} instances launched, ${r.failedLaunches} failed launches`,
    r.slowestReadySeconds !== undefined ? `Capacity ready ${Math.round(r.slowestReadySeconds / 60)} min after scale-up` : 'Time to ready: not measured',
    `≈ ${r.extraInstanceHours} extra instance-hours`,
  ];
  if (failed) {
    await notify(tenantId, {
      kind: 'failure',
      level: 'error',
      title: `Scale event "${event.name}": scale-back failed`,
      lines: [...problemLines(event), ...summary],
      incident: { id: `cloudops-${eventId}-end`, priority: 'HIGH', service: 'Cloud-Ops scale event' },
    });
  } else {
    await notify(tenantId, { kind: 'event-completed', level: 'info', title: `Scale event "${event.name}" completed`, lines: summary });
  }
}

/** Manually send a failed or troubled event to the customer's DevOps Agent. */
export async function investigateEvent(tenant: Tenant, caller: Caller, eventId: string): Promise<void> {
  const event = await getEvent(tenant.tenantId, eventId);
  if (!event) throw new HttpError(404, 'Event not found.');
  const settings = await getSettings(tenant.tenantId);
  if (!settings.devopsAgent) throw new HttpError(400, 'Connect your AWS DevOps Agent in Settings first.');
  const problems = problemLines(event);
  if (problems.length === 0) throw new HttpError(400, 'This event has no warnings or errors to investigate.');

  const lines = [
    `Cloud-Ops scale event "${event.name}" (${event.status}).`,
    ...event.targets.map((t) => `ASG ${t.asg.asgName} in account ${t.asg.accountId} ${t.asg.region}: target ${fmt(t.target)}, state ${t.state}${t.message ? `, ${t.message}` : ''}`),
    'Problems:',
    ...problems,
  ];
  try {
    await sendToDevOpsAgent(settings.devopsAgent, {
      kind: 'failure',
      level: 'error',
      title: `Scaling problem: ${event.name}`,
      lines,
      incident: { id: `cloudops-${eventId}-manual-${Date.now()}`, priority: 'HIGH', service: 'Cloud-Ops scale event' },
    });
  } catch (err) {
    throw new HttpError(502, `DevOps Agent did not accept the investigation: ${(err as Error).message}`);
  }
  event.timeline.push(entry('info', `Sent to AWS DevOps Agent by ${caller.email}.`));
  await putEvent(event);
  await writeAudit({
    tenantId: tenant.tenantId,
    actor: { userId: caller.userId, email: caller.email },
    action: 'devops-agent.investigation-sent',
    result: 'success',
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
