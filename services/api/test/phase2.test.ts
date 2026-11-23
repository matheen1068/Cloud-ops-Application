// Notifications, DevOps Agent webhook signing, post-event report, insights and audit.
// Run: npm test -w @cloud-ops/api
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  DescribeScalingActivitiesCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
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
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

Object.assign(process.env, {
  TABLE_NAME: 'test-table',
  AWS_REGION: 'us-east-1',
  SCHEDULE_GROUP: 'cloudops-dev',
  SCHEDULER_ROLE_ARN: 'arn:aws:iam::111122223333:role/CloudOpsSchedulerRole-dev',
  RUNNER_ARN: 'arn:aws:lambda:us-east-1:111122223333:function:cloudops-dev-runner',
});

// ---- In-memory DynamoDB ---------------------------------------------------------------
type Item = Record<string, any>;
const store = new Map<string, Item>();
const key = (i: Item) => `${i.pk}|${i.sk}`;
const put = (i: Item) => store.set(key(i), structuredClone(i));
const ddb = mockClient(DynamoDBDocumentClient);
ddb.on(GetCommand).callsFake((input) => ({ Item: structuredClone(store.get(key(input.Key))) }));
ddb.on(PutCommand).callsFake((input) => (put(input.Item), {}));
ddb.on(DeleteCommand).callsFake((input) => (store.delete(key(input.Key)), {}));
ddb.on(ScanCommand).callsFake(() => ({ Items: [...store.values()].filter((i) => i.sk === 'META').map((i) => ({ tenantId: i.tenantId })) }));
ddb.on(QueryCommand).callsFake((input) => {
  const v = input.ExpressionAttributeValues;
  let items = [...store.values()].filter((i) => i.pk === v[':pk']);
  if (v[':prefix']) items = items.filter((i) => i.sk.startsWith(v[':prefix']));
  if (v[':from']) items = items.filter((i) => i.sk >= v[':from'] && i.sk <= v[':to']);
  items.sort((a, b) => a.sk.localeCompare(b.sk));
  if (input.ScanIndexForward === false) items.reverse();
  if (input.ExclusiveStartKey) {
    const idx = items.findIndex((i) => i.sk === input.ExclusiveStartKey.sk);
    items = items.slice(idx + 1);
  }
  const limited = input.Limit ? items.slice(0, input.Limit) : items;
  const more = input.Limit && items.length > input.Limit;
  return { Items: limited.map((i) => structuredClone(i)), LastEvaluatedKey: more ? { pk: v[':pk'], sk: limited.at(-1)!.sk } : undefined };
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

// ---- Customer account mocks -------------------------------------------------------------
mockClient(STSClient).on(AssumeRoleCommand).resolves({
  Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'TK', Expiration: new Date() },
});
const asg = { MinSize: 1, DesiredCapacity: 2, MaxSize: 4 };
const autoscaling = mockClient(AutoScalingClient);
autoscaling.on(DescribeAutoScalingGroupsCommand).callsFake(() => ({
  AutoScalingGroups: [{
    AutoScalingGroupName: 'web', ...asg, AvailabilityZones: ['us-east-1a'],
    LaunchTemplate: { LaunchTemplateId: 'lt-1', Version: '$Latest' }, Instances: [], SuspendedProcesses: [],
  }],
}));
let failUpdates = false;
autoscaling.on(UpdateAutoScalingGroupCommand).callsFake((input) => {
  if (failUpdates) throw Object.assign(new Error('You are not authorized to perform this operation.'), { name: 'AccessDenied' });
  Object.assign(asg, { MinSize: input.MinSize, DesiredCapacity: input.DesiredCapacity, MaxSize: input.MaxSize });
  return {};
});
let activities: any[] = [];
autoscaling.on(DescribeScalingActivitiesCommand).callsFake(() => ({ Activities: activities }));
const ec2 = mockClient(EC2Client);
ec2.on(DescribeLaunchTemplateVersionsCommand).resolves({ LaunchTemplateVersions: [{ LaunchTemplateData: { InstanceType: 't4g.small' } }] });
ec2.on(DescribeInstanceTypeOfferingsCommand).resolves({ InstanceTypeOfferings: [{ InstanceType: 't4g.small', Location: 'us-east-1a' }] });
ec2.on(DescribeInstanceTypesCommand).resolves({ InstanceTypes: [{ InstanceType: 't4g.small', VCpuInfo: { DefaultVCpus: 2 } }] });
ec2.on(DescribeInstancesCommand).resolves({ Reservations: [] });
mockClient(ServiceQuotasClient).on(GetServiceQuotaCommand).resolves({ Quota: { Value: 64 } });
const scheduler = mockClient(SchedulerClient);
scheduler.on(CreateScheduleCommand).resolves({});
scheduler.on(DeleteScheduleCommand).resolves({});
const cloudwatch = mockClient(CloudWatchClient);
cloudwatch.on(GetMetricDataCommand).resolves({
  MetricDataResults: [
    { Id: 'avg0', Values: Array(24).fill(1.5) },
    { Id: 'max0', Values: Array(24).fill(4) },
  ],
});

// ---- Outbound HTTP (Slack, DevOps Agent) ---------------------------------------------------
const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
globalThis.fetch = (async (url: string, init: RequestInit) => {
  sent.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) });
  return new Response('ok', { status: 200 });
}) as typeof fetch;

