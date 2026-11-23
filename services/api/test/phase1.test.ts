// Readiness checks, scale events and recurring schedules against a stateful mocked AWS.
// Run: npm test -w @cloud-ops/api
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  DescribeScalingActivitiesCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  DescribeInstanceTypeOfferingsCommand,
  DescribeInstanceTypesCommand,
  DescribeInstancesCommand,
  DescribeLaunchTemplateVersionsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { GetServiceQuotaCommand, ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

Object.assign(process.env, {
  TABLE_NAME: 'test-table',
  AWS_REGION: 'us-east-1',
  SCHEDULE_GROUP: 'cloudops-dev',
  SCHEDULER_ROLE_ARN: 'arn:aws:iam::111122223333:role/CloudOpsSchedulerRole-dev',
  RUNNER_ARN: 'arn:aws:lambda:us-east-1:111122223333:function:cloudops-dev-runner',
});

// ---- In-memory DynamoDB, seeded with one tenant and one connected account -------------
type Item = Record<string, any>;
const store = new Map<string, Item>();
const key = (i: Item) => `${i.pk}|${i.sk}`;
const put = (i: Item) => store.set(key(i), structuredClone(i));
const ddb = mockClient(DynamoDBDocumentClient);
ddb.on(GetCommand).callsFake((input) => ({ Item: structuredClone(store.get(key(input.Key))) }));
ddb.on(PutCommand).callsFake((input) => (put(input.Item), {}));
ddb.on(DeleteCommand).callsFake((input) => (store.delete(key(input.Key)), {}));
ddb.on(QueryCommand).callsFake((input) => {
  const { ':pk': pk, ':prefix': prefix } = input.ExpressionAttributeValues;
  return { Items: [...store.values()].filter((i) => i.pk === pk && i.sk.startsWith(prefix)).map((i) => structuredClone(i)) };
});

const ACCOUNT = '222233334444';
put({ pk: 'USER#user-1', sk: 'PROFILE', tenantId: 't1' });
put({ pk: 'USER#user-1', sk: 'TENANT#t1', tenantId: 't1', userId: 'user-1', email: 'm@example.com', role: 'owner' });
put({ pk: 'TENANT#t1', sk: 'META', tenantId: 't1', name: 'Test', plan: 'free', externalId: 'x'.repeat(32), createdAt: '' });
put({
  pk: 'TENANT#t1', sk: `ACCOUNT#${ACCOUNT}`, tenantId: 't1', accountId: ACCOUNT, alias: 'Prod',
  roleArn: `arn:aws:iam::${ACCOUNT}:role/CloudOpsAccessRole`, accessLevel: 'Operate',
  connectionMethod: 'single-account', status: 'connected', regions: ['us-east-1'],
});

// ---- Stateful customer account ---------------------------------------------------------
mockClient(STSClient).on(AssumeRoleCommand).resolves({
  Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'TK', Expiration: new Date() },
});

const asg = { MinSize: 1, DesiredCapacity: 2, MaxSize: 4 };
const autoscaling = mockClient(AutoScalingClient);
autoscaling.on(DescribeAutoScalingGroupsCommand).callsFake(() => ({
  AutoScalingGroups: [{
    AutoScalingGroupName: 'web', ...asg,
    AvailabilityZones: ['us-east-1a', 'us-east-1e'],
    LaunchTemplate: { LaunchTemplateId: 'lt-1', Version: '$Latest' },
    Instances: [], SuspendedProcesses: [],
  }],
}));
autoscaling.on(UpdateAutoScalingGroupCommand).callsFake((input) => {
  Object.assign(asg, { MinSize: input.MinSize, DesiredCapacity: input.DesiredCapacity, MaxSize: input.MaxSize });
  return {};
});
autoscaling.on(DescribeScalingActivitiesCommand).resolves({ Activities: [] });

const ec2 = mockClient(EC2Client);
ec2.on(DescribeLaunchTemplateVersionsCommand).resolves({
  LaunchTemplateVersions: [{ LaunchTemplateData: { InstanceType: 't4g.nano' } }],
});
ec2.on(DescribeInstanceTypeOfferingsCommand).resolves({
  InstanceTypeOfferings: [{ InstanceType: 't4g.nano', Location: 'us-east-1a' }], // not offered in 1e
});
ec2.on(DescribeInstanceTypesCommand).resolves({ InstanceTypes: [{ InstanceType: 't4g.nano', VCpuInfo: { DefaultVCpus: 2 } }] });
ec2.on(DescribeInstancesCommand).resolves({
  Reservations: [{ Instances: [{ InstanceType: 't4g.nano' }, { InstanceType: 't4g.nano' }] }], // 4 vCPUs used
});
mockClient(ServiceQuotasClient).on(GetServiceQuotaCommand).resolves({ Quota: { Value: 32 } });

