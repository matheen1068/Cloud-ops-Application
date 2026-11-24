// Plan usage for customers and plan changes by the platform operator.
// Run: npm test -w @cloud-ops/api
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

Object.assign(process.env, {
  TABLE_NAME: 'test-table',
  AWS_REGION: 'us-east-1',
  PLATFORM_ACCOUNT_ID: '999999999999',
  PLATFORM_ROLE_NAME: 'CloudOpsPlatformRole',
  ACCESS_ROLE_NAME: 'CloudOpsAccessRole',
  OPERATOR_EMAILS: 'Founder@CloudOps.dev, ops@cloudops.dev',
});

type Item = Record<string, any>;
const store = new Map<string, Item>();
const key = (i: Item) => `${i.pk}|${i.sk}`;
const put = (i: Item) => store.set(key(i), structuredClone(i));
const ddb = mockClient(DynamoDBDocumentClient);
ddb.on(GetCommand).callsFake((input) => ({ Item: structuredClone(store.get(key(input.Key))) }));
ddb.on(PutCommand).callsFake((input) => (put(input.Item), {}));
ddb.on(ScanCommand).callsFake(() => ({ Items: [...store.values()].filter((i) => i.sk === 'META').map((i) => structuredClone(i)) }));
ddb.on(QueryCommand).callsFake((input) => {
  const v = input.ExpressionAttributeValues;
  return { Items: [...store.values()].filter((i) => i.pk === v[':pk'] && (!v[':prefix'] || i.sk.startsWith(v[':prefix']))).map((i) => structuredClone(i)) };
});

for (const [t, owner, plan, createdAt] of [['t1', 'a@acme.com', 'free', '2026-11-01'], ['t2', 'founder@cloudops.dev', 'pro', '2026-11-20']]) {
  put({ pk: `USER#u-${t}`, sk: 'PROFILE', tenantId: t });
  put({ pk: `USER#u-${t}`, sk: `TENANT#${t}`, tenantId: t, userId: `u-${t}`, email: owner, role: 'owner' });
  put({ pk: `TENANT#${t}`, sk: `MEMBER#u-${t}`, tenantId: t, userId: `u-${t}`, email: owner, role: 'owner' });
  put({ pk: `TENANT#${t}`, sk: 'META', tenantId: t, name: `${t} workspace`, plan, externalId: 'x'.repeat(32), createdAt });
}
put({ pk: 'TENANT#t1', sk: 'ACCOUNT#111111111111', tenantId: 't1', accountId: '111111111111', status: 'connected' });
put({ pk: 'TENANT#t1', sk: 'INVITE#i1', tenantId: 't1', inviteId: 'i1', email: 'b@acme.com', role: 'viewer', status: 'pending', expiresAt: '2999-01-01T00:00:00Z' });

const CUSTOMER = { sub: 'u-t1', email: 'a@acme.com' };
const OPERATOR = { sub: 'u-t2', email: 'founder@cloudops.dev' };
function req(who: { sub: string; email: string }, routeKey: string, body?: unknown, extra: Record<string, unknown> = {}, verified = 'true'): any {
  return {
    routeKey,
    requestContext: { http: { method: routeKey.split(' ')[0] }, authorizer: { jwt: { claims: { sub: who.sub, email: who.email, email_verified: verified } } } },
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
const setPlan = (who: typeof CUSTOMER, tenantId: string, plan: string, verified = 'true') =>
  call('platform', req(who, 'PUT /platform/tenants/{tenantId}', { plan }, { pathParameters: { tenantId } }, verified));

test('members see usage against their plan, pending invites included', async () => {
  const res = await call('platform', req(CUSTOMER, 'GET /plan'));
  assert.deepEqual({ ...res.body.usage, limits: undefined }, { plan: 'free', accounts: 1, users: 2, limits: undefined });
  assert.equal(res.body.usage.limits.maxAwsAccounts, 3);
});

test('only the platform operator, with a verified email, sees workspaces and changes plans', async () => {
  assert.equal((await call('platform', req(CUSTOMER, 'GET /platform/tenants'))).status, 403);
  assert.equal((await setPlan(CUSTOMER, 't1', 'msp')).status, 403);
  assert.equal((await setPlan(OPERATOR, 't1', 'msp', 'false')).status, 403, 'unverified email');
  assert.equal((await call('me', req(CUSTOMER, 'GET /me'))).body.platformOperator, undefined);
  assert.equal((await call('me', req(OPERATOR, 'GET /me'))).body.platformOperator, true, 'matching is case-insensitive');
});

test('the operator lists every workspace, newest first, and changes a plan with an audit entry', async () => {
  const list = await call('platform', req(OPERATOR, 'GET /platform/tenants'));
  assert.deepEqual(list.body.tenants.map((t: any) => [t.tenantId, t.plan, t.owners, t.accounts]), [
    ['t2', 'pro', ['founder@cloudops.dev'], 0],
    ['t1', 'free', ['a@acme.com'], 1],
  ]);

  assert.equal((await setPlan(OPERATOR, 't1', 'enterprise')).status, 400);
  const res = await setPlan(OPERATOR, 't1', 'msp');
  assert.equal(res.body.tenant.plan, 'msp');
  assert.equal((await call('platform', req(CUSTOMER, 'GET /plan'))).body.usage.limits.clientGroups, true);
  const audit = [...store.values()].find((i) => i.action === 'plan.changed')!;
  assert.equal(audit.tenantId, 't1');
  assert.match(audit.message, /free → msp/);
});
