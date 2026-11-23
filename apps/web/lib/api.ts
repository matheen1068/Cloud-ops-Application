// Typed client for the Cloud-Ops API. Request/response types are shared with the Lambdas.
import type {
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
  createEvent: (req: CreateScaleEventRequest) => request<{ event: ScaleEvent }>('POST', '/scale-events', req),
  cancelEvent: (eventId: string) =>
    request<{ event: ScaleEvent }>('POST', `/scale-events/${encodeURIComponent(eventId)}/cancel`),
  investigateEvent: (eventId: string) =>
    request<{ sent: boolean }>('POST', `/scale-events/${encodeURIComponent(eventId)}/investigate`),

  listSchedules: () => request<{ schedules: ScaleSchedule[] }>('GET', '/schedules'),
  createSchedule: (req: CreateScheduleRequest) => request<{ schedule: ScaleSchedule }>('POST', '/schedules', req),
  deleteSchedule: (scheduleId: string) =>
    request<{ deleted: string }>('DELETE', `/schedules/${encodeURIComponent(scheduleId)}`),

  getSettings: () => request<{ settings: SettingsView }>('GET', '/settings'),
  updateSettings: (req: UpdateSettingsRequest) => request<{ settings: SettingsView }>('PUT', '/settings', req),
  testSettings: () => request<{ results: Record<string, string> }>('POST', '/settings/test'),

  getInsights: () => request<{ report: InsightsReport | null }>('GET', '/insights'),
  runInsights: () => request<{ report: InsightsReport }>('POST', '/insights/run'),

  listAudit: (cursor?: string) =>
    request<AuditPage>('GET', `/audit?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
};
