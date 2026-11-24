// PUT /asgs/capacity: "scale now". Changes min/desired/max on one ASG and writes an audit entry.
// Accounts marked requireApproval get a 202 with an approval request instead.
import type { CapacityChangeRequest } from '@cloud-ops/shared';
import { approvalGate, describeCapacity } from '../lib/approvals.js';
import { applyCapacityChange, capacityAccount, validateCapacityRequest } from '../lib/capacity.js';
import { handle, json, parseBody } from '../lib/http.js';
import { getCaller, OPERATOR_ROLES, requireRole, resolveTenant } from '../lib/tenant.js';

export const handler = handle(async (event) => {
  const caller = getCaller(event);
  const { tenant, membership } = await resolveTenant(caller);
  requireRole(membership, OPERATOR_ROLES);

  const req = parseBody<CapacityChangeRequest>(event);
  validateCapacityRequest(req);
  const account = await capacityAccount(tenant.tenantId, req.asg.accountId);

  await approvalGate(tenant, caller, 'capacity', req, (accounts) => describeCapacity(req, accounts))([account.accountId]);
  return json(200, await applyCapacityChange(tenant, account, caller, req));
});