const scheduler = mockClient(SchedulerClient);
scheduler.on(CreateScheduleCommand).resolves({});
scheduler.on(DeleteScheduleCommand).resolves({});

// ---- Helpers ------------------------------------------------------------------------------
const WEB = { accountId: ACCOUNT, region: 'us-east-1', asgName: 'web' };
function req(routeKey: string, body?: unknown, pathParameters?: Record<string, string>): any {
  return {
    routeKey,
    requestContext: { http: { method: routeKey.split(' ')[0] }, authorizer: { jwt: { claims: { sub: 'user-1', email: 'm@example.com' } } } },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    pathParameters,
  };
}
async function call(mod: string, ev: any) {
  const { handler } = await import(`../src/handlers/${mod}.ts`);
  const res = await handler(ev);
  return { status: res.statusCode as number, body: JSON.parse(res.body) };
}
const runner = async (payload: any) => (await import('../src/handlers/runner.ts')).handler(payload);
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

// ---- Readiness ------------------------------------------------------------------------------
test('readiness flags the zone that does not offer the instance type and the single type', async () => {
  const res = await call('readiness', req('POST /asgs/readiness', { targets: [{ asg: WEB, capacity: { min: 2, desired: 10, max: 10 } }] }));
  assert.equal(res.status, 200);
  const checks = Object.fromEntries(res.body.results[0].checks.map((c: any) => [c.id, c]));
  assert.equal(checks['az-offering'].status, 'warn');
  assert.match(checks['az-offering'].title, /us-east-1e/);
  assert.equal(checks['diversity'].status, 'warn');
  assert.equal(checks['vcpu-quota'].status, 'pass'); // needs 16 of 28 left
});

test('readiness fails when the vCPU quota cannot cover the increase', async () => {
  const res = await call('readiness', req('POST /asgs/readiness', { targets: [{ asg: WEB, capacity: { min: 2, desired: 20, max: 20 } }] }));
  const quota = res.body.results[0].checks.find((c: any) => c.id === 'vcpu-quota');
  assert.equal(quota.status, 'fail'); // needs 36 vCPUs, only 28 left
  assert.match(quota.detail, /Needs 36 more vCPUs/);
});

// ---- Scale events ----------------------------------------------------------------------------
let eventId = '';

test('creating an event schedules scale-up (start - prescale) and scale-back', async () => {
  const startsAt = inMinutes(120);
  const res = await call('events', req('POST /scale-events', {
    name: 'IPL final', startsAt, endsAt: inMinutes(300), prescaleMinutes: 30,
    targets: [{ asg: WEB, target: { min: 6, desired: 8, max: 10 } }],
  }));
  assert.equal(res.status, 201);
  eventId = res.body.event.eventId;

  const calls = scheduler.commandCalls(CreateScheduleCommand).map((c) => c.args[0].input);
  const start = calls.find((c) => c.Name === `evt-${eventId}-start`)!;
  const end = calls.find((c) => c.Name === `evt-${eventId}-end`)!;
  const expectedUp = new Date(new Date(startsAt).getTime() - 30 * 60_000).toISOString().slice(0, 19);
  assert.equal(start.ScheduleExpression, `at(${expectedUp})`);
  assert.equal(start.ActionAfterCompletion, 'DELETE');
  assert.deepEqual(JSON.parse(end.Target!.Input!), { kind: 'event', tenantId: 't1', id: eventId, phase: 'end' });
});

test('an overlapping event on the same ASG is rejected', async () => {
  const res = await call('events', req('POST /scale-events', {
    name: 'Clash', startsAt: inMinutes(150), endsAt: inMinutes(200),
    targets: [{ asg: WEB, target: { min: 1, desired: 3, max: 4 } }],
  }));
  assert.equal(res.status, 409);
});

test('start captures the baseline and applies the target; end restores the baseline', async () => {
  await runner({ kind: 'event', tenantId: 't1', id: eventId, phase: 'start' });
  assert.deepEqual(asg, { MinSize: 6, DesiredCapacity: 8, MaxSize: 10 });
  let ev = store.get(`TENANT#t1|EVENT#${eventId}`)!;
  assert.equal(ev.status, 'active');
  assert.deepEqual(ev.targets[0].baseline, { min: 1, desired: 2, max: 4 });
  assert.ok(ev.timeline.some((t: any) => /us-east-1e/.test(t.message)), 'readiness warning logged at start');

  await runner({ kind: 'event', tenantId: 't1', id: eventId, phase: 'start' }); // scheduler retry: no-op
  assert.equal(store.get(`TENANT#t1|EVENT#${eventId}`)!.status, 'active');

  await runner({ kind: 'event', tenantId: 't1', id: eventId, phase: 'end' });
  assert.deepEqual(asg, { MinSize: 1, DesiredCapacity: 2, MaxSize: 4 });
  ev = store.get(`TENANT#t1|EVENT#${eventId}`)!;
  assert.equal(ev.status, 'completed');
  assert.equal(ev.targets[0].state, 'reverted');
});

