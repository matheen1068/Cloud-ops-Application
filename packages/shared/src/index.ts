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
  lastCheckedAt?: string;
  lastError?: string;
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

/** "Scale now" request from the UI. */
export interface CapacityChangeRequest {
  asg: AsgRef;
  capacity: CapacitySettings;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Scale events (live match, sale, launch...)
// ---------------------------------------------------------------------------

export type ScaleEventStatus =
  | 'draft'
  | 'pending-approval'
  | 'scheduled'
  | 'scaling-up'
  | 'active'
  | 'scaling-down'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ScaleTarget {
  asg: AsgRef;
  target: CapacitySettings;
  /** Captured just before scale-up; used to scale back when the event ends. */
  baseline?: CapacitySettings;
}

export interface ScaleEvent {
  tenantId: string;
  eventId: string;
  name: string; // e.g. "IPL final", "Diwali sale"
  description?: string;
  targets: ScaleTarget[];
  startsAt: string;
  endsAt: string;
  revertOnEnd: boolean;
  requiresApproval: boolean;
  approvedBy?: string;
  status: ScaleEventStatus;
  createdBy: string;
  createdAt: string;
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
  | 'scale-event.failed';

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
