// Invoked by EventBridge Scheduler (not API Gateway): runs event start/end, schedule
// off/on, and the 6-hourly insights sweep. Each step checks state first, so scheduler
// retries are safe.
import { getTenant, listTenantIds } from '../lib/db.js';
import { endEvent, startEvent } from '../lib/events.js';
import { computeInsights } from '../lib/insights.js';
import type { RunnerPayload } from '../lib/scheduler.js';
import { switchOff, switchOn } from '../lib/schedules.js';

export const handler = async (payload: RunnerPayload | { kind: 'sweep' }): Promise<void> => {
  console.log('Runner', JSON.stringify(payload));

  if (payload.kind === 'sweep') {
    for (const tenantId of await listTenantIds()) {
      try {
        const tenant = await getTenant(tenantId);
        if (tenant) await computeInsights(tenant);
      } catch (err) {
        console.error(`Insights sweep failed for ${tenantId}`, err);
      }
    }
    return;
  }

  const { kind, tenantId, id, phase } = payload;
  if (kind === 'event' && phase === 'start') return startEvent(tenantId, id);
  if (kind === 'event' && phase === 'end') return endEvent(tenantId, id);
  if (kind === 'schedule' && phase === 'off') return switchOff(tenantId, id);
  if (kind === 'schedule' && phase === 'on') return switchOn(tenantId, id);

  console.error('Unknown runner payload', payload);
};
