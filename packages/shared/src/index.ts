/**
 * Cloud-Ops domain model, shared by the web app, the API and the infra code.
 *
 * Hierarchy: Tenant -> Client (optional, MSP plans) -> AWS account -> Region -> ASG
 *
 * Lines starting with "TS:" explain a TypeScript feature the first time it appears.
 */

// ---------------------------------------------------------------------------
// Plans and tenants
// ---------------------------------------------------------------------------

// TS: a union type. A PlanId can only be one of these exact strings.
export type PlanId = 'free' | 'pro' | 'msp';

// TS: an interface describes the shape of an object.
export interface PlanLimits {
  maxAwsAccounts: number | null; // null = unlimited
  maxUsers: number | null;
  clientGroups: boolean; // MSP feature: group accounts by end customer
  sso: boolean;
}

// TS: Record<K, V> is an object with one entry for every K.
// Placeholder numbers until pricing is decided.
export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: { maxAwsAccounts: 3, maxUsers: 1, clientGroups: false, sso: false },
  pro: { maxAwsAccounts: 25, maxUsers: 10, clientGroups: false, sso: false },
  msp: { maxAwsAccounts: null, maxUsers: null, clientGroups: true, sso: true },
};

/** A customer workspace: a solo engineer, a startup, or an MSP. */
export interface Tenant {
  tenantId: string;
  name: string;
  plan: PlanId;
  /** Used as sts:ExternalId for every account this tenant connects. Never sent to the browser. */
  externalId: string;
  createdAt: string; // ISO 8601 timestamp
}

