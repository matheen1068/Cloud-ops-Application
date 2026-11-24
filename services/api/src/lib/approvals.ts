/**
 * Approvals: a two-person rule for accounts marked "requireApproval" (usually prod).
 *
 * Scale Now, new scale events and new schedules that touch such an account are saved as a
 * request instead of being applied. Another owner or admin approves it, and only then does
 * Cloud-Ops run it, on behalf of the person who asked. An owner can apply their own request
 * in an emergency ("break glass") with a written reason, which is recorded in the audit log.
 */
import { refLabel } from '@cloud-ops/shared';
import type {
  ApprovalDecisionRequest,
  ApprovalKind,
  ApprovalRequest,
  AwsAccount,
  CapacityChangeRequest,
  CreateScaleEventRequest,
  CreateScheduleRequest,
  Membership,
  Tenant,
} from '@cloud-ops/shared';
import { applyCapacityChange, capacityAccount, fmt } from './capacity.js';
import { claimApproval, getApproval, listAccounts, listApprovals, putApproval, timeSortableId, writeAudit } from './db.js';
import { createEvent } from './events.js';
import { HttpError, Respond } from './http.js';
import { notify } from './notify.js';
import { createSchedule } from './schedules.js';
import type { Caller } from './tenant.js';

const DAY = 86_400_000;
const MIN_WINDOW = 5 * 60_000;
const ADMINS = ['owner', 'admin'];

type Payload = ApprovalRequest['payload'];
type Description = { summary: string; details: string[] };

/** Called by create/scale code once the request is valid. Returns normally when no approval is needed. */
export type Gate = (accountIds: string[], latest?: Date) => Promise<void>;

const actorOf = (c: Caller) => ({ userId: c.userId, email: c.email });
const aliasOf = (accounts: AwsAccount[], id: string) => accounts.find((a) => a.accountId === id)?.alias ?? id;

export function approvalGate(
  tenant: Tenant,
  caller: Caller,
  kind: ApprovalKind,
  payload: Payload,
  describe: (accounts: AwsAccount[]) => Description,
): Gate {
  return async (accountIds, latest) => {
    const ids = [...new Set(accountIds)];
    const accounts = await listAccounts(tenant.tenantId);
    const gated = accounts.filter((a) => a.requireApproval && ids.includes(a.accountId));
    if (gated.length === 0) return;

    const now = Date.now();
    const expires = Math.min(now + DAY, latest?.getTime() ?? Infinity);
    if (expires - now < MIN_WINDOW) {
      throw new HttpError(400, `${gated.map((a) => a.alias).join(', ')} needs approval, and this starts in under 5 minutes. Plan it further ahead.`);
    }

    const { summary, details } = describe(accounts);
    const approval: ApprovalRequest = {
      requestId: timeSortableId(),
      tenantId: tenant.tenantId,
      kind,
      status: 'pending',
      summary,
      details,
      accountIds: ids,
      payload,
      requestedBy: actorOf(caller),
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(expires).toISOString(),
    };
    await putApproval(approval);
    await writeAudit({ tenantId: tenant.tenantId, actor: actorOf(caller), action: 'approval.requested', result: 'success', message: summary });
    await notify(tenant.tenantId, {
      kind: 'approval',
      level: 'warn',
      title: `Approval needed: ${summary}`,
      lines: [...details, `Requested by ${caller.email}. Expires ${approval.expiresAt}.`, 'Approve or reject it in Cloud-Ops → Approvals.'],
    });
    throw new Respond(202, { approval });
  };
}

export function describeCapacity(req: CapacityChangeRequest, accounts: AwsAccount[]): Description {
  const alias = aliasOf(accounts, req.asg.accountId);
  return {
    summary: `Scale ${refLabel(req.asg)} (${alias}) to ${fmt(req.capacity)}`,
    details: [`${alias} · ${req.asg.region} · ${refLabel(req.asg)} → ${fmt(req.capacity)} (min/desired/max)`, ...(req.reason ? [`Reason: ${req.reason}`] : [])],
  };
}

export function describeEvent(req: CreateScaleEventRequest, accounts: AwsAccount[]): Description {
  return {
    summary: `Scale event "${req.name}"`,
    details: [
      `${req.startsAt} → ${req.endsAt}, pre-scale ${req.prescaleMinutes ?? 0} min`,
      ...req.targets.map((t) => `${aliasOf(accounts, t.asg.accountId)} · ${t.asg.region} · ${refLabel(t.asg)} → ${fmt(t.target)}`),
    ],
  };
}

export function describeSchedule(req: CreateScheduleRequest, accounts: AwsAccount[]): Description {
  return {
    summary: `Off-hours schedule "${req.name}"`,
    details: [
      `${req.days.join(', ')}: off at ${req.offAt}, on at ${req.onAt} (${req.timezone})`,
      ...req.asgs.map((a) => `${aliasOf(accounts, a.accountId)} · ${a.region} · ${refLabel(a)}`),
    ],
  };
}

async function expireIfDue(a: ApprovalRequest): Promise<ApprovalRequest> {
  if (a.status === 'pending' && new Date(a.expiresAt).getTime() <= Date.now()) {
    a.status = 'expired';
    await putApproval(a);
  }
  return a;
}

