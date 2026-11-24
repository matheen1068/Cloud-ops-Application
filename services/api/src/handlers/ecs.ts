// GET /ecs-services[?accountId=123456789012]: ECS services across connected accounts and regions.
// Accounts whose role predates ECS support are listed in notEnabled instead of as errors.
import type { ListEcsResponse } from '@cloud-ops/shared';
import { assumeAccessRole, type TempCredentials } from '../lib/aws.js';
import { listAccounts } from '../lib/db.js';
import { listEcsInRegion } from '../lib/ecs.js';
import { handle, json } from '../lib/http.js';
import { canSeeAccount } from '../lib/scope.js';
import { getCaller, resolveTenant } from '../lib/tenant.js';

const denied = (err: unknown) => /AccessDenied/.test((err as Error).name) || /not authorized/i.test((err as Error).message);

export const handler = handle(async (event) => {
  const { tenant, membership } = await resolveTenant(getCaller(event));
  const onlyAccount = event.queryStringParameters?.accountId;
  const accounts = (await listAccounts(tenant.tenantId)).filter(
    (a) => a.status === 'connected' && canSeeAccount(membership, a) && (!onlyAccount || a.accountId === onlyAccount),
  );

  const result: ListEcsResponse = { services: [], errors: [], notEnabled: [] };
  await Promise.all(
    accounts.map(async (account) => {
      let credentials: TempCredentials;
      try {
        credentials = await assumeAccessRole(account.roleArn, tenant.externalId, tenant.tenantId);
      } catch (err) {
        result.errors.push({ accountId: account.accountId, message: (err as Error).message });
        return;
      }
      const perRegion = await Promise.allSettled(account.regions.map((region) => listEcsInRegion(account, region, credentials)));
      perRegion.forEach((outcome, i) => {
        if (outcome.status === 'fulfilled') result.services.push(...outcome.value);
        else if (denied(outcome.reason)) {
          if (!result.notEnabled.includes(account.accountId)) result.notEnabled.push(account.accountId);
        } else {
          result.errors.push({ accountId: account.accountId, region: account.regions[i], message: (outcome.reason as Error).message });
        }
      });
    }),
  );
  result.services.sort((a, b) => a.accountId.localeCompare(b.accountId) || a.cluster.localeCompare(b.cluster) || a.asgName.localeCompare(b.asgName));
  return json(200, result);
});
