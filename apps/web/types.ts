// UI view models. Built from the API responses in lib/adapters.ts so the
// existing components (dashboard, balancer, advisor) keep working.
import type { AccessLevel, CapacitySettings } from '@cloud-ops/shared';

export type LifecycleType = 'spot' | 'on-demand';

export interface InstanceMetrics {
  type: string;
  lifecycle: LifecycleType;
  count: number;
}

export interface ASG {
  id: string; // accountId#region#name
  name: string;
  region: string;
  accountId: string;
  capacity: CapacitySettings;
  inService: number;
  managed: boolean; // tagged CloudOpsManaged=true
  metrics: InstanceMetrics[];
}

export interface AWSAccount {
  id: string;
  name: string;
  accessLevel: AccessLevel;
  regions: string[];
  asgs: ASG[];
}

export interface HistoricalData {
  timestamp: string;
  spot: number;
  onDemand: number;
}

export interface Recommendation {
  id: string;
  title: string;
  description: string;
  potentialSavings: string;
  priority: 'low' | 'medium' | 'high';
}
