import { asgKey, type AutoScalingGroupSummary, type AwsAccount } from '@cloud-ops/shared';
import type { AWSAccount, InstanceMetrics } from '../types';

/** Groups the API's flat ASG list under each connected account. */
export function toUiAccounts(accounts: AwsAccount[], asgs: AutoScalingGroupSummary[]): AWSAccount[] {
  return accounts
    .filter((a) => a.status === 'connected')
    .map((account) => ({
      id: account.accountId,
      name: account.alias,
      accessLevel: account.accessLevel,
      regions: account.regions,
      requireApproval: account.requireApproval,
      asgs: asgs
        .filter((g) => g.accountId === account.accountId)
        .map((g) => {
          const types = g.instanceTypes.join(', ') || 'none';
          const metrics: InstanceMetrics[] = [
            { type: types, lifecycle: 'on-demand' as const, count: g.onDemandInstances },
            { type: types, lifecycle: 'spot' as const, count: g.spotInstances },
          ].filter((m) => m.count > 0);
          return {
            id: asgKey(g),
            name: g.asgName,
            region: g.region,
            accountId: g.accountId,
            capacity: g.capacity,
            inService: g.inServiceInstances,
            managed: g.managedByCloudOps,
            metrics,
          };
        }),
    }));
}
