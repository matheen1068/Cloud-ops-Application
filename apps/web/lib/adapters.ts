import { asgKey, type AsgRef, type AutoScalingGroupSummary, type AwsAccount, type ListEcsResponse } from '@cloud-ops/shared';
import type { ASG, AWSAccount, InstanceMetrics } from '../types';

/** The API ref for a UI ASG or ECS service. */
export function refOf(g: ASG): AsgRef {
  return g.kind === 'ecs'
    ? { accountId: g.accountId, region: g.region, asgName: g.name, kind: 'ecs', cluster: g.cluster }
    : { accountId: g.accountId, region: g.region, asgName: g.name };
}

/** cluster/service for ECS, the name for ASGs. */
export const labelOf = (g: ASG) => (g.kind === 'ecs' ? `${g.cluster}/${g.name}` : g.name);

/** Groups the API's flat ASG list under each connected account. */
export function toUiAccounts(accounts: AwsAccount[], asgs: AutoScalingGroupSummary[], ecs?: ListEcsResponse): AWSAccount[] {
  return accounts
    .filter((a) => a.status === 'connected')
    .map((account) => ({
      id: account.accountId,
      name: account.alias,
      accessLevel: account.accessLevel,
      regions: account.regions,
      ecsNotEnabled: ecs?.notEnabled.includes(account.accountId),
      services: (ecs?.services ?? [])
        .filter((s) => s.accountId === account.accountId)
        .map((s) => ({
          id: asgKey(s),
          name: s.asgName,
          region: s.region,
          accountId: s.accountId,
          capacity: s.capacity,
          inService: s.runningCount,
          managed: s.managedByCloudOps,
          metrics: [],
          kind: 'ecs' as const,
          cluster: s.cluster,
          autoscaling: s.autoscaling,
          launchType: s.launchType,
        })),
      requireApproval: account.requireApproval,
      clientId: account.clientId,
      connectionMethod: account.connectionMethod,
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
