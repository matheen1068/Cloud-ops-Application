// Team invites, roles, workspace switching and approvals (two-person rule).
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
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

Object.assign(process.env, {
  TABLE_NAME: 'test-table',
  AWS_REGION: 'us-east-1',
  WEB_URL: 'https://app.example.com',
  PLATFORM_ACCOUNT_ID: '111122223333',
  PLATFORM_ROLE_NAME: 'CloudOpsPlatformRole',
  ACCESS_ROLE_NAME: 'CloudOpsAccessRole',
  SCHEDULE_GROUP: 'cloudops-dev',
  SCHEDULER_ROLE_ARN: 'arn:aws:iam::111122223333:role/CloudOpsSchedulerRole-dev',
  RUNNER_ARN: 'arn:aws:lambda:us-east-1:111122223333:function:cloudops-dev-runner',
});

// ---- In-memory DynamoDB -------------------------------------------------------------------
type Item = Record<string, any>;
const store = new Map<string, Item>();
const key = (i: Item) => `${i.pk}|${i.sk}`;
const put = (i: Item) => store.set(key(i), structuredClone(i));
const conditionFailed = (name: string) => Object.assign(new Error('condition failed'), { name });
const ddb = mockClient(DynamoDBDocumentClient);
ddb.on(GetCommand).callsFake((input) => ({ Item: structuredClone(store.get(key(input.Key))) }));
ddb.on(PutCommand).callsFake((input) => {
  if (input.ConditionExpression === '#s = :pending' && store.get(key(input.Item))?.status !== 'pending') {
    throw conditionFailed('ConditionalCheckFailedException');
  }
  put(input.Item);
  return {};
});
ddb.on(DeleteCommand).callsFake((input) => (store.delete(key(input.Key)), {}));
ddb.on(ScanCommand).resolves({ Items: [] });
ddb.on(TransactWriteCommand).callsFake((input) => {
  for (const t of input.TransactItems) {
    if (t.Put?.ConditionExpression === 'attribute_not_exists(pk)' && store.has(key(t.Put.Item))) {
      throw conditionFailed('TransactionCanceledException');
    }
  }
  for (const t of input.TransactItems) {
    if (t.Put) put(t.Put.Item);
    if (t.Delete) store.delete(key(t.Delete.Key));
  }
  return {};
});
ddb.on(QueryCommand).callsFake((input) => {
  const v = input.ExpressionAttributeValues;
  const items = [...store.values()]
    .filter((i) => i.pk === v[':pk'] && (!v[':prefix'] || i.sk.startsWith(v[':prefix'])))
    .sort((a, b) => a.sk.localeCompare(b.sk));
  return { Items: items.map((i) => structuredClone(i)) };
});

const ACCOUNT = '222233334444';
const OWNER = { sub: 'u-owner', email: 'owner@x.com' };
const ADMIN = { sub: 'u-admin', email: 'admin@x.com' };
const OP = { sub: 'u-op', email: 'op@x.com' };
put({ pk: 'USER#u-owner', sk: 'PROFILE', tenantId: 't1' });
put({ pk: 'USER#u-owner', sk: 'TENANT#t1', tenantId: 't1', userId: 'u-owner', email: 'owner@x.com', role: 'owner' });
put({ pk: 'TENANT#t1', sk: 'META', tenantId: 't1', name: 'Acme Ops', plan: 'pro', externalId: 'x'.repeat(32), createdAt: '' });
put({
  pk: 'TENANT#t1', sk: `ACCOUNT#${ACCOUNT}`, tenantId: 't1', accountId: ACCOUNT, alias: 'Prod',
  roleArn: `arn:aws:iam::${ACCOUNT}:role/CloudOpsAccessRole`, accessLevel: 'Operate',
  connectionMethod: 'single-account', status: 'connected', regions: ['us-east-1'],
});

