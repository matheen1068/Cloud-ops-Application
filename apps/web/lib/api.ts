// Typed client for the Cloud-Ops API. Request/response types are shared with the Lambdas.
import type {
  ApprovalDecisionRequest,
  ApprovalRequest,
  CreateInviteRequest,
  CreateInviteResponse,
  Member,
  PendingApprovalResponse,
  TeamView,
  UpdateAccountRequest,
  UserRole,
  AuditPage,
  AwsAccount,
  InsightsReport,
  SettingsView,
  UpdateSettingsRequest,
  CapacityChangeRequest,
  CapacitySettings,
  ConnectAccountRequest,
  CreateScaleEventRequest,
  CreateScheduleRequest,
  ListAsgsResponse,
  MeResponse,
  ReadinessRequest,
  ReadinessResult,
  ScaleEvent,
  ScaleSchedule,
} from '@cloud-ops/shared';
import { idToken } from './auth';
import { getConfig } from './config';
import { showNotice } from './notice';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(getConfig().apiUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${await idToken()}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  // 202 = the account needs approval, so the change was saved as a request instead.
  if (res.status === 202 && data.approval) {
    showNotice(`Sent for approval: ${data.approval.summary}. Another owner or admin approves it under Approvals.`);
  }
  return data as T;
}

export const api = {
  me: () => request<MeResponse>('GET', '/me'),
  listAccounts: () => request<{ accounts: AwsAccount[] }>('GET', '/accounts'),
  connectAccount: (req: ConnectAccountRequest) => request<{ account: AwsAccount }>('POST', '/accounts', req),
  listAsgs: () => request<ListAsgsResponse>('GET', '/asgs'),
  setCapacity: (req: CapacityChangeRequest) =>
    request<{ before: CapacitySettings; after: CapacitySettings }>('PUT', '/asgs/capacity', req),
  readiness: (req: ReadinessRequest) => request<{ results: ReadinessResult[] }>('POST', '/asgs/readiness', req),

  listEvents: () => request<{ events: ScaleEvent[] }>('GET', '/scale-events'),
  createEvent: (req: CreateScaleEventRequest) => request<{ event: ScaleEvent } | PendingApprovalResponse>('POST', '/scale-events', req),
  cancelEvent: (eventId: string) =>
    request<{ event: ScaleEvent }>('POST', `/scale-events/${encodeURIComponent(eventId)}/cancel`),
  investigateEvent: (eventId: string) =>
    request<{ sent: boolean }>('POST', `/scale-events/${encodeURIComponent(eventId)}/investigate`),

  listSchedules: () => request<{ schedules: ScaleSchedule[] }>('GET', '/schedules'),
  createSchedule: (req: CreateScheduleRequest) => request<{ schedule: ScaleSchedule } | PendingApprovalResponse>('POST', '/schedules', req),
  deleteSchedule: (scheduleId: string) =>
    request<{ deleted: string }>('DELETE', `/schedules/${encodeURIComponent(scheduleId)}`),

  switchWorkspace: (tenantId: string) => request<MeResponse>('POST', '/me/workspace', { tenantId }),
  updateAccount: (accountId: string, req: UpdateAccountRequest) =>
    request<{ account: AwsAccount }>('PUT', `/accounts/${accountId}`, req),

  listMembers: () => request<TeamView>('GET', '/members'),
  invite: (req: CreateInviteRequest) => request<CreateInviteResponse>('POST', '/members/invites', req),
  revokeInvite: (inviteId: string) => request<{ revoked: string }>('DELETE', `/members/invites/${encodeURIComponent(inviteId)}`),
  setMemberRole: (userId: string, role: UserRole) =>
    request<{ member: Member }>('PUT', `/members/${encodeURIComponent(userId)}`, { role }),
  removeMember: (userId: string) => request<{ removed: string }>('DELETE', `/members/${encodeURIComponent(userId)}`),
  acceptInvite: (inviteId: string) => request<{ tenantId: string }>('POST', `/invites/${encodeURIComponent(inviteId)}/accept`),
  declineInvite: (inviteId: string) => request<{ declined: string }>('POST', `/invites/${encodeURIComponent(inviteId)}/decline`),

  listApprovals: () => request<{ approvals: ApprovalRequest[] }>('GET', '/approvals'),
  decideApproval: (requestId: string, action: 'approve' | 'reject' | 'cancel', body: ApprovalDecisionRequest = {}) =>
    request<{ approval: ApprovalRequest }>('POST', `/approvals/${encodeURIComponent(requestId)}/${action}`, body),

  getSettings: () => request<{ settings: SettingsView }>('GET', '/settings'),
  updateSettings: (req: UpdateSettingsRequest) => request<{ settings: SettingsView }>('PUT', '/settings', req),
  testSettings: () => request<{ results: Record<string, string> }>('POST', '/settings/test'),

  getInsights: () => request<{ report: InsightsReport | null }>('GET', '/insights'),
  runInsights: () => request<{ report: InsightsReport }>('POST', '/insights/run'),

  listAudit: (cursor?: string) =>
    request<AuditPage>('GET', `/audit?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
};
