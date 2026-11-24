// ECS services: listing, Scale Now, readiness, scale events and schedules.
// Run: npm test -w @cloud-ops/api
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApplicationAutoScalingClient,
  DescribeScalableTargetsCommand,
  RegisterScalableTargetCommand,
} from '@aws-sdk/client-application-auto-scaling';
import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { GetServiceQuotaCommand, ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

Object.assign(process.env, {
  TABLE_NAME: 'test-table',
  AWS_REGION: 'us-east-1',
  SCHEDULE_GROUP: 'cloudops-dev',
  SCHEDULER_ROLE_ARN: 'arn:aws:iam::111122223333:role/CloudOpsSchedulerRole-dev',
  RUNNER_ARN: 'arn:aws:lambda:us-east-1:111122223333:function:cloudops-dev-runner',
});

// ---- In-memory DynamoDB -------------------------------------------------------------------
type Item = Record<string, any>;
const store = new Map<string, Item>();
const key = (i: Item) => `${i.pk}|${i.sk}`;
const put = (i: Item) => store.set(key(i), structuredClone(i));
const ddb = mockClient(DynamoDBDocumentClient);
ddb.on(GetCommand).callsFake((input) => ({ Item: structuredClone(store.get(key(input.Key))) }));
ddb.on(PutCommand).callsFake((input) => (put(input.Item), {}));
ddb.on(DeleteCommand).callsFake((input) => (store.delete(key(input.Key)), {}));
ddb.on(QueryCommand).callsFake((input) => {
  const v = input.ExpressionAttributeValues;
  const items = [...store.values()]
    .filter((i) => i.pk === v[':pk'] && (!v[':prefix'] || i.sk.startsWith(v[':prefix'])))
    .sort((a, b) => a.sk.localeCompare(b.sk));
  return { Items: items.map((i) => structuredClone(i)) };
});

const ACCOUNT = '222233334444';
put({ pk: 'USER#u1', sk: 'PROFILE', tenantId: 't1' });
put({ pk: 'USER#u1', sk: 'TENANT#t1', tenantId: 't1', userId: 'u1', email: 'm@x.com', role: 'owner' });
put({ pk: 'TENANT#t1', sk: 'META', tenantId: 't1', name: 'T', plan: 'pro', externalId: 'x'.repeat(32), createdAt: '' });
put({
  pk: 'TENANT#t1', sk: `ACCOUNT#${ACCOUNT}`, tenantId: 't1', accountId: ACCOUNT, alias: 'Prod',
  roleArn: `arn:aws:iam::${ACCOUNT}:role/CloudOpsAccessRole`, accessLevel: 'Operate',
  connectionMethod: 'single-account', status: 'connected', regions: ['us-east-1'],
});

mockClient(STSClient).on(AssumeRoleCommand).resolves({
  Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'TK', Expiration: new Date() },
});
const scheduler = mockClient(SchedulerClient);
scheduler.on(CreateScheduleCommand).resolves({});
scheduler.on(DeleteScheduleCommand).resolves({});
mockClient(ServiceQuotasClient).on(GetServiceQuotaCommand).resolves({ Quota: { Value: 32 } });

// ---- ECS: cluster "prod" with a Fargate API (auto scaling 2-10) and an EC2 worker (no target)
const CLUSTER_ARN = `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/prod`;
const svc: Record<string, any> = {
  api: { desiredCount: 3, runningCount: 3, launchType: 'FARGATE', taskDefinition: 'api:7', tags: [{ key: 'CloudOpsManaged', value: 'true' }] },
  worker: { desiredCount: 2, runningCount: 2, launchType: 'EC2', taskDefinition: 'worker:3' },
};
const targets: Record<string, { MinCapacity: number; MaxCapacity: number }> = { 'service/prod/api': { MinCapacity: 2, MaxCapacity: 10 } };
let ecsDenied = false;
const calls: string[] = [];
const ecs = mockClient(ECSClient);
ecs.on(ListClustersCommand).callsFake(() => {
  if (ecsDenied) throw Object.assign(new Error('User is not authorized to perform: ecs:ListClusters'), { name: 'AccessDeniedException' });
  return { clusterArns: [CLUSTER_ARN] };
});
ecs.on(ListServicesCommand).resolves({ serviceArns: Object.keys(svc).map((n) => `arn:aws:ecs:us-east-1:${ACCOUNT}:service/prod/${n}`) });
ecs.on(DescribeServicesCommand).callsFake((input) => ({
  services: input.services.map((s: string) => {
    const name = s.split('/').pop()!;
    return { serviceName: name, serviceArn: `arn:aws:ecs:us-east-1:${ACCOUNT}:service/prod/${name}`, clusterArn: CLUSTER_ARN, status: 'ACTIVE', deployments: [{ rolloutState: 'COMPLETED' }], events: [], ...svc[name] };
  }),
}));
ecs.on(UpdateServiceCommand).callsFake((input) => {
  calls.push(`desired:${input.service}=${input.desiredCount}`);
  svc[input.service].desiredCount = input.desiredCount;
  return {};
});
ecs.on(DescribeTaskDefinitionCommand).resolves({ taskDefinition: { cpu: '1024' } });
const aas = mockClient(ApplicationAutoScalingClient);
aas.on(DescribeScalableTargetsCommand).callsFake((input) => ({
  ScalableTargets: input.ResourceIds.filter((id: string) => targets[id]).map((id: string) => ({ ResourceId: id, ...targets[id] })),
}));
aas.on(RegisterScalableTargetCommand).callsFake((input) => {
  calls.push(`range:${input.ResourceId}=${input.MinCapacity}-${input.MaxCapacity}`);
  targets[input.ResourceId] = { MinCapacity: input.MinCapacity, MaxCapacity: input.MaxCapacity };
  return {};
});