/** MSP plans only: an end customer whose AWS accounts the MSP manages. */
export interface Client {
  tenantId: string;
  clientId: string;
  name: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Users and roles
// ---------------------------------------------------------------------------

export type UserRole = 'owner' | 'admin' | 'operator' | 'viewer';

export interface Membership {
  tenantId: string;
  userId: string;
  email: string;
  role: UserRole;
  // TS: the "?" makes a field optional.
  /** MSP plans: limit this user to these clients. Missing = all clients. */
  clientIds?: string[];
}

// ---------------------------------------------------------------------------
// Connected AWS accounts
// ---------------------------------------------------------------------------

export type ConnectionMethod = 'single-account' | 'organization';
export type AccessLevel = 'ReadOnly' | 'Operate';
export type ConnectionStatus = 'pending' | 'connected' | 'error';

export interface AwsAccount {
  tenantId: string;
  accountId: string; // 12 digits
  alias: string; // friendly name shown in the UI
  clientId?: string;
  roleArn: string; // CloudOpsAccessRole created by the onboarding template
  accessLevel: AccessLevel;
  connectionMethod: ConnectionMethod;
  status: ConnectionStatus;
  regions: string[]; // regions to scan for ASGs
  /** Changes here (Scale Now, new events and schedules) need a second person's approval. */
  requireApproval?: boolean;
  lastCheckedAt?: string;
  lastError?: string;
}

/** PUT /accounts/{accountId} body (admins). Only the fields sent are changed. */
export interface UpdateAccountRequest {
  alias?: string;
  regions?: string[];
  requireApproval?: boolean;
}

/** POST /accounts body: connect an account after the customer created the role. */
export interface ConnectAccountRequest {
  roleArn: string;
  alias: string;
  regions?: string[]; // defaults to the platform's region
  accessLevel?: AccessLevel; // must match what the template was deployed with
  clientId?: string;
}

/** A workspace the user belongs to (MSP engineers can be in several). */
export interface WorkspaceRef {
  tenantId: string;
  name: string;
  role: UserRole;
}

/** An invite waiting for the signed-in user, shown as a banner. */
export interface PendingInvite {
  inviteId: string;
  tenantId: string;
  tenantName: string;
  role: UserRole;
  invitedBy: string;
  expiresAt: string;
}

/** What GET /me returns. `onboarding` is only sent to owners and admins. */
export interface MeResponse {
  user: { userId: string; email: string; role: UserRole };
  tenant: { tenantId: string; name: string; plan: PlanId; limits: PlanLimits };
  workspaces: WorkspaceRef[];
  invites: PendingInvite[];
  onboarding?: {
    platformAccountId: string;
    platformRoleName: string;
    accessRoleName: string;
    externalId: string;
  };
}

// ---------------------------------------------------------------------------
// Auto Scaling groups
// ---------------------------------------------------------------------------

export interface CapacitySettings {
  min: number;
  desired: number;
  max: number;
}

/** Points at one ASG anywhere in a tenant's accounts. */
export interface AsgRef {
  accountId: string;
  region: string;
  asgName: string;
}

export interface AutoScalingGroupSummary extends AsgRef {
  // TS: "extends" copies every field from AsgRef into this interface.
  arn: string;
  capacity: CapacitySettings;
  inServiceInstances: number;
  onDemandInstances: number;
  spotInstances: number;
  instanceTypes: string[];
  /** True when the ASG carries the tag CloudOpsManaged=true. */
  managedByCloudOps: boolean;
  tags: Record<string, string>;
  lastSyncedAt: string;
}

/** "Scale now" request from the UI (PUT /asgs/capacity). */
export interface CapacityChangeRequest {
  asg: AsgRef;
  capacity: CapacitySettings;
  reason?: string;
}

/** GET /asgs response. Partial failures (one account or region down) land in `errors`. */
export interface ListAsgsResponse {
  asgs: AutoScalingGroupSummary[];
  errors: { accountId: string; region?: string; message: string }[];
}

// ---------------------------------------------------------------------------
// Readiness checks (run before Scale Now, events and schedules)
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface ReadinessCheck {
  id: string; // e.g. 'vcpu-quota', 'az-offering'
  status: CheckStatus;
  title: string;
  detail: string;
}

export interface ReadinessResult {
  asg: AsgRef;
  current?: CapacitySettings;
  checks: ReadinessCheck[];
}

/** POST /asgs/readiness */
export interface ReadinessRequest {
  targets: { asg: AsgRef; capacity: CapacitySettings }[];
}

// ---------------------------------------------------------------------------
// Scale events (live match, sale, launch...)
// ---------------------------------------------------------------------------

export type ScaleEventStatus =
  | 'scheduled'
  | 'scaling-up'
  | 'active'
  | 'scaling-down'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TargetState = 'pending' | 'scaled' | 'failed' | 'reverted' | 'revert-failed' | 'skipped';

/** How the scale-up actually went for one ASG, measured from its scaling activities. */
export interface TargetReport {
  launches: number;
  failedLaunches: number;
  /** Seconds from scale-up until the last new instance finished launching. */
  readyAfterSeconds?: number;
}

export interface ScaleTarget {
  asg: AsgRef;
  target: CapacitySettings;
  /** Captured just before scale-up; used to scale back when the event ends. */
  baseline?: CapacitySettings;
  state: TargetState;
  message?: string;
  report?: TargetReport;
}

/** Post-event summary, written when the event ends. */
export interface EventReport {
  extraInstanceHours: number;
  launches: number;
  failedLaunches: number;
  slowestReadySeconds?: number;
}

export interface TimelineEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface ScaleEvent {
  tenantId: string;
  eventId: string;
  name: string; // e.g. "IPL final", "Diwali sale"
  targets: ScaleTarget[];
  /** When capacity must be ready (traffic starts). */
  startsAt: string;
  /** Scale-up begins this many minutes before startsAt. */
  prescaleMinutes: number;
  /** When the event ends and capacity goes back to baseline. */
  endsAt: string;
  status: ScaleEventStatus;
  timeline: TimelineEntry[];
  /** When scale-up actually ran. */
  scaledUpAt?: string;
  report?: EventReport;
  createdBy: string;
  createdAt: string;
}

/** POST /scale-events */
export interface CreateScaleEventRequest {
  name: string;
  startsAt: string;
  endsAt: string;
  prescaleMinutes?: number; // default 30
  targets: { asg: AsgRef; target: CapacitySettings }[];
}

// ---------------------------------------------------------------------------
// Recurring schedules (e.g. non-prod off nights and weekends)
// ---------------------------------------------------------------------------

export type Weekday = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';
export const WEEKDAYS: Weekday[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export interface ScheduleTarget {
  asg: AsgRef;
  /** Capacity captured when the schedule switched the ASG off; restored when it switches back on. */
  baseline?: CapacitySettings;
  state: 'on' | 'off' | 'error';
  message?: string;
}

export interface ScaleSchedule {
  tenantId: string;
  scheduleId: string;
  name: string; // e.g. "Staging off-hours"
  targets: ScheduleTarget[];
  timezone: string; // IANA, e.g. Asia/Kolkata
  /** Days the ASGs run. They are off outside onAt-offAt on these days, and all day on other days. */
  days: Weekday[];
  onAt: string; // HH:MM
  offAt: string; // HH:MM
  timeline: TimelineEntry[];
  createdBy: string;
  createdAt: string;
}

/** POST /schedules */
export interface CreateScheduleRequest {
  name: string;
  timezone: string;
  days: Weekday[];
  onAt: string;
  offAt: string;
  asgs: AsgRef[];
}

/** Share of the week a schedule keeps ASGs off (0-1). Used for the savings estimate. */
export function offShareOfWeek(days: Weekday[], onAt: string, offAt: string): number {
  const minutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const onPerDay = Math.max(0, minutes(offAt) - minutes(onAt));
  const onPerWeek = onPerDay * new Set(days).size;
  return 1 - onPerWeek / (7 * 24 * 60);
}

// ---------------------------------------------------------------------------
// Workspace settings: notifications and integrations
// ---------------------------------------------------------------------------

export interface NotifyOn {
  eventStarted: boolean;
  eventCompleted: boolean;
  failures: boolean;
  leftovers: boolean;
  approvals: boolean;
}

export type DevOpsAgentAuth = 'hmac' | 'bearer';

/** Stored settings. Secrets never leave the API; the browser gets a SettingsView. */
export interface WorkspaceSettings {
  tenantId: string;
  slackWebhookUrl?: string;
  emailRecipients: string[];
  devopsAgent?: { webhookUrl: string; auth: DevOpsAgentAuth; secret: string };
  notifyOn: NotifyOn;
  /** Manual scale-ups older than this are flagged as possibly forgotten. */
  leftoverHours: number;
  updatedAt?: string;
  updatedBy?: string;
}

/** GET /settings */
export interface SettingsView {
  slack: { configured: boolean; hint?: string };
  email: { available: boolean; recipients: string[] };
  devopsAgent: { configured: boolean; auth?: DevOpsAgentAuth; hint?: string };
  notifyOn: NotifyOn;
  leftoverHours: number;
}

/** PUT /settings. Omit a field to keep it, send null to remove it. */
export interface UpdateSettingsRequest {
  slackWebhookUrl?: string | null;
  emailRecipients?: string[];
  devopsAgent?: { webhookUrl: string; auth: DevOpsAgentAuth; secret: string } | null;
  notifyOn?: Partial<NotifyOn>;
  leftoverHours?: number;
}

export const DEFAULT_NOTIFY_ON: NotifyOn = {
  eventStarted: true,
  eventCompleted: true,
  failures: true,
  leftovers: true,
  approvals: true,
};

// ---------------------------------------------------------------------------
// Insights: capacity left behind and idle fleets
// ---------------------------------------------------------------------------

export type InsightType = 'manual-scale-not-reverted' | 'idle';

export interface Insight {
  id: string; // type:asgKey, stable across sweeps
  type: InsightType;
  asg: AsgRef;
  title: string;
  detail: string;
  since?: string;
  /** Rough instance-hours spent on the extra/idle capacity so far. */
  instanceHours?: number;
}

export interface InsightsReport {
  tenantId: string;
  generatedAt: string;
  insights: Insight[];
  errors: { accountId: string; region?: string; message: string }[];
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type AuditAction =
  | 'account.connected'
  | 'account.disconnected'
  | 'asg.capacity-changed'
  | 'scale-event.created'
  | 'scale-event.approved'
  | 'scale-event.started'
  | 'scale-event.completed'
  | 'scale-event.failed'
  | 'scale-event.cancelled'
  | 'schedule.created'
  | 'schedule.deleted'
  | 'schedule.switched-off'
  | 'schedule.switched-on'
  | 'settings.updated'
  | 'devops-agent.investigation-sent'
  | 'account.updated'
  | 'member.invited'
  | 'member.joined'
  | 'member.role-changed'
  | 'member.removed'
  | 'invite.revoked'
  | 'approval.requested'
  | 'approval.approved'
  | 'approval.rejected'
  | 'approval.cancelled'
  | 'approval.break-glass';

export interface AuditEntry {
  tenantId: string;
  auditId: string;
  at: string;
  actor: { userId: string; email: string } | 'system';
  action: AuditAction;
  asg?: AsgRef;
  accountId?: string;
  before?: CapacitySettings;
  after?: CapacitySettings;
  result: 'success' | 'failure';
  message?: string;
}

/** GET /audit */
export interface AuditPage {
  entries: AuditEntry[];
  nextCursor?: string;
}

// ---------------------------------------------------------------------------
// Small helpers used on both sides
// ---------------------------------------------------------------------------

/** One string key per ASG, handy for maps and DynamoDB sort keys. */
export function asgKey(ref: AsgRef): string {
  return `${ref.accountId}#${ref.region}#${ref.asgName}`;
}

/** Returns an error message, or null when the capacity is valid. */
export function validateCapacity(c: CapacitySettings): string | null {
  const values = [c.min, c.desired, c.max];
  if (values.some((v) => !Number.isInteger(v) || v < 0)) {
    return 'Capacity values must be whole numbers of 0 or more.';
  }
  if (c.min > c.desired || c.desired > c.max) {
    return 'Capacity must satisfy min <= desired <= max.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Team: members and invites
// ---------------------------------------------------------------------------

export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'revoked';

export interface Invite {
  inviteId: string;
  tenantId: string;
  email: string; // lower case
  role: UserRole;
  clientIds?: string[];
  invitedBy: { userId: string; email: string };
  createdAt: string;
  expiresAt: string;
  status: InviteStatus;
}

export interface CreateInviteRequest {
  email: string;
  role: UserRole;
  clientIds?: string[];
}

export interface Member extends Membership {
  joinedAt?: string;
}

/** GET /members. Invites are only listed for owners and admins. */
export interface TeamView {
  members: Member[];
  invites: Invite[];
  maxUsers: number | null;
}

/** POST /members/invites response. `link` is what to send when email isn't set up. */
export interface CreateInviteResponse {
  invite: Invite;
  link: string;
  emailed: boolean;
}

// ---------------------------------------------------------------------------
// Approvals: two-person rule for accounts marked requireApproval
// ---------------------------------------------------------------------------

export type ApprovalKind = 'capacity' | 'scale-event' | 'schedule';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'failed';

export interface ApprovalRequest {
  requestId: string;
  tenantId: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  summary: string; // one line, e.g. "Scale web (Prod) to 4/8/12"
  details: string[];
  accountIds: string[];
  payload: CapacityChangeRequest | CreateScaleEventRequest | CreateScheduleRequest;
  requestedBy: { userId: string; email: string };
  requestedAt: string;
  expiresAt: string;
  decidedBy?: { userId: string; email: string };
  decidedAt?: string;
  note?: string;
  /** An owner applied their own request without a second person, with a reason. */
  breakGlass?: boolean;
  /** What happened when it was applied, or why it failed. */
  result?: string;
}

/** POST /approvals/{id}/approve | reject | cancel body. */
export interface ApprovalDecisionRequest {
  note?: string;
  /** Owners only, on their own request: apply without a second approver. Min 10 characters. */
  breakGlassReason?: string;
}

/** Returned with HTTP 202 when a change was sent for approval instead of applied. */
export interface PendingApprovalResponse {
  approval: ApprovalRequest;
}