test('cancelling a scheduled event deletes both schedules', async () => {
  const created = await call('events', req('POST /scale-events', {
    name: 'Sale', startsAt: inMinutes(600), endsAt: inMinutes(700),
    targets: [{ asg: WEB, target: { min: 2, desired: 4, max: 6 } }],
  }));
  const id = created.body.event.eventId;
  const res = await call('events', req('POST /scale-events/{eventId}/cancel', undefined, { eventId: id }));
  assert.equal(res.body.event.status, 'cancelled');
  const deleted = scheduler.commandCalls(DeleteScheduleCommand).map((c) => c.args[0].input.Name);
  assert.ok(deleted.includes(`evt-${id}-start`) && deleted.includes(`evt-${id}-end`));
});

// ---- Recurring schedules ----------------------------------------------------------------------
let scheduleId = '';

test('a schedule with off before on is rejected', async () => {
  const res = await call('schedules', req('POST /schedules', {
    name: 'Bad', timezone: 'Asia/Kolkata', days: ['MON'], onAt: '20:00', offAt: '09:00', asgs: [WEB],
  }));
  assert.equal(res.status, 400);
});

test('creating a schedule makes off/on cron schedules in the chosen timezone', async () => {
  const res = await call('schedules', req('POST /schedules', {
    name: 'Office hours', timezone: 'Asia/Kolkata', days: ['FRI', 'MON', 'TUE', 'WED', 'THU'],
    onAt: '09:00', offAt: '20:30', asgs: [WEB],
  }));
  assert.equal(res.status, 201);
  scheduleId = res.body.schedule.scheduleId;
  const calls = scheduler.commandCalls(CreateScheduleCommand).map((c) => c.args[0].input);
  const off = calls.find((c) => c.Name === `sch-${scheduleId}-off`)!;
  const on = calls.find((c) => c.Name === `sch-${scheduleId}-on`)!;
  assert.equal(off.ScheduleExpression, 'cron(30 20 ? * MON,TUE,WED,THU,FRI *)');
  assert.equal(on.ScheduleExpression, 'cron(0 9 ? * MON,TUE,WED,THU,FRI *)');
  assert.equal(off.ScheduleExpressionTimezone, 'Asia/Kolkata');
});

test('switch-off keeps max and remembers capacity; switch-on restores it', async () => {
  await runner({ kind: 'schedule', tenantId: 't1', id: scheduleId, phase: 'off' });
  assert.deepEqual(asg, { MinSize: 0, DesiredCapacity: 0, MaxSize: 4 });
  assert.deepEqual(store.get(`TENANT#t1|SCHEDULE#${scheduleId}`)!.targets[0].baseline, { min: 1, desired: 2, max: 4 });

  await runner({ kind: 'schedule', tenantId: 't1', id: scheduleId, phase: 'on' });
  assert.deepEqual(asg, { MinSize: 1, DesiredCapacity: 2, MaxSize: 4 });
});

test('switch-off leaves ASGs alone while a scale event is active', async () => {
  put({ pk: 'TENANT#t1', sk: 'EVENT#live', eventId: 'live', name: 'Live', status: 'active', targets: [{ asg: WEB }], startsAt: '', endsAt: '', prescaleMinutes: 0, timeline: [] });
  await runner({ kind: 'schedule', tenantId: 't1', id: scheduleId, phase: 'off' });
  assert.deepEqual(asg, { MinSize: 1, DesiredCapacity: 2, MaxSize: 4 });
  const s = store.get(`TENANT#t1|SCHEDULE#${scheduleId}`)!;
  assert.ok(s.timeline.some((t: any) => /active scale event/.test(t.message)));
  store.delete('TENANT#t1|EVENT#live');
});

test('deleting a schedule removes its cron schedules', async () => {
  const res = await call('schedules', req('DELETE /schedules/{scheduleId}', undefined, { scheduleId }));
  assert.equal(res.status, 200);
  const deleted = scheduler.commandCalls(DeleteScheduleCommand).map((c) => c.args[0].input.Name);
  assert.ok(deleted.includes(`sch-${scheduleId}-off`) && deleted.includes(`sch-${scheduleId}-on`));
  assert.equal(store.has(`TENANT#t1|SCHEDULE#${scheduleId}`), false);
});