// ---- Customer account mocks -----------------------------------------------------------------
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
autoscaling.on(UpdateAutoScalingGroupCommand).callsFake((input) => {
  Object.assign(asg, { MinSize: input.MinSize, DesiredCapacity: input.DesiredCapacity, MaxSize: input.MaxSize });
  return {};
});
autoscaling.on(DescribeScalingActivitiesCommand).resolves({ Activities: [] });
const ec2 = mockClient(EC2Client);
ec2.on(DescribeLaunchTemplateVersionsCommand).resolves({ LaunchTemplateVersions: [{ LaunchTemplateData: { InstanceType: 't4g.small' } }] });
ec2.on(DescribeInstanceTypeOfferingsCommand).resolves({ InstanceTypeOfferings: [{ InstanceType: 't4g.small', Location: 'us-east-1a' }] });
ec2.on(DescribeInstanceTypesCommand).resolves({ InstanceTypes: [{ InstanceType: 't4g.small', VCpuInfo: { DefaultVCpus: 2 } }] });
ec2.on(DescribeInstancesCommand).resolves({ Reservations: [] });
mockClient(ServiceQuotasClient).on(GetServiceQuotaCommand).resolves({ Quota: { Value: 64 } });
const scheduler = mockClient(SchedulerClient);
scheduler.on(CreateScheduleCommand).resolves({});
scheduler.on(DeleteScheduleCommand).resolves({});
globalThis.fetch = (async () => new Response('ok')) as typeof fetch;

