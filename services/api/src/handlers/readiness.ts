// POST /asgs/readiness: pre-flight checks for one or more planned capacity changes.
import { REGION_PATTERN } from '../lib/aws.js';
import { ClientPool } from '../lib/capacity.js';
import { getAccount } from '../lib/db.js';
import { handle, HttpError, json, parseBody } from '../lib/http.js';
import { checkReadiness } from '../lib/readiness.js';
import { getCaller, resolveTenant } from '../lib/tenant.js';
import type { ReadinessRequest, ReadinessResult } from '@cloud-ops/shared';

export const handler = handle(async (event) => {
  const { tenant } = await resolveTenant(getCaller(event));
  const req = parseBody<ReadinessRequest>(event);
  if (!Array.isArray(req.targets) || req.targets.length < 1 || req.targets.length > 20) {
    throw new HttpError(400, 'Send 1-20 targets.');
  }

  const pool = new ClientPool(tenant);
  const results: ReadinessResult[] = await Promise.all(
    req.targets.map(async ({ asg, capacity }) => {
      if (!asg?.accountId || !asg.asgName || !REGION_PATTERN.test(asg.region ?? '') || !capacity) {
        return { asg, checks: [{ id: 'input', status: 'fail', title: 'Invalid target', detail: 'Needs accountId, region, asgName and capacity.' }] };
      }
      const account = await getAccount(tenant.tenantId, asg.accountId);
      if (!account || account.status !== 'connected') {
        return { asg, checks: [{ id: 'account', status: 'fail', title: 'Account not connected', detail: asg.accountId }] };
      }
      try {
        return await checkReadiness(await pool.credentials(account), asg, capacity);
      } catch (err) {
        return { asg, checks: [{ id: 'error', status: 'fail', title: 'Readiness check failed', detail: (err as Error).message }] };
      }
    }),
  );
  return json(200, { results });
});
