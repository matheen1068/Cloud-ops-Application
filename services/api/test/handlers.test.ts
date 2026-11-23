// End-to-end handler tests against mocked AWS (no real account needed).
// Run: npm test -w @cloud-ops/api
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

Object.assign(process.env, {
  TABLE_NAME: 'test-table',
  PLATFORM_ACCOUNT_ID: '111122223333',
  PLATFORM_ROLE_NAME: 'CloudOpsPlatformRole-dev',
  ACCESS_ROLE_NAME: 'CloudOpsAccessRole',
  AWS_REGION: 'ap-south-1',
});

// ---- In-memory DynamoDB -----------------------------------------------------
type Item = Record<string, any>;
const store = new Map<string, Item>();
const key = (i: Item) => `${i.pk}|${i.sk}`;
const ddb = mockClient(DynamoDBDocumentClient);
ddb.on(GetCommand).callsFake((input) => ({ Item: store.get(key(input.Key)) }));
ddb.on(PutCommand).callsFake((input) => {
  store.set(key(input.Item), input.Item);
  return {};
});
ddb.on(QueryCommand).callsFake((input) => {
  const { ':pk': pk, ':prefix': prefix } = input.ExpressionAttributeValues;
  return { Items: [...store.values()].filter((i) => i.pk === pk && i.sk.startsWith(prefix)) };
});
ddb.on(TransactWriteCommand).callsFake((input) => {
  for (const t of input.TransactItems) {
    if (t.Put.ConditionExpression && store.has(key(t.Put.Item))) {
      throw Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' });
    }
  }
  for (const t of input.TransactItems) store.set(key(t.Put.Item), t.Put.Item);
  return {};
});

// ---- Customer account mocks ---------------------------------------------------
const CUSTOMER = '222233334444';
const ROLE_ARN = `arn:aws:iam::${CUSTOMER}:role/CloudOpsAccessRole`;
const sts = mockClient(STSClient);
sts.on(AssumeRoleCommand).resolves({
  Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'TK', Expiration: new Date() },
});
sts.on(GetCallerIdentityCommand).resolves({ Account: CUSTOMER });

const autoscaling = mockClient(AutoScalingClient);
autoscaling.on(DescribeAutoScalingGroupsCommand).resolves({
  AutoScalingGroups: [
    {
      AutoScalingGroupName: 'web-prod',
      AutoScalingGroupARN: 'arn:aws:autoscaling:ap-south-1:222233334444:autoScalingGroup:x:autoScalingGroupName/web-prod',
      MinSize: 2, DesiredCapacity: 3, MaxSize: 10,
      Instances: [
        { InstanceId: 'i-1', InstanceType: 't4g.small', LifecycleState: 'InService' },
        { InstanceId: 'i-2', InstanceType: 't4g.small', LifecycleState: 'InService' },
        { InstanceId: 'i-3', InstanceType: 't4g.medium', LifecycleState: 'Pending' },
      ],
      Tags: [{ Key: 'CloudOpsManaged', Value: 'true' }],
    } as any,
  ],
});
autoscaling.on(UpdateAutoScalingGroupCommand).resolves({});

const ec2 = mockClient(EC2Client);
ec2.on(DescribeInstancesCommand).resolves({
  Reservations: [{ Instances: [{ InstanceId: 'i-2', InstanceLifecycle: 'spot' }] }],
});