// ---- Helpers ------------------------------------------------------------------------------
const WEB = { accountId: ACCOUNT, region: 'us-east-1', asgName: 'web' };
const SLACK = 'https://hooks.slack.com/services/T000/B000/abcdefghijklmnop';
const AGENT = 'https://event-ai.us-east-1.api.aws/webhook/generic/wh-123';
function req(routeKey: string, body?: unknown, extra: Record<string, unknown> = {}): any {
  return {
    routeKey,
    requestContext: { http: { method: routeKey.split(' ')[0] }, authorizer: { jwt: { claims: { sub: 'user-1', email: 'm@example.com' } } } },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    ...extra,
  };
}
async function call(mod: string, ev: any) {
  const { handler } = await import(`../src/handlers/${mod}.ts`);
  const res = await handler(ev);
  return { status: res.statusCode as number, body: JSON.parse(res.body) };
}
const runner = async (payload: any) => (await import('../src/handlers/runner.ts')).handler(payload);
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

// ---- Settings ------------------------------------------------------------------------------
test('settings reject non-Slack and non-AWS webhook URLs', async () => {
  assert.equal((await call('settings', req('PUT /settings', { slackWebhookUrl: 'https://evil.example.com/x' }))).status, 400);
  assert.equal((await call('settings', req('PUT /settings', { devopsAgent: { webhookUrl: 'https://evil.example.com', auth: 'hmac', secret: 'secret123' } }))).status, 400);
});

test('settings are stored but only returned masked', async () => {
  const res = await call('settings', req('PUT /settings', {
    slackWebhookUrl: SLACK,
    devopsAgent: { webhookUrl: AGENT, auth: 'hmac', secret: 'super-secret-value' },
  }));
  assert.equal(res.status, 200);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes('abcdefghijklmnop') && !text.includes('super-secret-value'), 'no secrets in the response');
  assert.equal(res.body.settings.slack.configured, true);
  assert.match(res.body.settings.slack.hint, /^hooks\.slack\.com\/…mnop$/);
  assert.equal(res.body.settings.devopsAgent.auth, 'hmac');
});

test('test endpoint reports each channel', async () => {
  sent.length = 0;
  const res = await call('settings', req('POST /settings/test'));
  assert.deepEqual(res.body.results, { slack: 'ok', devopsAgent: 'ok' });
  assert.equal(sent.length, 2);
});

// ---- Event notifications, DevOps Agent signing, report ------------------------------------------
async function createEvent(name: string) {
  const res = await call('events', req('POST /scale-events', {
    name, startsAt: inMinutes(60), endsAt: inMinutes(180), prescaleMinutes: 0,
    targets: [{ asg: WEB, target: { min: 4, desired: 4, max: 6 } }],
  }));
  assert.equal(res.status, 201);
  return res.body.event.eventId as string;
}

