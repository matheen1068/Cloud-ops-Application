/**
 * DynamoDB access. One table, items grouped by partition key:
 *
 *   pk = USER#<userId>      sk = PROFILE              -> which tenant the user belongs to
 *   pk = USER#<userId>      sk = TENANT#<tenantId>    -> membership (role)
 *   pk = TENANT#<tenantId>  sk = META                 -> tenant
 *   pk = TENANT#<tenantId>  sk = ACCOUNT#<accountId>  -> connected AWS account
 *   pk = TENANT#<tenantId>  sk = AUDIT#<time>#<id>    -> audit entry
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AuditEntry, AwsAccount, Membership, Tenant } from '@cloud-ops/shared';

const TABLE = requireEnv('TABLE_NAME');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const keys = {
  profile: (userId: string) => ({ pk: `USER#${userId}`, sk: 'PROFILE' }),
  membership: (userId: string, tenantId: string) => ({ pk: `USER#${userId}`, sk: `TENANT#${tenantId}` }),
  tenant: (tenantId: string) => ({ pk: `TENANT#${tenantId}`, sk: 'META' }),
  account: (tenantId: string, accountId: string) => ({ pk: `TENANT#${tenantId}`, sk: `ACCOUNT#${accountId}` }),
  audit: (tenantId: string, at: string, auditId: string) => ({ pk: `TENANT#${tenantId}`, sk: `AUDIT#${at}#${auditId}` }),
};

/** Removes the table keys before an item leaves the API. */
function strip<T>(item: Record<string, unknown>): T {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest as T;
}

async function queryAll(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// ---------------------------------------------------------------------------
// Tenants and memberships
// ---------------------------------------------------------------------------

export async function getMembershipForUser(userId: string): Promise<Membership | undefined> {
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'TENANT#' },
  });
  // v1: one workspace per user. Picking the first keeps it simple.
  return items[0] ? strip<Membership>(items[0]) : undefined;
}

export async function getTenant(tenantId: string): Promise<Tenant | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.tenant(tenantId) }));
  return res.Item ? strip<Tenant>(res.Item) : undefined;
}

/**
 * First sign-in: creates a free workspace with the user as owner.
 * The PROFILE item is written with a condition, so two parallel first
 * requests can't create two workspaces for the same user.
 */
export async function createTenantForUser(userId: string, email: string): Promise<boolean> {
  const tenantId = randomUUID();
  const now = new Date().toISOString();
  const tenant: Tenant = {
    tenantId,
    name: `${email.split('@')[0]}'s workspace`,
    plan: 'free',
    externalId: randomBytes(24).toString('base64url'),
    createdAt: now,
  };
  const membership: Membership = { tenantId, userId, email, role: 'owner' };

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: { ...keys.profile(userId), tenantId, createdAt: now },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          { Put: { TableName: TABLE, Item: { ...keys.tenant(tenantId), ...tenant } } },
          { Put: { TableName: TABLE, Item: { ...keys.membership(userId, tenantId), ...membership } } },
        ],
      }),
    );
    return true;
  } catch (err) {
    // Another request created the workspace first; the caller just re-reads it.
    if ((err as Error).name === 'TransactionCanceledException') return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Connected AWS accounts
// ---------------------------------------------------------------------------

export async function listAccounts(tenantId: string): Promise<AwsAccount[]> {
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':prefix': 'ACCOUNT#' },
  });
  return items.map((i) => strip<AwsAccount>(i));
}

export async function getAccount(tenantId: string, accountId: string): Promise<AwsAccount | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.account(tenantId, accountId) }));
  return res.Item ? strip<AwsAccount>(res.Item) : undefined;
}

export async function putAccount(account: AwsAccount): Promise<void> {
  await ddb.send(
    new PutCommand({ TableName: TABLE, Item: { ...keys.account(account.tenantId, account.accountId), ...account } }),
  );
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

// TS: Omit<T, K> is T without the listed fields.
export async function writeAudit(entry: Omit<AuditEntry, 'auditId' | 'at'>): Promise<void> {
  const at = new Date().toISOString();
  const auditId = randomUUID();
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...keys.audit(entry.tenantId, at, auditId), ...entry, auditId, at },
    }),
  );
}