// ---- Helpers ------------------------------------------------------------------
function event(method: string, body?: unknown, query?: Record<string, string>): any {
  return {
    requestContext: {
      http: { method },
      authorizer: { jwt: { claims: { sub: 'user-1', email: 'matheen@example.com' } } },
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    queryStringParameters: query,
  };
}
async function call(mod: string, ev: any) {
  const { handler } = await import(`../src/handlers/${mod}.ts`);
  const res = await handler(ev);
  return { status: res.statusCode as number, body: JSON.parse(res.body) };
}

// ---- Tests (run in order, sharing the store) ------------------------------------
test('GET /me creates a free workspace on first sign-in, once', async () => {
  const first = await call('me', event('GET'));
  assert.equal(first.status, 200);
  assert.equal(first.body.user.role, 'owner');
  assert.equal(first.body.tenant.plan, 'free');
  assert.equal(first.body.tenant.limits.maxAwsAccounts, 3);
  assert.equal(first.body.onboarding.platformRoleName, 'CloudOpsPlatformRole-dev');
  assert.ok(first.body.onboarding.externalId.length >= 16);

  const second = await call('me', event('GET'));
  assert.equal(second.body.tenant.tenantId, first.body.tenant.tenantId);
  assert.equal([...store.values()].filter((i) => i.sk === 'META').length, 1);
});

test('POST /accounts rejects a bad role ARN', async () => {
  const res = await call('accounts', event('POST', { roleArn: 'not-an-arn', alias: 'Prod' }));
  assert.equal(res.status, 400);
});

test('POST /accounts connects an account after assuming the role with the tenant external ID', async () => {
  const res = await call('accounts', event('POST', { roleArn: ROLE_ARN, alias: 'Prod', regions: ['ap-south-1'] }));
  assert.equal(res.status, 201);
  assert.equal(res.body.account.accountId, CUSTOMER);
  assert.equal(res.body.account.status, 'connected');

  const assumed = sts.commandCalls(AssumeRoleCommand).at(-1)!.args[0].input;
  const tenant = [...store.values()].find((i) => i.sk === 'META')!;
  assert.equal(assumed.ExternalId, tenant.externalId);
  assert.ok([...store.values()].some((i) => i.action === 'account.connected'));
});

test('POST /accounts refuses a role that answers from another account', async () => {
  sts.on(GetCallerIdentityCommand).resolves({ Account: '999999999999' });
  try {
    const res = await call('accounts', event('POST', { roleArn: ROLE_ARN, alias: 'Prod' }));
    assert.equal(res.status, 400);
  } finally {
    sts.on(GetCallerIdentityCommand).resolves({ Account: CUSTOMER });
  }
});

test('GET /accounts lists the connected account', async () => {
  const res = await call('accounts', event('GET'));
  assert.equal(res.status, 200);
  assert.equal(res.body.accounts.length, 1);
});

test('GET /asgs returns ASGs with spot / on-demand split', async () => {
  const res = await call('asgs', event('GET'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.errors, []);
  const [asg] = res.body.asgs;
  assert.equal(asg.asgName, 'web-prod');
  assert.deepEqual(asg.capacity, { min: 2, desired: 3, max: 10 });
  assert.equal(asg.inServiceInstances, 2);
  assert.equal(asg.spotInstances, 1);
  assert.equal(asg.onDemandInstances, 2);
  assert.deepEqual(asg.instanceTypes, ['t4g.small', 't4g.medium']);
  assert.equal(asg.managedByCloudOps, true);
});

test('PUT /asgs/capacity rejects min > desired', async () => {
  const res = await call('capacity', event('PUT', {
    asg: { accountId: CUSTOMER, region: 'ap-south-1', asgName: 'web-prod' },
    capacity: { min: 5, desired: 3, max: 10 },
  }));
  assert.equal(res.status, 400);
});

test('PUT /asgs/capacity scales the ASG and audits before/after', async () => {
  const res = await call('capacity', event('PUT', {
    asg: { accountId: CUSTOMER, region: 'ap-south-1', asgName: 'web-prod' },
    capacity: { min: 4, desired: 8, max: 20 },
    reason: 'IPL final',
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.before, { min: 2, desired: 3, max: 10 });

  const update = autoscaling.commandCalls(UpdateAutoScalingGroupCommand).at(-1)!.args[0].input;
  assert.deepEqual(update, { AutoScalingGroupName: 'web-prod', MinSize: 4, DesiredCapacity: 8, MaxSize: 20 });
  const audit = [...store.values()].find((i) => i.action === 'asg.capacity-changed')!;
  assert.equal(audit.result, 'success');
  assert.equal(audit.message, 'IPL final');
});

test('PUT /asgs/capacity refuses read-only accounts', async () => {
  await call('accounts', event('POST', { roleArn: ROLE_ARN, alias: 'Prod', accessLevel: 'ReadOnly' }));
  const res = await call('capacity', event('PUT', {
    asg: { accountId: CUSTOMER, region: 'ap-south-1', asgName: 'web-prod' },
    capacity: { min: 1, desired: 1, max: 1 },
  }));
  assert.equal(res.status, 403);
});
