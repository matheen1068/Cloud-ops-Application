/**
 * Insights: capacity people forgot about.
 *  - manual-scale-not-reverted: a Scale Now increase older than leftoverHours that's still in place
 *  - idle: an ASG with running instances whose CPU stayed very low for 24 hours
 * Runs every 6 hours for every workspace, and on demand from the Dashboard.
 */
import { AutoScalingClient, paginateDescribeAutoScalingGroups } from '@aws-sdk/client-auto-scaling';
import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import {
  asgKey,
  type AsgRef,
  type CapacitySettings,
  type Insight,
  type InsightsReport,
  type Tenant,
} from '@cloud-ops/shared';
import { ClientPool } from './capacity.js';
import { getInsightsReport, listAccounts, listAuditSince, listEvents, putInsightsReport } from './db.js';
import { notify } from './notify.js';
import { getSettings } from './settings.js';

const IDLE_AVG_CPU = 5; // %
const IDLE_MAX_CPU = 15; // %

export async function computeInsights(tenant: Tenant): Promise<InsightsReport> {
  const settings = await getSettings(tenant.tenantId);
  const report: InsightsReport = { tenantId: tenant.tenantId, generatedAt: new Date().toISOString(), insights: [], errors: [] };

  // Current capacity of every ASG we can see
  const current = new Map<string, { ref: AsgRef; capacity: CapacitySettings }>();
  const pool = new ClientPool(tenant);
  const accounts = (await listAccounts(tenant.tenantId)).filter((a) => a.status === 'connected');

  await Promise.all(
    accounts.flatMap((account) =>
      account.regions.map(async (region) => {
        try {
          const credentials = await pool.credentials(account);
          const client = new AutoScalingClient({ region, credentials });
          const inRegion: { ref: AsgRef; capacity: CapacitySettings }[] = [];
          for await (const page of paginateDescribeAutoScalingGroups({ client }, {})) {
            for (const g of page.AutoScalingGroups ?? []) {
              const ref = { accountId: account.accountId, region, asgName: g.AutoScalingGroupName ?? '' };
              const entry = { ref, capacity: { min: g.MinSize ?? 0, desired: g.DesiredCapacity ?? 0, max: g.MaxSize ?? 0 } };
              current.set(asgKey(ref), entry);
              inRegion.push(entry);
            }
          }
          report.insights.push(...(await idleInsights(new CloudWatchClient({ region, credentials }), inRegion)));
        } catch (err) {
          report.errors.push({ accountId: account.accountId, region, message: (err as Error).message });
        }
      }),
    ),
  );

  // ASGs in an active event are supposed to be scaled up
  const busy = new Set<string>();
  for (const e of await listEvents(tenant.tenantId)) {
    if (['scaling-up', 'active', 'scaling-down'].includes(e.status)) e.targets.forEach((t) => busy.add(asgKey(t.asg)));
  }

  // Manual scale-ups still in place: look at the latest successful manual change per ASG
  const since = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
  const latest = new Map<string, (typeof manual)[number]>();
  const manual = (await listAuditSince(tenant.tenantId, since)).filter(
    (a) => a.action === 'asg.capacity-changed' && a.result === 'success' && a.actor !== 'system' && a.asg && a.before && a.after,
  );
  for (const a of manual) latest.set(asgKey(a.asg!), a); // oldest first, so the last one wins

  const cutoff = Date.now() - settings.leftoverHours * 3600_000;
  for (const [key, a] of latest) {
    const now = current.get(key);
    if (!now || busy.has(key)) continue;
    const increased = a.after!.desired > a.before!.desired;
    const stillUp = now.capacity.desired >= a.after!.desired && now.capacity.desired > a.before!.desired;
    if (!increased || !stillUp || new Date(a.at).getTime() > cutoff) continue;
    const hours = (Date.now() - new Date(a.at).getTime()) / 3600_000;
    const extra = now.capacity.desired - a.before!.desired;
    const who = a.actor === 'system' ? 'Cloud-Ops' : a.actor.email;
    report.insights.push({
      id: `manual-scale-not-reverted:${key}`,
      type: 'manual-scale-not-reverted',
      asg: now.ref,
      title: `${now.ref.asgName} still scaled up after ${Math.round(hours)}h`,
      detail: `${who} scaled it ${a.before!.desired} → ${a.after!.desired} desired${a.message ? ` ("${a.message}")` : ''}. It's still at ${now.capacity.desired}. Scale back if the spike is over.`,
      since: a.at,
      instanceHours: Math.round(extra * hours),
    });
  }

  report.insights.sort((x, y) => (y.instanceHours ?? 0) - (x.instanceHours ?? 0));

  // Notify only about insights that weren't in the previous sweep
  const previous = new Set((await getInsightsReport(tenant.tenantId))?.insights.map((i) => i.id) ?? []);
  const fresh = report.insights.filter((i) => !previous.has(i.id));
  await putInsightsReport(report);
  if (fresh.length > 0) {
    await notify(tenant.tenantId, {
      kind: 'leftovers',
      level: 'warn',
      title: `${fresh.length} new capacity ${fresh.length === 1 ? 'insight' : 'insights'}`,
      lines: fresh.map((i) => `${i.title}: ${i.detail}`),
    });
  }
  return report;
}

/** ASGs with running instances whose average CPU stayed under 5% (peak under 15%) for 24h. */
async function idleInsights(
  cloudwatch: CloudWatchClient,
  asgs: { ref: AsgRef; capacity: CapacitySettings }[],
): Promise<Insight[]> {
  const running = asgs.filter((a) => a.capacity.desired > 0).slice(0, 250); // 2 queries each, 500 max per call
  if (running.length === 0) return [];

  const queries: MetricDataQuery[] = running.flatMap((a, i) =>
    (['Average', 'Maximum'] as const).map((stat) => ({
      Id: `${stat === 'Average' ? 'avg' : 'max'}${i}`,
      MetricStat: {
        Metric: {
          Namespace: 'AWS/EC2',
          MetricName: 'CPUUtilization',
          Dimensions: [{ Name: 'AutoScalingGroupName', Value: a.ref.asgName }],
        },
        Period: 3600,
        Stat: stat,
      },
    })),
  );

  const end = new Date();
  const start = new Date(end.getTime() - 24 * 3600_000);
  const res = await cloudwatch.send(new GetMetricDataCommand({ MetricDataQueries: queries, StartTime: start, EndTime: end }));
  const values = new Map((res.MetricDataResults ?? []).map((r) => [r.Id ?? '', r.Values ?? []]));

  const insights: Insight[] = [];
  running.forEach((a, i) => {
    const avg = values.get(`avg${i}`) ?? [];
    const max = values.get(`max${i}`) ?? [];
    if (avg.length < 12) return; // not enough data for a fair call
    const meanCpu = avg.reduce((s, v) => s + v, 0) / avg.length;
    const peakCpu = Math.max(...max, ...avg);
    if (meanCpu >= IDLE_AVG_CPU || peakCpu >= IDLE_MAX_CPU) return;
    insights.push({
      id: `idle:${asgKey(a.ref)}`,
      type: 'idle',
      asg: a.ref,
      title: `${a.ref.asgName} looks idle`,
      detail: `CPU averaged ${meanCpu.toFixed(1)}% (peak ${peakCpu.toFixed(1)}%) over 24h with ${a.capacity.desired} instance(s) running. Consider a schedule or lower capacity.`,
      instanceHours: a.capacity.desired * 24,
    });
  });
  return insights;
}