// ---- Helpers ----------------------------------------------------------------------------------
function req(routeKey: string, body?: unknown): any {
  return {
    routeKey,
    requestContext: { http: { method: routeKey.split(' ')[0] }, authorizer: { jwt: { claims: { sub: 'u1', email: 'm@x.com', email_verified: 'true' } } } },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
}
async function call(mod: string, ev: any) {
  const { handler } = await import(`../src/handlers/${mod}.ts`);
  const res = await handler(ev);
  return { status: res.statusCode as number, body: JSON.parse(res.body) };
}
const runner = async (payload: any) => (await import('../src/handlers/runner.ts')).handler(payload);
const API = { accountId: ACCOUNT, region: 'us-east-1', kind: 'ecs', cluster: 'prod', asgName: 'api' };
const WORKER = { ...API, asgName: 'worker' };
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

test('lists ECS services with their auto scaling ranges', async () => {
  const res = await call('ecs', req('GET /ecs-services'));
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.services.map((s: any) => [s.cluster, s.asgName, s.launchType, s.autoscaling, s.capacity, s.managedByCloudOps]),
    [
      ['prod', 'api', 'FARGATE', true, { min: 2, desired: 3, max: 10 }, true],
      ['prod', 'worker', 'EC2', false, { min: 2, desired: 2, max: 2 }, false],
    ],
  );
});

test('a role without ECS permissions is reported as not enabled, not as an error', async () => {
  ecsDenied = true;
  const res = await call('ecs', req('GET /ecs-services'));
  ecsDenied = false;
  assert.deepEqual(res.body.notEnabled, [ACCOUNT]);
  assert.deepEqual(res.body.errors, []);
});

test('Scale Now moves the auto scaling range before the desired count', async () => {
  calls.length = 0;
  const res = await call('capacity', req('PUT /asgs/capacity', { asg: API, capacity: { min: 6, desired: 6, max: 20 } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.before, { min: 2, desired: 3, max: 10 });
  assert.deepEqual(calls, ['range:service/prod/api=6-20', 'desired:api=6']);
});

test('a service without an auto scaling target only changes the desired count', async () => {
  calls.length = 0;
  const res = await call('capacity', req('PUT /asgs/capacity', { asg: WORKER, capacity: { min: 5, desired: 5, max: 5 } }));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['desired:worker=5']);
});

test('ECS refs need a cluster name', async () => {
  const res = await call('capacity', req('PUT /asgs/capacity', { asg: { ...API, cluster: undefined }, capacity: { min: 1, desired: 1, max: 1 } }));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cluster/);
});

test('readiness checks the Fargate vCPU quota and EC2 task placement', async () => {
  const res = await call('readiness', req('POST /asgs/readiness', {
    targets: [
      { asg: API, capacity: { min: 40, desired: 40, max: 40 } },
      { asg: WORKER, capacity: { min: 8, desired: 8, max: 9 } },
    ],
  }));
  const [api, worker] = res.body.results;
  const quota = api.checks.find((c: any) => c.id === 'fargate-quota');
  assert.equal(quota.status, 'fail');
  assert.match(quota.detail, /40 tasks × 1 vCPU = 40 vCPU.*quota in us-east-1 is 32/);
  assert.deepEqual(worker.checks.map((c: any) => c.id).sort(), ['ec2-capacity', 'no-autoscaling']);
});

test('a scale event scales a service up and restores it afterwards', async () => {
  Object.assign(targets['service/prod/api'], { MinCapacity: 2, MaxCapacity: 10 });
  svc.api.desiredCount = 3;
  const created = await call('events', req('POST /scale-events', {
    name: 'Launch', startsAt: inMinutes(60), endsAt: inMinutes(120), prescaleMinutes: 0,
    targets: [{ asg: API, target: { min: 8, desired: 8, max: 16 } }],
  }));
  assert.equal(created.status, 201);
  const id = created.body.event.eventId;

  await runner({ kind: 'event', tenantId: 't1', id, phase: 'start' });
  assert.equal(svc.api.desiredCount, 8);
  assert.deepEqual(targets['service/prod/api'], { MinCapacity: 8, MaxCapacity: 16 });
  const started = store.get(`TENANT#t1|EVENT#${id}`)!;
  assert.ok(started.timeline.some((t: any) => t.message === 'prod/api: 2/3/10 → 8/8/16'));

  await runner({ kind: 'event', tenantId: 't1', id, phase: 'end' });
  assert.equal(svc.api.desiredCount, 3);
  assert.deepEqual(targets['service/prod/api'], { MinCapacity: 2, MaxCapacity: 10 });
  assert.equal(store.get(`TENANT#t1|EVENT#${id}`)!.status, 'completed');
});

test('an off-hours schedule stops a service and brings it back', async () => {
  svc.worker.desiredCount = 2;
  const created = await call('schedules', req('POST /schedules', {
    name: 'Nights', timezone: 'Asia/Kolkata', days: ['MON', 'TUE'], onAt: '08:00', offAt: '20:00', asgs: [WORKER],
  }));
  assert.equal(created.status, 201);
  const id = created.body.schedule.scheduleId;
  await runner({ kind: 'schedule', tenantId: 't1', id, phase: 'off' });
  assert.equal(svc.worker.desiredCount, 0);
  await runner({ kind: 'schedule', tenantId: 't1', id, phase: 'on' });
  assert.equal(svc.worker.desiredCount, 2);
});
