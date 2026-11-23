// Invoked by EventBridge Scheduler (not API Gateway): runs event start/end and
// schedule off/on. Each step checks state first, so scheduler retries are safe.
import { endEvent, startEvent } from '../lib/events.js';
import type { RunnerPayload } from '../lib/scheduler.js';
import { switchOff, switchOn } from '../lib/schedules.js';

export const handler = async (payload: RunnerPayload): Promise<void> => {
  console.log('Runner', JSON.stringify(payload));
  const { kind, tenantId, id, phase } = payload;

  if (kind === 'event' && phase === 'start') return startEvent(tenantId, id);
  if (kind === 'event' && phase === 'end') return endEvent(tenantId, id);
  if (kind === 'schedule' && phase === 'off') return switchOff(tenantId, id);
  if (kind === 'schedule' && phase === 'on') return switchOn(tenantId, id);

  console.error('Unknown runner payload', payload);
};
