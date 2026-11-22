
export type LifecycleType = 'spot' | 'on-demand';

export interface InstanceMetrics {
  type: string;
  lifecycle: LifecycleType;
  count: number;
}

export interface ASG {
  id: string;
  name: string;
  region: string;
  metrics: InstanceMetrics[];
}

export interface AWSAccount {
  id: string;
  name: string;
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

export interface AuthState {
  isAuthenticated: boolean;
  user: string | null;
}
