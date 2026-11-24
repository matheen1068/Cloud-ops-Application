// Organization discovery, bulk connect, MSP client groups and client-scoped access.
// Run: npm test -w @cloud-ops/api
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  DescribeOrganizationCommand,
  ListAccountsForParentCommand,
  ListOrganizationalUnitsForParentCommand,
  ListRootsCommand,
  OrganizationsClient,
} from '@aws-sdk/client-organizations';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

Object.assign(process.env, {
  TABLE_NAME: 'test-table',
  AWS_REGION: 'us-east-1',
  WEB_URL: 'https://app.example.com',
  PLATFORM_ACCOUNT_ID: '999999999999',
  PLATFORM_ROLE_NAME: 'CloudOpsPlatformRole',
  ACCESS_ROLE_NAME: 'CloudOpsAccessRole',
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
ddb.on(TransactWriteCommand).callsFake((input) => {
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

const MGMT = '111111111111';
const ACME_PROD = '333333333333';
const ACME_DEV = '444444444444'; // no CloudOpsAccessRole yet
const GLOBEX = '555555555555';
const OWNER = { sub: 'u-owner', email: 'owner@msp.com' };
const OP = { sub: 'u-op', email: 'op@msp.com' };
const tenant = () => store.get('TENANT#t1|META')!;
put({ pk: 'USER#u-owner', sk: 'PROFILE', tenantId: 't1' });
put({ pk: 'USER#u-owner', sk: 'TENANT#t1', tenantId: 't1', userId: 'u-owner', email: OWNER.email, role: 'owner' });
put({ pk: 'TENANT#t1', sk: 'MEMBER#u-owner', tenantId: 't1', userId: 'u-owner', email: OWNER.email, role: 'owner' });
put({ pk: 'TENANT#t1', sk: 'META', tenantId: 't1', name: 'Kinetic MSP', plan: 'pro', externalId: 'x'.repeat(32), createdAt: '' });
put({
  pk: 'TENANT#t1', sk: `ACCOUNT#${MGMT}`, tenantId: 't1', accountId: MGMT, alias: 'Management',
  roleArn: `arn:aws:iam::${MGMT}:role/CloudOpsAccessRole`, accessLevel: 'ReadOnly',
  connectionMethod: 'single-account', status: 'connected', regions: ['us-east-1'],
});

// ---- STS: the assumed role's account id rides in the access key so GetCallerIdentity can answer
const sts = mockClient(STSClient);
sts.on(AssumeRoleCommand).callsFake((input) => {
  const account = /::(\d{12}):/.exec(input.RoleArn)![1];
  if (account === ACME_DEV) throw Object.assign(new Error(`User is not authorized to perform: sts:AssumeRole on ${input.RoleArn}`), { name: 'AccessDenied' });
  return { Credentials: { AccessKeyId: account, SecretAccessKey: 'SK', SessionToken: 'TK', Expiration: new Date() } };
});
sts.on(GetCallerIdentityCommand).callsFake(async (_input, getClient) => {
  const creds = await (getClient().config.credentials as () => Promise<{ accessKeyId: string }>)();
  return { Account: creds.accessKeyId };
});

// ---- Organizations: Root → Clients → { Acme, Globex }
let orgDenied = false;
const org = mockClient(OrganizationsClient);
org.on(DescribeOrganizationCommand).resolves({ Organization: { Id: 'o-abc123', MasterAccountId: MGMT } });
org.on(ListRootsCommand).callsFake(() => {
  if (orgDenied) throw Object.assign(new Error('You don’t have permissions to access this resource.'), { name: 'AccessDeniedException' });
  return { Roots: [{ Id: 'r-root' }] };
});
const ous: Record<string, { Id: string; Name: string }[]> = {
  'r-root': [{ Id: 'ou-clients', Name: 'Clients' }],
  'ou-clients': [{ Id: 'ou-acme', Name: 'Acme' }, { Id: 'ou-globex', Name: 'Globex' }],
};
const accountsIn: Record<string, { Id: string; Name: string; State: string }[]> = {
  'r-root': [{ Id: MGMT, Name: 'management', State: 'ACTIVE' }],
  'ou-acme': [{ Id: ACME_PROD, Name: 'acme-prod', State: 'ACTIVE' }, { Id: ACME_DEV, Name: 'acme-dev', State: 'ACTIVE' }],
  'ou-globex': [{ Id: GLOBEX, Name: 'globex-prod', State: 'ACTIVE' }, { Id: '666666666666', Name: 'old-sandbox', State: 'SUSPENDED' }],
};
org.on(ListOrganizationalUnitsForParentCommand).callsFake((input) => ({ OrganizationalUnits: ous[input.ParentId] ?? [] }));
org.on(ListAccountsForParentCommand).callsFake((input) => ({ Accounts: accountsIn[input.ParentId] ?? [] }));

// ---- One ASG per account
const autoscaling = mockClient(AutoScalingClient);
autoscaling.on(DescribeAutoScalingGroupsCommand).resolves({
  AutoScalingGroups: [{ AutoScalingGroupName: 'web', MinSize: 1, DesiredCapacity: 1, MaxSize: 4, AvailabilityZones: ['us-east-1a'], Instances: [], Tags: [] }],
});
autoscaling.on(UpdateAutoScalingGroupCommand).resolves({});

// ---- Helpers ----------------------------------------------------------------------------------
type Who = { sub: string; email: string };
function req(who: Who, routeKey: string, body?: unknown, pathParameters?: Record<string, string>): any {
  return {
    routeKey,
    requestContext: {
      http: { method: routeKey.split(' ')[0] },
      authorizer: { jwt: { claims: { sub: who.sub, email: who.email, email_verified: 'true' } } },
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
const discover = (who: Who = OWNER) => call('accounts', req(who, 'POST /accounts/{accountId}/discover', undefined, { accountId: MGMT }));
const accountIds = async (who: Who) => (await call('accounts', req(who, 'GET /accounts'))).body.accounts.map((a: any) => a.accountId).sort();
const clientIds: Record<string, string> = {};

// ---- Discovery -----------------------------------------------------------------------------------
test('discovery walks the OU tree and reports which accounts already have the role', async () => {
  const res = await discover();
  assert.equal(res.status, 200);
  assert.equal(res.body.organizationId, 'o-abc123');
  const summary = res.body.accounts.map((a: any) => [a.name, a.ouPath, a.status]);
  assert.deepEqual(summary, [
    ['management', 'Root', 'connected'],
    ['acme-dev', 'Root / Clients / Acme', 'no-role'],
    ['acme-prod', 'Root / Clients / Acme', 'ready'],
    ['globex-prod', 'Root / Clients / Globex', 'ready'],
    ['old-sandbox', 'Root / Clients / Globex', 'suspended'],
  ]);
});

test('discovery explains how to fix a role that cannot read the organization', async () => {
  orgDenied = true;
  const res = await discover();
  orgDenied = false;
  assert.equal(res.status, 400);
  assert.match(res.body.error, /IsOrgManagementAccount=true/);
});

// ---- Client groups ---------------------------------------------------------------------------------
test('client groups need the MSP plan', async () => {
  assert.equal((await call('clients', req(OWNER, 'POST /clients', { name: 'Acme' }))).status, 403);
  tenant().plan = 'msp';
  for (const name of ['Acme', 'Globex']) {
    const res = await call('clients', req(OWNER, 'POST /clients', { name }));
    assert.equal(res.status, 201);
    clientIds[name] = res.body.client.clientId;
  }
  assert.equal((await call('clients', req(OWNER, 'POST /clients', { name: 'acme' }))).status, 409);
});

test('bulk connect adds the ready accounts with their clients and reports the rest', async () => {
  const res = await call('accounts', req(OWNER, 'POST /accounts/bulk', {
    accessLevel: 'Operate',
    accounts: [
      { accountId: ACME_PROD, alias: 'acme-prod', clientId: clientIds.Acme },
      { accountId: ACME_DEV, alias: 'acme-dev', clientId: clientIds.Acme },
      { accountId: GLOBEX, alias: 'globex-prod', clientId: clientIds.Globex },
    ],
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.connected.map((a: any) => [a.alias, a.connectionMethod, a.roleArn]), [
    ['acme-prod', 'organization', `arn:aws:iam::${ACME_PROD}:role/CloudOpsAccessRole`],
    ['globex-prod', 'organization', `arn:aws:iam::${GLOBEX}:role/CloudOpsAccessRole`],
  ]);
  assert.equal(res.body.failed[0].accountId, ACME_DEV);
  const clients = (await call('clients', req(OWNER, 'GET /clients'))).body.clients;
  assert.deepEqual(clients.map((c: any) => [c.name, c.accountCount]), [['Acme', 1], ['Globex', 1]]);
});

test('bulk connect respects the plan account limit', async () => {
  tenant().plan = 'free'; // 3 accounts, all used
  const res = await call('accounts', req(OWNER, 'POST /accounts/bulk', { accounts: [{ accountId: '777777777777', alias: 'x' }] }));
  tenant().plan = 'msp';
  assert.equal(res.status, 403);
});

test('operators cannot discover or connect', async () => {
  // OP joins as an operator limited to Acme.
  const inv = await call('members', req(OWNER, 'POST /members/invites', { email: OP.email, role: 'operator', clientIds: [clientIds.Acme] }));
  assert.equal(inv.status, 201);
  assert.equal((await call('me', req(OP, 'GET /me'))).body.user.role, 'operator');
  assert.equal((await discover(OP)).status, 403);
});

// ---- Client-scoped access -------------------------------------------------------------------------
test("a scoped operator only sees their client's accounts and clients", async () => {
  assert.deepEqual(await accountIds(OP), [ACME_PROD]);
  assert.deepEqual(await accountIds(OWNER), [MGMT, ACME_PROD, GLOBEX].sort());
  const clients = (await call('clients', req(OP, 'GET /clients'))).body.clients;
  assert.deepEqual(clients.map((c: any) => c.name), ['Acme']);
});

test("a scoped operator can't scale or plan events on another client's account", async () => {
  const scale = (accountId: string) =>
    call('capacity', req(OP, 'PUT /asgs/capacity', { asg: { accountId, region: 'us-east-1', asgName: 'web' }, capacity: { min: 1, desired: 2, max: 4 } }));
  assert.equal((await scale(GLOBEX)).status, 404);
  assert.equal((await scale(ACME_PROD)).status, 200);

  const ev = await call('events', req(OP, 'POST /scale-events', {
    name: 'Globex sale', startsAt: new Date(Date.now() + 3600_000).toISOString(), endsAt: new Date(Date.now() + 7200_000).toISOString(),
    targets: [{ asg: { accountId: GLOBEX, region: 'us-east-1', asgName: 'web' }, target: { min: 2, desired: 2, max: 4 } }],
  }));
  assert.equal(ev.status, 404);
});

test("activity only shows a scoped operator their client's entries", async () => {
  const entries = (await call('audit', req(OP, 'GET /audit'))).body.entries;
  assert.ok(entries.length >= 2);
  assert.ok(entries.every((e: any) => (e.asg?.accountId ?? e.accountId) === ACME_PROD));
  const all = (await call('audit', req(OWNER, 'GET /audit'))).body.entries;
  assert.ok(all.some((e: any) => e.accountId === GLOBEX) && all.some((e: any) => e.action === 'client.created'));
});

test('owners and admins always see every client', async () => {
  const bad = await call('members', req(OWNER, 'POST /members/invites', { email: 'a@msp.com', role: 'admin', clientIds: [clientIds.Acme] }));
  assert.equal(bad.status, 400);
  const route = 'PUT /members/{userId}';
  assert.equal((await call('members', req(OWNER, route, { role: 'admin', clientIds: [clientIds.Acme] }, { userId: 'u-op' }))).status, 400);

  const promoted = await call('members', req(OWNER, route, { role: 'admin' }, { userId: 'u-op' }));
  assert.equal(promoted.body.member.clientIds, undefined);
  assert.equal((await accountIds(OP)).length, 3);

  await call('members', req(OWNER, route, { role: 'operator', clientIds: [clientIds.Acme] }, { userId: 'u-op' }));
  assert.deepEqual(await accountIds(OP), [ACME_PROD]);
});

test('deleting a client unassigns its accounts, and people limited to it lose access', async () => {
  assert.equal((await call('clients', req(OWNER, 'DELETE /clients/{clientId}', undefined, { clientId: clientIds.Acme }))).status, 200);
  assert.deepEqual(await accountIds(OP), []);
  assert.equal(store.get(`TENANT#t1|ACCOUNT#${ACME_PROD}`)!.clientId, undefined);
});
