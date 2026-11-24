/**
 * Pre-flight checks before capacity goes up: the things that make scale-outs fail
 * at the worst moment (quota, AZ offerings, single instance type, suspended processes...).
 * Every check is isolated, so one failing AWS call becomes a "warn", never a crash.
 */
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  DescribeLaunchConfigurationsCommand,
  DescribeScalingActivitiesCommand,
  type AutoScalingGroup,
} from '@aws-sdk/client-auto-scaling';
import {
  DescribeInstanceTypeOfferingsCommand,
  DescribeInstanceTypesCommand,
  DescribeLaunchTemplateVersionsCommand,
  EC2Client,
  paginateDescribeInstances,
} from '@aws-sdk/client-ec2';
import { GetServiceQuotaCommand, ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import {
  validateCapacity,
  type AsgRef,
  type CapacitySettings,
  type ReadinessCheck,
  type ReadinessResult,
} from '@cloud-ops/shared';
import { checkEcsReadiness } from './ecs-readiness.js';
import type { TempCredentials } from './aws.js';

/** On-Demand vCPU quota buckets we know the codes for. Other families are reported as "not checked". */
const QUOTA_BUCKETS: { name: string; code: string; match: RegExp }[] = [
  { name: 'Standard (A, C, D, H, I, M, R, T, Z)', code: 'L-1216C47A', match: /^(a|c|d|h|i|m|r|t|z)\d/ },
  { name: 'G and VT', code: 'L-DB2E81BA', match: /^(g|vt)\d/ },
  { name: 'P', code: 'L-417A185B', match: /^p\d/ },
];

export async function checkReadiness(
  credentials: TempCredentials,
  asg: AsgRef,
  target: CapacitySettings,
): Promise<ReadinessResult> {
  if (asg.kind === 'ecs') return checkEcsReadiness(credentials, asg, target);
  const checks: ReadinessCheck[] = [];
  const add = (c: ReadinessCheck) => checks.push(c);
  const region = asg.region;
  const autoscaling = new AutoScalingClient({ region, credentials });
  const ec2 = new EC2Client({ region, credentials });

  const found = await autoscaling.send(
    new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asg.asgName] }),
  );
  const group = found.AutoScalingGroups?.[0];
  if (!group) {
    add({ id: 'exists', status: 'fail', title: 'ASG not found', detail: `${asg.asgName} doesn't exist in ${region}.` });
    return { asg, checks };
  }
  const current: CapacitySettings = {
    min: group.MinSize ?? 0,
    desired: group.DesiredCapacity ?? 0,
    max: group.MaxSize ?? 0,
  };

  const invalid = validateCapacity(target);
  if (invalid) add({ id: 'capacity', status: 'fail', title: 'Invalid capacity', detail: invalid });

  const increase = Math.max(0, target.desired - current.desired);
  const isScaleUp = increase > 0;

  // 1. Suspended processes
  const suspended = (group.SuspendedProcesses ?? []).map((p) => p.ProcessName ?? '');
  if (suspended.includes('Launch') && isScaleUp) {
    add({ id: 'suspended', status: 'fail', title: 'Launch is suspended', detail: 'The ASG will not launch new instances until the Launch process is resumed.' });
  } else if (suspended.length > 0) {
    add({ id: 'suspended', status: 'warn', title: 'Some scaling processes are suspended', detail: suspended.join(', ') });
  } else {
    add({ id: 'suspended', status: 'pass', title: 'No suspended processes', detail: 'All scaling processes are active.' });
  }

  // 2. Big jumps stress dependencies (DB connections, caches, load balancers)
  if (target.desired > 5 * Math.max(1, current.desired)) {
    add({
      id: 'jump',
      status: 'warn',
      title: `Large jump: ${current.desired} → ${target.desired}`,
      detail: 'Make sure databases, caches and load balancers can take this many new instances at once.',
    });
  }

  // 3. Instance types, AZ offerings, diversity
  let types: string[] = [];
  try {
    types = await resolveInstanceTypes(group, autoscaling, ec2);
  } catch (err) {
    add({ id: 'types', status: 'warn', title: "Couldn't read instance types", detail: (err as Error).message });
  }

  const azs = group.AvailabilityZones ?? [];
  if (azs.length === 1) {
    add({ id: 'az-count', status: 'warn', title: 'Only one Availability Zone', detail: `If ${azs[0]} runs short of capacity, there's nowhere else to launch. Add subnets in more AZs.` });
  }

  if (types.length > 0) {
    if (types.length === 1) {
      add({
        id: 'diversity',
        status: 'warn',
        title: `Single instance type (${types[0]})`,
        detail: 'A capacity shortage in this one type can block the scale-out. Add 2-3 similar types with a mixed instances policy.',
      });
    } else {
      add({ id: 'diversity', status: 'pass', title: `${types.length} instance types`, detail: types.join(', ') });
    }

    try {
      const offered = await offeringsByAz(ec2, types, azs);
      const missing = azs.filter((az) => (offered.get(az)?.size ?? 0) === 0);
      if (missing.length === azs.length && azs.length > 0) {
        add({ id: 'az-offering', status: 'fail', title: 'Instance type not offered in any ASG zone', detail: `${types.join(', ')} isn't offered in ${azs.join(', ')}.` });
      } else if (missing.length > 0) {
        add({
          id: 'az-offering',
          status: 'warn',
          title: `Not offered in ${missing.join(', ')}`,
          detail: `${types.join(', ')} can't launch there. The ASG will retry in other zones, but it wastes time during a scale-out. Remove those subnets or add instance types that zone offers.`,
        });
      } else {
        add({ id: 'az-offering', status: 'pass', title: 'Offered in every ASG zone', detail: azs.join(', ') });
      }
    } catch (err) {
      add({ id: 'az-offering', status: 'warn', title: "Couldn't check zone offerings", detail: (err as Error).message });
    }

    // 4. vCPU quota headroom (On-Demand part of the increase)
    if (isScaleUp) {
      try {
        add(await quotaCheck(credentials, ec2, region, group, types, increase));
      } catch (err) {
        add({ id: 'vcpu-quota', status: 'warn', title: "Couldn't check vCPU quota", detail: (err as Error).message });
      }
    }
  } else if (group.MixedInstancesPolicy?.LaunchTemplate?.Overrides?.some((o) => o.InstanceRequirements)) {
    add({ id: 'types', status: 'warn', title: 'Attribute-based instance selection', detail: 'Instance types are chosen by attributes, so zone and quota checks were skipped.' });
  }

  // 5. Recent launch failures
  try {
    const activities = await autoscaling.send(
      new DescribeScalingActivitiesCommand({ AutoScalingGroupName: asg.asgName, MaxRecords: 20 }),
    );
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const failed = (activities.Activities ?? []).filter(
      (a) => a.StatusCode === 'Failed' && a.StartTime && a.StartTime.getTime() > dayAgo,
    );
    if (failed.length > 0) {
      add({
        id: 'recent-failures',
        status: 'warn',
        title: `${failed.length} failed scaling ${failed.length === 1 ? 'activity' : 'activities'} in the last 24h`,
        detail: (failed[0].StatusMessage ?? failed[0].Description ?? '').slice(0, 300),
      });
    } else {
      add({ id: 'recent-failures', status: 'pass', title: 'No failed launches in the last 24h', detail: 'Scaling activity history is clean.' });
    }
  } catch (err) {
    add({ id: 'recent-failures', status: 'warn', title: "Couldn't read scaling activities", detail: (err as Error).message });
  }

  return { asg, current, checks };
}

