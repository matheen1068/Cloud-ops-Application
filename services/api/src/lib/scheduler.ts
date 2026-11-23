// EventBridge Scheduler: fires the runner Lambda at an event's start/end and on
// recurring schedule times. Scheduler is AWS-managed and free for this volume.
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  SchedulerClient,
} from '@aws-sdk/client-scheduler';
import { requireEnv } from './db.js';

const scheduler = new SchedulerClient({});

export interface RunnerPayload {
  kind: 'event' | 'schedule';
  tenantId: string;
  id: string;
  phase: 'start' | 'end' | 'off' | 'on';
}

function target(payload: RunnerPayload) {
  return {
    Arn: requireEnv('RUNNER_ARN'),
    RoleArn: requireEnv('SCHEDULER_ROLE_ARN'),
    Input: JSON.stringify(payload),
    RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 },
  };
}

/** Scheduler wants at(yyyy-mm-ddThh:mm:ss) without milliseconds or a Z. */
export function atExpression(date: Date): string {
  return `at(${date.toISOString().slice(0, 19)})`;
}

/** One-time schedule that deletes itself after it fires. */
export async function scheduleOnce(name: string, at: Date, payload: RunnerPayload): Promise<void> {
  await scheduler.send(
    new CreateScheduleCommand({
      Name: name,
      GroupName: requireEnv('SCHEDULE_GROUP'),
      ScheduleExpression: atExpression(at),
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
      Target: target(payload),
    }),
  );
}

/** Recurring schedule, e.g. cron(0 20 ? * MON-FRI *) in Asia/Kolkata. */
export async function scheduleRecurring(
  name: string,
  cron: string,
  timezone: string,
  payload: RunnerPayload,
): Promise<void> {
  await scheduler.send(
    new CreateScheduleCommand({
      Name: name,
      GroupName: requireEnv('SCHEDULE_GROUP'),
      ScheduleExpression: cron,
      ScheduleExpressionTimezone: timezone,
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: target(payload),
    }),
  );
}

/** Deletes a schedule; already-fired (self-deleted) or missing schedules are fine. */
export async function unschedule(name: string): Promise<void> {
  try {
    await scheduler.send(new DeleteScheduleCommand({ Name: name, GroupName: requireEnv('SCHEDULE_GROUP') }));
  } catch (err) {
    if ((err as Error).name !== 'ResourceNotFoundException') throw err;
  }
}

/** cron for HH:MM on the given days: cron(30 20 ? * MON,TUE *) */
export function cronAt(hhmm: string, days: string[]): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `cron(${m} ${h} ? * ${days.join(',')} *)`;
}
