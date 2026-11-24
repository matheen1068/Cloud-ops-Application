// Pre-flight checks for scaling an ECS service: the ECS counterpart of readiness.ts.
import { DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs';
import { GetServiceQuotaCommand, ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import type { AsgRef, CapacitySettings, ReadinessCheck, ReadinessResult } from '@cloud-ops/shared';
import type { TempCredentials } from './aws.js';
import { describeService, describeTarget, ecsClients, launchTypeOf, usesFargate } from './ecs.js';

const FARGATE_ON_DEMAND_VCPU = 'L-3032A538';
const PLACEMENT_PROBLEM = /unable to place|insufficient|no container instances|reached the limit/i;

export async function checkEcsReadiness(credentials: TempCredentials, ref: AsgRef, target: CapacitySettings): Promise<ReadinessResult> {
  const checks: ReadinessCheck[] = [];
  const add = (c: ReadinessCheck) => checks.push(c);
  const c = ecsClients(ref.region, credentials);
  const cluster = ref.cluster ?? '';

  let service;
  try {
    service = await describeService(c, cluster, ref.asgName);
  } catch (err) {
    return { asg: ref, checks: [{ id: 'service', status: 'fail', title: 'Service not found', detail: (err as Error).message }] };
  }
  const scalable = await describeTarget(c, cluster, ref.asgName);
  const current: CapacitySettings = scalable
    ? { min: scalable.MinCapacity ?? 0, desired: service.desiredCount ?? 0, max: scalable.MaxCapacity ?? 0 }
    : { min: service.desiredCount ?? 0, desired: service.desiredCount ?? 0, max: service.desiredCount ?? 0 };
  const extra = target.desired - current.desired;

  if (!scalable && (target.min !== target.desired || target.max !== target.desired)) {
    add({
      id: 'no-autoscaling',
      status: 'warn',
      title: 'No auto scaling target',
      detail: `This service has no Application Auto Scaling target, so only the desired count changes (to ${target.desired}). Min and max are ignored.`,
    });
  }
  const suspended = scalable?.SuspendedState;
  if (suspended?.DynamicScalingInSuspended || suspended?.DynamicScalingOutSuspended || suspended?.ScheduledScalingSuspended) {
    add({ id: 'suspended', status: 'warn', title: 'Auto scaling is suspended', detail: 'Scaling policies on this service are suspended, so it will not react to load on its own.' });
  }

  if (usesFargate(service) && extra > 0 && service.taskDefinition) {
    try {
      const td = await c.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: service.taskDefinition }));
      const vcpu = Number(td.taskDefinition?.cpu ?? 0) / 1024;
      const quota = (await new ServiceQuotasClient({ region: ref.region, credentials }).send(
        new GetServiceQuotaCommand({ ServiceCode: 'fargate', QuotaCode: FARGATE_ON_DEMAND_VCPU }),
      )).Quota?.Value;
      if (vcpu > 0 && quota) {
        const need = Math.round(target.desired * vcpu * 100) / 100;
        const status = need > quota ? 'fail' : need > quota * 0.8 ? 'warn' : 'pass';
        add({
          id: 'fargate-quota',
          status,
          title: status === 'pass' ? 'Fargate vCPU quota' : 'Fargate vCPU quota is tight',
          detail: `${target.desired} tasks × ${vcpu} vCPU = ${need} vCPU for this service. The account's Fargate On-Demand quota in ${ref.region} is ${quota} vCPU, shared with every other Fargate task.`,
        });
      }
    } catch (err) {
      add({ id: 'fargate-quota', status: 'warn', title: "Couldn't check the Fargate quota", detail: (err as Error).message });
    }
  } else if (!usesFargate(service) && extra > 0) {
    add({
      id: 'ec2-capacity',
      status: 'warn',
      title: 'Tasks run on EC2 instances',
      detail: `Make sure the cluster's capacity (${launchTypeOf(service)}) can place ${extra} more tasks. Scale its Auto Scaling group in the same event if needed.`,
    });
  }

  const deployments = service.deployments ?? [];
  if (deployments.some((d) => d.rolloutState === 'FAILED')) {
    add({ id: 'deployment', status: 'warn', title: 'Last deployment failed', detail: 'Fix the deployment first; new tasks may fail to start.' });
  } else if (deployments.length > 1) {
    add({ id: 'deployment', status: 'warn', title: 'A deployment is in progress', detail: 'New tasks will start from the deployment that is rolling out.' });
  }

  const dayAgo = Date.now() - 86_400_000;
  const placement = (service.events ?? []).find((e) => e.createdAt && e.createdAt.getTime() > dayAgo && PLACEMENT_PROBLEM.test(e.message ?? ''));
  if (placement) add({ id: 'placement', status: 'warn', title: 'Task placement problems in the last 24h', detail: placement.message ?? '' });

  if ((current.desired > 0 && target.desired > current.desired * 3) || (current.desired === 0 && target.desired >= 10)) {
    add({ id: 'jump', status: 'warn', title: 'Large jump', detail: `${current.desired} → ${target.desired} tasks at once. Consider a longer pre-scale window.` });
  }
  if (!checks.some((x) => x.status !== 'pass')) {
    add({ id: 'service', status: 'pass', title: 'Service looks ready', detail: `${service.runningCount ?? 0} running, ${launchTypeOf(service)}.` });
  }
  return { asg: ref, current, checks };
}