/** Instance types from the mixed instances policy, launch template, launch config, or running instances. */
async function resolveInstanceTypes(
  group: AutoScalingGroup,
  autoscaling: AutoScalingClient,
  ec2: EC2Client,
): Promise<string[]> {
  const fromOverrides = (group.MixedInstancesPolicy?.LaunchTemplate?.Overrides ?? [])
    .map((o) => o.InstanceType)
    .filter((t): t is string => !!t);
  if (fromOverrides.length > 0) return [...new Set(fromOverrides)];

  const spec = group.LaunchTemplate ?? group.MixedInstancesPolicy?.LaunchTemplate?.LaunchTemplateSpecification;
  if (spec && (spec.LaunchTemplateId || spec.LaunchTemplateName)) {
    const res = await ec2.send(
      new DescribeLaunchTemplateVersionsCommand({
        LaunchTemplateId: spec.LaunchTemplateId,
        LaunchTemplateName: spec.LaunchTemplateId ? undefined : spec.LaunchTemplateName,
        Versions: [spec.Version ?? '$Default'],
      }),
    );
    const type = res.LaunchTemplateVersions?.[0]?.LaunchTemplateData?.InstanceType;
    if (type) return [type];
  }

  if (group.LaunchConfigurationName) {
    const res = await autoscaling.send(
      new DescribeLaunchConfigurationsCommand({ LaunchConfigurationNames: [group.LaunchConfigurationName] }),
    );
    const type = res.LaunchConfigurations?.[0]?.InstanceType;
    if (type) return [type];
  }

  return [...new Set((group.Instances ?? []).map((i) => i.InstanceType).filter((t): t is string => !!t))];
}