// ---- Helpers ----------------------------------------------------------------------------------
type Who = { sub: string; email: string; verified?: boolean };
function req(who: Who, routeKey: string, body?: unknown, pathParameters?: Record<string, string>): any {
  return {
    routeKey,
    requestContext: {
      http: { method: routeKey.split(' ')[0] },
      authorizer: { jwt: { claims: { sub: who.sub, email: who.email, email_verified: String(who.verified ?? true) } } },
    },
    pathParameters,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
}
async function call(mod: string, ev: any) {
  const { handler } = await import(`../src/handlers/${mod}.ts`);
  const res = await handler(ev);
  return { status: res.statusCode as number, body: JSON.parse(res.body) };
}
const me = (who: Who) => call('me', req(who, 'GET /me'));
const invite = (email: string, role: string, by: Who = OWNER) => call('members', req(by, 'POST /members/invites', { email, role }));
const WEB = { accountId: ACCOUNT, region: 'us-east-1', asgName: 'web' };
const scale = (who: Who, desired: number) =>
  call('capacity', req(who, 'PUT /asgs/capacity', { asg: WEB, capacity: { min: 1, desired, max: 10 }, reason: 'traffic' }));
const decideAs = (who: Who, id: string, action: string, body?: unknown) =>
  call('approvals', req(who, `POST /approvals/{requestId}/${action}`, body, { requestId: id }));
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

// ---- Invites and roles ---------------------------------------------------------------------------
test('a new user who signs up with the invited email joins the workspace', async () => {
  const res = await invite('Admin@X.com', 'admin');
  assert.equal(res.status, 201);
  assert.equal(res.body.invite.email, 'admin@x.com');
  assert.equal(res.body.link, `https://app.example.com/?invite=${res.body.invite.inviteId}`);
  assert.equal(res.body.emailed, false, 'no SES sender configured');

  const mine = await me(ADMIN);
  assert.equal(mine.body.tenant.tenantId, 't1');
  assert.equal(mine.body.user.role, 'admin');
  assert.equal(mine.body.onboarding.externalId, 'x'.repeat(32), 'admins get onboarding values');

  await invite('op@x.com', 'operator', ADMIN);
  assert.equal((await me(OP)).body.user.role, 'operator');
  const team = await call('members', req(OWNER, 'GET /members'));
  assert.deepEqual(team.body.members.map((m: any) => m.role), ['owner', 'admin', 'operator']);
  assert.equal(team.body.invites.length, 0);
});

test('duplicate invites, bad roles and operators inviting are refused', async () => {
  assert.equal((await invite('op@x.com', 'viewer')).status, 409);
  assert.equal((await invite('new@x.com', 'superuser')).status, 400);
  assert.equal((await invite('new@x.com', 'owner', ADMIN)).status, 403, 'only owners invite owners');
  assert.equal((await invite('new@x.com', 'viewer', OP)).status, 403);
});

test('the plan limit counts members and pending invites', async () => {
  store.get('TENANT#t1|META')!.plan = 'free';
  const res = await invite('new@x.com', 'viewer');
  store.get('TENANT#t1|META')!.plan = 'pro';
  assert.equal(res.status, 403);
  assert.match(res.body.error, /free plan allows 1 user/);
});

test('an unverified email cannot use an invite', async () => {
  await invite('slow@x.com', 'viewer');
  const res = await me({ sub: 'u-slow', email: 'slow@x.com', verified: false });
  assert.notEqual(res.body.tenant.tenantId, 't1');
  assert.deepEqual(res.body.invites, []);
});

test('someone with their own workspace accepts an invite and can switch back', async () => {
  const OTHER = { sub: 'u-other', email: 'other@x.com' };
  const own = (await me(OTHER)).body.tenant.tenantId;
  const { body } = await invite('other@x.com', 'viewer');

  const before = await me(OTHER);
  assert.equal(before.body.tenant.tenantId, own);
  assert.deepEqual(before.body.invites.map((i: any) => [i.tenantName, i.role]), [['Acme Ops', 'viewer']]);

  assert.equal((await call('members', req(OTHER, 'POST /invites/{inviteId}/accept', undefined, { inviteId: body.invite.inviteId }))).status, 200);
  const after = await me(OTHER);
  assert.equal(after.body.tenant.tenantId, 't1');
  assert.equal(after.body.workspaces.length, 2);
  assert.equal(after.body.onboarding, undefined, 'viewers never see the external ID');

  const switched = await call('me', req(OTHER, 'POST /me/workspace', { tenantId: own }));
  assert.equal(switched.body.tenant.tenantId, own);
  assert.equal((await call('me', req(OTHER, 'POST /me/workspace', { tenantId: 'someone-elses' }))).status, 404);
});

test('admins cannot change owners, and the last owner cannot leave', async () => {
  assert.equal((await call('members', req(ADMIN, 'PUT /members/{userId}', { role: 'viewer' }, { userId: 'u-owner' }))).status, 403);
  assert.equal((await call('members', req(OWNER, 'PUT /members/{userId}', { role: 'admin' }, { userId: 'u-owner' }))).status, 409);
  assert.equal((await call('members', req(OWNER, 'DELETE /members/{userId}', undefined, { userId: 'u-owner' }))).status, 409);
  assert.equal((await call('members', req(OP, 'DELETE /members/{userId}', undefined, { userId: 'u-admin' }))).status, 403);
});

// ---- Approvals ---------------------------------------------------------------------------------
test('only admins can mark an account as needing approval', async () => {
  const route = 'PUT /accounts/{accountId}';
  assert.equal((await call('accounts', req(OP, route, { requireApproval: true }, { accountId: ACCOUNT }))).status, 403);
  const res = await call('accounts', req(OWNER, route, { requireApproval: true }, { accountId: ACCOUNT }));
  assert.equal(res.status, 200);
  assert.equal(res.body.account.requireApproval, true);
});

test('Scale Now on a protected account waits for a second person', async () => {
  const pending = await scale(OP, 6);
  assert.equal(pending.status, 202);
  assert.equal(pending.body.approval.status, 'pending');
  assert.match(pending.body.approval.summary, /Scale web \(Prod\) to 1\/6\/10/);
  assert.equal(asg.DesiredCapacity, 2, 'nothing changed yet');

  const id = pending.body.approval.requestId;
  assert.equal((await decideAs(OP, id, 'approve')).status, 403, 'operators cannot approve');
  const approved = await decideAs(ADMIN, id, 'approve', { note: 'ok for the match' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.approval.status, 'approved');
  assert.equal(approved.body.approval.result, 'web: 1/2/4 → 1/6/10');
  assert.equal(asg.DesiredCapacity, 6);

  const audit = [...store.values()].filter((i) => i.action === 'asg.capacity-changed').at(-1)!;
  assert.equal(audit.actor.email, 'op@x.com', 'applied on behalf of the requester');
  assert.match(audit.message, /approved by admin@x.com/);
  assert.equal((await decideAs(ADMIN, id, 'approve')).status, 409, 'cannot be applied twice');
});

test('nobody approves their own request, except an owner breaking glass with a reason', async () => {
  const mine = await scale(ADMIN, 3);
  assert.equal((await decideAs(ADMIN, mine.body.approval.requestId, 'approve')).status, 403);
  await decideAs(ADMIN, mine.body.approval.requestId, 'cancel');

  const owners = await scale(OWNER, 8);
  const id = owners.body.approval.requestId;
  assert.equal((await decideAs(OWNER, id, 'approve', { breakGlassReason: 'urgent' })).status, 403, 'reason too short');
  const res = await decideAs(OWNER, id, 'approve', { breakGlassReason: 'Live match, admin is offline' });
  assert.equal(res.body.approval.status, 'approved');
  assert.equal(res.body.approval.breakGlass, true);
  assert.equal(asg.DesiredCapacity, 8);
  assert.ok([...store.values()].some((i) => i.action === 'approval.break-glass' && /admin is offline/.test(i.message)));
});

test('rejected and cancelled requests change nothing', async () => {
  const a = await scale(OP, 9);
  const rejected = await decideAs(ADMIN, a.body.approval.requestId, 'reject', { note: 'not during the sale' });
  assert.equal(rejected.body.approval.status, 'rejected');
  assert.equal((await decideAs(OWNER, a.body.approval.requestId, 'approve')).status, 409);

  const b = await scale(OP, 9);
  assert.equal((await decideAs(OP, b.body.approval.requestId, 'cancel')).body.approval.status, 'cancelled');
  assert.equal(asg.DesiredCapacity, 8);

  const list = await call('approvals', req(OP, 'GET /approvals'));
  assert.equal(list.body.approvals[0].requestId, b.body.approval.requestId, 'newest first');
});

test('a scale event on a protected account is created only after approval, and expires at scale-up', async () => {
  const body = {
    name: 'Final', startsAt: inMinutes(60), endsAt: inMinutes(120), prescaleMinutes: 15,
    targets: [{ asg: WEB, target: { min: 4, desired: 4, max: 12 } }],
  };
  const pending = await call('events', req(OP, 'POST /scale-events', body));
  assert.equal(pending.status, 202);
  const expires = new Date(pending.body.approval.expiresAt).getTime();
  assert.ok(Math.abs(expires - (Date.now() + 45 * 60_000)) < 5000, 'expires when pre-scale would start');
  assert.equal((await call('events', req(OP, 'GET /scale-events'))).body.events.length, 0);

  const approved = await decideAs(ADMIN, pending.body.approval.requestId, 'approve');
  assert.equal(approved.body.approval.result, 'Event "Final" scheduled.');
  const events = (await call('events', req(OP, 'GET /scale-events'))).body.events;
  assert.equal(events.length, 1);
  assert.equal(events[0].createdBy, 'op@x.com');

  const late = await call('events', req(OP, 'POST /scale-events', { ...body, name: 'Too soon', startsAt: inMinutes(3), endsAt: inMinutes(30), prescaleMinutes: 0 }));
  assert.equal(late.status, 400);

  const stale = await call('events', req(OP, 'POST /scale-events', { ...body, name: 'Later', startsAt: inMinutes(600), endsAt: inMinutes(700) }));
  store.get(`TENANT#t1|APPROVAL#${stale.body.approval.requestId}`)!.expiresAt = inMinutes(-1);
  assert.equal((await decideAs(ADMIN, stale.body.approval.requestId, 'approve')).status, 409);
});

test('someone removed from their only workspace gets a fresh one next time', async () => {
  assert.equal((await call('members', req(ADMIN, 'DELETE /members/{userId}', undefined, { userId: 'u-op' }))).status, 200);
  const res = await me(OP);
  assert.equal(res.status, 200);
  assert.notEqual(res.body.tenant.tenantId, 't1');
  assert.equal(res.body.user.role, 'owner');
});
