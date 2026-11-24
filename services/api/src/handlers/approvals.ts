// GET  /approvals                     newest first (last 100)
// POST /approvals/{requestId}/approve { note?, breakGlassReason? }
// POST /approvals/{requestId}/reject  { note? }
// POST /approvals/{requestId}/cancel  requester or admin
import type { ApprovalDecisionRequest } from '@cloud-ops/shared';
import { decide, listApprovalsView } from '../lib/approvals.js';
import { handle, HttpError, json, type ApiEvent } from '../lib/http.js';
import { filterByAccounts, visibleAccountIds } from '../lib/scope.js';
import { getCaller, resolveTenant } from '../lib/tenant.js';

const ACTIONS = { approve: 'approve', reject: 'reject', cancel: 'cancel' } as const;

function optionalBody(event: ApiEvent): ApprovalDecisionRequest {
  if (!event.body) return {};
  try {
    return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

export const handler = handle(async (event) => {
  const caller = getCaller(event);
  const { tenant, membership } = await resolveTenant(caller);

  if (event.routeKey === 'GET /approvals') {
    const visible = await visibleAccountIds(tenant.tenantId, membership);
    return json(200, { approvals: filterByAccounts(await listApprovalsView(tenant.tenantId), visible, (a) => a.accountIds) });
  }
  const action = ACTIONS[event.routeKey.split('/').pop() as keyof typeof ACTIONS];
  const id = event.pathParameters?.requestId;
  if (!action || !id) throw new HttpError(404, 'Not found.');
  return json(200, { approval: await decide(tenant, caller, membership, id, action, optionalBody(event)) });
});