export async function listApprovalsView(tenantId: string): Promise<ApprovalRequest[]> {
  const all = await listApprovals(tenantId);
  await Promise.all(all.map(expireIfDue));
  return all.sort((a, b) => b.requestId.localeCompare(a.requestId)).slice(0, 100);
}

/** Runs the approved change as the person who requested it. Returns a one-line result. */
async function execute(tenant: Tenant, a: ApprovalRequest, approver: string): Promise<string> {
  const requester: Caller = { ...a.requestedBy, emailVerified: true };
  switch (a.kind) {
    case 'capacity': {
      const req = a.payload as CapacityChangeRequest;
      const account = await capacityAccount(tenant.tenantId, req.asg.accountId);
      const note = `${req.reason ? `${req.reason} · ` : ''}approved by ${approver}`;
      const r = await applyCapacityChange(tenant, account, requester, req, note);
      return `${refLabel(req.asg)}: ${fmt(r.before)} → ${fmt(r.after)}`;
    }
    case 'scale-event': {
      const event = await createEvent(tenant, requester, a.payload as CreateScaleEventRequest);
      return `Event "${event.name}" scheduled.`;
    }
    case 'schedule': {
      const schedule = await createSchedule(tenant, requester, a.payload as CreateScheduleRequest);
      return `Schedule "${schedule.name}" created.`;
    }
  }
}

export async function decide(
  tenant: Tenant,
  caller: Caller,
  membership: Membership,
  requestId: string,
  action: 'approve' | 'reject' | 'cancel',
  body: ApprovalDecisionRequest = {},
): Promise<ApprovalRequest> {
  const found = await getApproval(tenant.tenantId, requestId);
  if (!found) throw new HttpError(404, 'Approval request not found.');
  const a = await expireIfDue(found);
  if (a.status !== 'pending') throw new HttpError(409, `This request is already ${a.status}.`);

  const mine = a.requestedBy.userId === caller.userId;
  const isAdmin = ADMINS.includes(membership.role);
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || undefined : undefined;
  const decided = { decidedBy: actorOf(caller), decidedAt: new Date().toISOString(), note };

  if (action === 'cancel') {
    if (!mine && !isAdmin) throw new HttpError(403, 'Only the requester or an admin can cancel this.');
    Object.assign(a, decided, { status: 'cancelled' });
    if (!(await claimApproval(a))) throw new HttpError(409, 'Someone else decided this request first.');
    await writeAudit({ tenantId: tenant.tenantId, actor: actorOf(caller), action: 'approval.cancelled', result: 'success', message: a.summary });
    return a;
  }

  if (!isAdmin) throw new HttpError(403, 'Only owners and admins can approve or reject.');

  if (action === 'reject') {
    if (mine) throw new HttpError(400, 'Use cancel for your own request.');
    Object.assign(a, decided, { status: 'rejected' });
    if (!(await claimApproval(a))) throw new HttpError(409, 'Someone else decided this request first.');
    await writeAudit({ tenantId: tenant.tenantId, actor: actorOf(caller), action: 'approval.rejected', result: 'success', message: `${a.summary}${note ? ` · ${note}` : ''}` });
    await notify(tenant.tenantId, { kind: 'approval', level: 'info', title: `Rejected: ${a.summary}`, lines: [`Rejected by ${caller.email}${note ? `: ${note}` : '.'}`] });
    return a;
  }

  // approve
  const reason = typeof body.breakGlassReason === 'string' ? body.breakGlassReason.trim() : '';
  if (mine && (membership.role !== 'owner' || reason.length < 10)) {
    throw new HttpError(403, "You can't approve your own request. Ask another owner or admin. In an emergency an owner can override with a reason (10+ characters).");
  }
  Object.assign(a, decided, { status: 'approved', breakGlass: mine || undefined, note: mine ? reason : note });
  if (!(await claimApproval(a))) throw new HttpError(409, 'Someone else decided this request first.');

  try {
    a.result = await execute(tenant, a, caller.email);
  } catch (err) {
    a.status = 'failed';
    a.result = (err as Error).message;
  }
  await putApproval(a);
  await writeAudit({
    tenantId: tenant.tenantId,
    actor: actorOf(caller),
    action: mine ? 'approval.break-glass' : 'approval.approved',
    result: a.status === 'failed' ? 'failure' : 'success',
    message: `${a.summary}${mine ? ` · reason: ${reason}` : ''}${a.result ? ` · ${a.result}` : ''}`,
  });
  await notify(tenant.tenantId, {
    kind: a.status === 'failed' ? 'failure' : 'approval',
    level: a.status === 'failed' ? 'error' : mine ? 'warn' : 'info',
    title: `${a.status === 'failed' ? 'Approved but failed' : mine ? 'Emergency override' : 'Approved'}: ${a.summary}`,
    lines: [mine ? `${caller.email} applied their own request. Reason: ${reason}` : `Approved by ${caller.email}.`, ...(a.result ? [a.result] : [])],
  });
  return a;
}