test('a successful start posts to Slack only; the end posts a report', async () => {
  const id = await createEvent('Launch day');
  sent.length = 0;
  await runner({ kind: 'event', tenantId: 't1', id, phase: 'start' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, SLACK);
  assert.match(JSON.parse(sent[0].body).text, /Launch day.*is live[\s\S]*web: 1\/2\/4 → 4\/4\/6/);

  const scaledUpAt = new Date(store.get(`TENANT#t1|EVENT#${id}`)!.scaledUpAt).getTime();
  activities = [
    { StatusCode: 'Successful', Description: 'Launching a new EC2 instance: i-1', StartTime: new Date(scaledUpAt + 1000), EndTime: new Date(scaledUpAt + 95_000) },
    { StatusCode: 'Successful', Description: 'Launching a new EC2 instance: i-2', StartTime: new Date(scaledUpAt + 1000), EndTime: new Date(scaledUpAt + 125_000) },
    { StatusCode: 'Failed', Description: 'Launching a new EC2 instance. Status Reason: InsufficientInstanceCapacity', StartTime: new Date(scaledUpAt + 2000) },
  ];
  sent.length = 0;
  await runner({ kind: 'event', tenantId: 't1', id, phase: 'end' });
  const ev = store.get(`TENANT#t1|EVENT#${id}`)!;
  assert.equal(ev.status, 'completed');
  assert.deepEqual(ev.targets[0].report, { launches: 2, failedLaunches: 1, readyAfterSeconds: 125 });
  assert.equal(ev.report.launches, 2);
  assert.equal(ev.report.slowestReadySeconds, 125);
  assert.equal(sent.length, 1);
  assert.match(JSON.parse(sent[0].body).text, /completed[\s\S]*2 instances launched, 1 failed launches/);
  activities = [];
});

test('a failed start opens a correctly signed DevOps Agent investigation', async () => {
  const id = await createEvent('Big sale');
  failUpdates = true;
  sent.length = 0;
  await runner({ kind: 'event', tenantId: 't1', id, phase: 'start' });
  failUpdates = false;

  const agent = sent.find((s) => s.url === AGENT)!;
  assert.ok(agent, 'DevOps Agent was called');
  const ts = agent.headers['x-amzn-event-timestamp'];
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  const expected = createHmac('sha256', 'super-secret-value').update(`${ts}:${agent.body}`, 'utf8').digest('base64');
  assert.equal(agent.headers['x-amzn-event-signature'], expected);
  const payload = JSON.parse(agent.body);
  assert.equal(payload.eventType, 'incident');
  assert.equal(payload.priority, 'HIGH');
  assert.equal(payload.incidentId, `cloudops-${id}-start`);
  assert.match(payload.description, /not authorized/);
  assert.ok(sent.some((s) => s.url === SLACK), 'Slack also told');
});

test('bearer auth sends the token instead of a signature', async () => {
  await call('settings', req('PUT /settings', { devopsAgent: { webhookUrl: AGENT, auth: 'bearer', secret: 'token-12345' } }));
  sent.length = 0;
  await call('settings', req('POST /settings/test'));
  const agent = sent.find((s) => s.url === AGENT)!;
  assert.equal(agent.headers.Authorization, 'Bearer token-12345');
  assert.equal(agent.headers['x-amzn-event-signature'], undefined);
});

test('turning off event-started notifications silences them', async () => {
  await call('settings', req('PUT /settings', { notifyOn: { eventStarted: false } }));
  const id = await createEvent('Quiet one');
  sent.length = 0;
  await runner({ kind: 'event', tenantId: 't1', id, phase: 'start' });
  assert.equal(sent.length, 0);
  await runner({ kind: 'event', tenantId: 't1', id, phase: 'end' });
  await call('settings', req('PUT /settings', { notifyOn: { eventStarted: true } }));
});

// ---- Insights ----------------------------------------------------------------------------------
test('insights flag a forgotten manual scale-up and an idle ASG, and notify only once', async () => {
  Object.assign(asg, { MinSize: 5, DesiredCapacity: 5, MaxSize: 6 });
  put({
    pk: 'TENANT#t1', sk: `AUDIT#${ago(8)}#a1`, tenantId: 't1', auditId: 'a1', at: ago(8),
    actor: { userId: 'user-1', email: 'm@example.com' }, action: 'asg.capacity-changed', asg: WEB,
    before: { min: 1, desired: 2, max: 4 }, after: { min: 5, desired: 5, max: 6 }, result: 'success', message: 'load test',
  });

  sent.length = 0;
  await runner({ kind: 'sweep' });
  const report = store.get('TENANT#t1|INSIGHTS')!;
  const types = report.insights.map((i: any) => i.type).sort();
  assert.deepEqual(types, ['idle', 'manual-scale-not-reverted']);
  const manual = report.insights.find((i: any) => i.type === 'manual-scale-not-reverted');
  assert.match(manual.detail, /2 → 5 desired \("load test"\)/);
  assert.equal(manual.instanceHours, 24); // 3 extra x 8h
  assert.equal(sent.filter((s) => s.url === SLACK).length, 1);

  sent.length = 0;
  const again = await call('insights', req('POST /insights/run'));
  assert.equal(again.body.report.insights.length, 2);
  assert.equal(sent.length, 0, 'same insights, no repeat notification');
});

test('a manual scale-up inside the threshold is not flagged', async () => {
  await call('settings', req('PUT /settings', { leftoverHours: 12 }));
  const res = await call('insights', req('POST /insights/run'));
  assert.deepEqual(res.body.report.insights.map((i: any) => i.type), ['idle']);
});

// ---- Audit -------------------------------------------------------------------------------------
test('audit lists newest first with a cursor for the next page', async () => {
  const first = await call('audit', req('GET /audit', undefined, { queryStringParameters: { limit: '3' } }));
  assert.equal(first.status, 200);
  assert.equal(first.body.entries.length, 3);
  const times = first.body.entries.map((e: any) => e.at);
  assert.deepEqual([...times].sort().reverse(), times);
  assert.ok(first.body.nextCursor?.startsWith('AUDIT#'));

  const second = await call('audit', req('GET /audit', undefined, { queryStringParameters: { limit: '3', cursor: first.body.nextCursor } }));
  assert.ok(second.body.entries.every((e: any) => e.at <= times.at(-1)));
});
