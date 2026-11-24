/**
 * ECS services: list, read and write capacity.
 *
 * Capacity maps onto the same min/desired/max as an ASG:
 * - desired = the service's desiredCount
 * - min/max = the Application Auto Scaling target, when there is one. Without a target,
 *   min = max = desired and only the desired count is changed.
 */
import {
  ApplicationAutoScalingClient,
  DescribeScalableTargetsCommand,
  RegisterScalableTargetCommand,
  type ScalableTarget,
} from '@aws-sdk/client-application-auto-scaling';
import {
  DescribeServicesCommand,
  ECSClient,
  paginateListClusters,
  paginateListServices,
  UpdateServiceCommand,
  type Service,
} from '@aws-sdk/client-ecs';
import type { AwsAccount, CapacitySettings, EcsServiceSummary } from '@cloud-ops/shared';
import type { TempCredentials } from './aws.js';

const DIMENSION = 'ecs:service:DesiredCount';
const MAX_CLUSTERS = 50;
const MAX_SERVICES = 500;

export const resourceId = (cluster: string, service: string) => `service/${cluster}/${service}`;
const nameOf = (arn: string) => arn.split('/').pop()!;

export interface EcsClients {
  ecs: ECSClient;
  aas: ApplicationAutoScalingClient;
}

export function ecsClients(region: string, credentials: TempCredentials): EcsClients {
  return { ecs: new ECSClient({ region, credentials }), aas: new ApplicationAutoScalingClient({ region, credentials }) };
}

export async function describeService(c: EcsClients, cluster: string, service: string): Promise<Service> {
  const res = await c.ecs.send(new DescribeServicesCommand({ cluster, services: [service], include: ['TAGS'] }));
  const s = res.services?.[0];
  if (!s || s.status === 'INACTIVE') throw new Error(`ECS service ${cluster}/${service} not found`);
  return s;
}

export async function describeTarget(c: EcsClients, cluster: string, service: string): Promise<ScalableTarget | undefined> {
  const res = await c.aas.send(
    new DescribeScalableTargetsCommand({ ServiceNamespace: 'ecs', ScalableDimension: DIMENSION, ResourceIds: [resourceId(cluster, service)] }),
  );
  return res.ScalableTargets?.[0];
}

function capacityOf(s: Service, t: ScalableTarget | undefined): CapacitySettings {
  const desired = s.desiredCount ?? 0;
  return t ? { min: t.MinCapacity ?? 0, desired, max: t.MaxCapacity ?? desired } : { min: desired, desired, max: desired };
}

export async function readEcs(c: EcsClients, cluster: string, service: string): Promise<CapacitySettings> {
  const [s, t] = await Promise.all([describeService(c, cluster, service), describeTarget(c, cluster, service)]);
  return capacityOf(s, t);
}

/** Moves the auto scaling range first, so App Auto Scaling doesn't pull desired back inside the old range. */
export async function writeEcs(c: EcsClients, cluster: string, service: string, cap: CapacitySettings): Promise<void> {
  const target = await describeTarget(c, cluster, service);
  if (target) {
    await c.aas.send(
      new RegisterScalableTargetCommand({
        ServiceNamespace: 'ecs',
        ScalableDimension: DIMENSION,
        ResourceId: resourceId(cluster, service),
        MinCapacity: cap.min,
        MaxCapacity: cap.max,
      }),
    );
  }
  await c.ecs.send(new UpdateServiceCommand({ cluster, service, desiredCount: cap.desired }));
}

export function launchTypeOf(s: Service): string {
  if (s.launchType) return s.launchType;
  const providers = (s.capacityProviderStrategy ?? []).map((p) => p.capacityProvider).filter(Boolean);
  return providers.length ? providers.join(' + ') : 'EC2';
}

export const usesFargate = (s: Service) => /FARGATE/.test(launchTypeOf(s));

export async function listEcsInRegion(account: AwsAccount, region: string, credentials: TempCredentials): Promise<EcsServiceSummary[]> {
  const c = ecsClients(region, credentials);
  const clusters: string[] = [];
  for await (const page of paginateListClusters({ client: c.ecs }, {})) {
    clusters.push(...(page.clusterArns ?? []));
    if (clusters.length >= MAX_CLUSTERS) break;
  }

  const services: Service[] = [];
  for (const clusterArn of clusters.slice(0, MAX_CLUSTERS)) {
    const arns: string[] = [];
    for await (const page of paginateListServices({ client: c.ecs }, { cluster: clusterArn })) {
      arns.push(...(page.serviceArns ?? []));
      if (services.length + arns.length >= MAX_SERVICES) break;
    }
    for (let i = 0; i < arns.length; i += 10) {
      const res = await c.ecs.send(new DescribeServicesCommand({ cluster: clusterArn, services: arns.slice(i, i + 10), include: ['TAGS'] }));
      services.push(...(res.services ?? []).filter((s) => s.status !== 'INACTIVE'));
    }
    if (services.length >= MAX_SERVICES) break;
  }

  const targets = new Map<string, ScalableTarget>();
  const ids = services.map((s) => resourceId(nameOf(s.clusterArn!), s.serviceName!));
  for (let i = 0; i < ids.length; i += 50) {
    const res = await c.aas.send(new DescribeScalableTargetsCommand({ ServiceNamespace: 'ecs', ScalableDimension: DIMENSION, ResourceIds: ids.slice(i, i + 50) }));
    for (const t of res.ScalableTargets ?? []) targets.set(t.ResourceId!, t);
  }

  return services.map((s) => {
    const cluster = nameOf(s.clusterArn!);
    const target = targets.get(resourceId(cluster, s.serviceName!));
    return {
      accountId: account.accountId,
      region,
      kind: 'ecs' as const,
      cluster,
      asgName: s.serviceName!,
      arn: s.serviceArn!,
      capacity: capacityOf(s, target),
      runningCount: s.runningCount ?? 0,
      pendingCount: s.pendingCount ?? 0,
      launchType: launchTypeOf(s),
      autoscaling: !!target,
      managedByCloudOps: (s.tags ?? []).some((t) => t.key === 'CloudOpsManaged' && t.value === 'true'),
      status: s.status ?? 'ACTIVE',
    };
  });
}