async function offeringsByAz(ec2: EC2Client, types: string[], azs: string[]): Promise<Map<string, Set<string>>> {
  const res = await ec2.send(
    new DescribeInstanceTypeOfferingsCommand({
      LocationType: 'availability-zone',
      Filters: [
        { Name: 'instance-type', Values: types },
        { Name: 'location', Values: azs },
      ],
    }),
  );
  const map = new Map<string, Set<string>>();
  for (const o of res.InstanceTypeOfferings ?? []) {
    if (!o.Location || !o.InstanceType) continue;
    if (!map.has(o.Location)) map.set(o.Location, new Set());
    map.get(o.Location)!.add(o.InstanceType);
  }
  return map;
}

async function vcpusFor(ec2: EC2Client, types: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const unique = [...new Set(types)];
  for (let i = 0; i < unique.length; i += 100) {
    const res = await ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: unique.slice(i, i + 100) as never }));
    for (const t of res.InstanceTypes ?? []) {
      if (t.InstanceType) map.set(t.InstanceType, t.VCpuInfo?.DefaultVCpus ?? 0);
    }
  }
  return map;
}

async function quotaCheck(
  credentials: TempCredentials,
  ec2: EC2Client,
  region: string,
  group: AutoScalingGroup,
  types: string[],
  increase: number,
): Promise<ReadinessCheck> {
  const bucket = QUOTA_BUCKETS.find((b) => b.match.test(types[0]));
  if (!bucket) {
    return { id: 'vcpu-quota', status: 'warn', title: 'vCPU quota not checked', detail: `Quota check doesn't cover the ${types[0]} family yet.` };
  }

  // Only the On-Demand share of new instances counts against the On-Demand quota.
  const onDemandPct = group.MixedInstancesPolicy?.InstancesDistribution?.OnDemandPercentageAboveBaseCapacity ?? 100;
  const onDemandIncrease = Math.ceil((increase * onDemandPct) / 100);
  const vcpuMap = await vcpusFor(ec2, types);
  const perInstance = Math.max(...types.map((t) => vcpuMap.get(t) ?? 0));
  const needed = onDemandIncrease * perInstance;

  // vCPUs already used by running On-Demand instances in the same bucket
  const runningTypes: string[] = [];
  for await (const page of paginateDescribeInstances(
    { client: ec2 },
    { Filters: [{ Name: 'instance-state-name', Values: ['pending', 'running'] }] },
  )) {
    for (const r of page.Reservations ?? []) {
      for (const inst of r.Instances ?? []) {
        if (inst.InstanceLifecycle === 'spot' || !inst.InstanceType) continue;
        if (bucket.match.test(inst.InstanceType)) runningTypes.push(inst.InstanceType);
      }
    }
  }
  const runningVcpuMap = await vcpusFor(ec2, runningTypes.length ? runningTypes : types);
  const used = runningTypes.reduce((sum, t) => sum + (runningVcpuMap.get(t) ?? 0), 0);

  const quotas = new ServiceQuotasClient({ region, credentials });
  const quota = await quotas.send(new GetServiceQuotaCommand({ ServiceCode: 'ec2', QuotaCode: bucket.code }));
  const limit = quota.Quota?.Value ?? 0;
  const headroom = limit - used;
  const summary = `Needs ${needed} more vCPUs. ${used} of ${limit} already used (${bucket.name} On-Demand), ${Math.max(0, headroom)} left.`;

  if (needed > headroom) {
    return { id: 'vcpu-quota', status: 'fail', title: 'Not enough vCPU quota', detail: `${summary} Request a quota increase before the event.` };
  }
  if (needed > 0.8 * headroom) {
    return { id: 'vcpu-quota', status: 'warn', title: 'vCPU quota is tight', detail: `${summary} Consider requesting an increase.` };
  }
  return { id: 'vcpu-quota', status: 'pass', title: 'Enough vCPU quota', detail: summary };
}
