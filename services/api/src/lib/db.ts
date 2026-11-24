/**
 * DynamoDB access. One table, items grouped by partition key:
 *
 *   pk = USER#<userId>      sk = PROFILE              -> which tenant the user belongs to
 *   pk = USER#<userId>      sk = TENANT#<tenantId>    -> membership (role)
 *   pk = TENANT#<tenantId>  sk = META                 -> tenant
 *   pk = TENANT#<tenantId>  sk = ACCOUNT#<accountId>  -> connected AWS account
 *   pk = TENANT#<tenantId>  sk = AUDIT#<time>#<id>    -> audit entry
 *   pk = TENANT#<tenantId>  sk = EVENT#<eventId>      -> scale event
 *   pk = TENANT#<tenantId>  sk = SCHEDULE#<id>        -> recurring schedule
 *   pk = TENANT#<tenantId>  sk = SETTINGS             -> notifications and integrations
 *   pk = TENANT#<tenantId>  sk = INSIGHTS             -> latest insights sweep
 *   pk = TENANT#<tenantId>  sk = MEMBER#<userId>      -> membership, tenant side (team list)
 *   pk = TENANT#<tenantId>  sk = INVITE#<inviteId>    -> invite
 *   pk = INVITEE#<email>    sk = INVITE#<t>#<id>      -> pointer: invites waiting for an email
 *   pk = TENANT#<tenantId>  sk = APPROVAL#<id>        -> approval request (ids sort by time)
 *   pk = TENANT#<tenantId>  sk = CLIENT#<clientId>    -> MSP client group
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  ApprovalRequest,
  AuditEntry,
  Client,
  Invite,
  Member,
  AwsAccount,
  InsightsReport,
  Membership,
  ScaleEvent,
  ScaleSchedule,
  Tenant,
  WorkspaceSettings,
} from '@cloud-ops/shared';

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
  event: (tenantId: string, eventId: string) => ({ pk: `TENANT#${tenantId}`, sk: `EVENT#${eventId}` }),
  schedule: (tenantId: string, scheduleId: string) => ({ pk: `TENANT#${tenantId}`, sk: `SCHEDULE#${scheduleId}` }),
  member: (tenantId: string, userId: string) => ({ pk: `TENANT#${tenantId}`, sk: `MEMBER#${userId}` }),
  invite: (tenantId: string, inviteId: string) => ({ pk: `TENANT#${tenantId}`, sk: `INVITE#${inviteId}` }),
  invitee: (email: string, tenantId: string, inviteId: string) => ({ pk: `INVITEE#${email}`, sk: `INVITE#${tenantId}#${inviteId}` }),
  approval: (tenantId: string, requestId: string) => ({ pk: `TENANT#${tenantId}`, sk: `APPROVAL#${requestId}` }),
  client: (tenantId: string, clientId: string) => ({ pk: `TENANT#${tenantId}`, sk: `CLIENT#${clientId}` }),
};

/** Ids that sort by creation time (newest last), for approvals. */
export function timeSortableId(): string {
  return `${Date.now().toString(36).padStart(9, '0')}${randomBytes(4).toString('hex')}`;
}

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

/** Every workspace the user belongs to. */
export async function listMembershipsForUser(userId: string): Promise<Membership[]> {
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'TENANT#' },
  });
  return items.map((i) => strip<Membership>(i));
}

export async function getMembership(userId: string, tenantId: string): Promise<Membership | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.membership(userId, tenantId) }));
  return res.Item ? strip<Membership>(res.Item) : undefined;
}

/** The workspace the user last chose (PROFILE.tenantId). */
export async function getActiveTenantId(userId: string): Promise<string | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.profile(userId) }));
  return res.Item?.tenantId as string | undefined;
}

export async function setActiveTenantId(userId: string, tenantId: string): Promise<void> {
  await ddb.send(
    new PutCommand({ TableName: TABLE, Item: { ...keys.profile(userId), tenantId, updatedAt: new Date().toISOString() } }),
  );
}

export async function deleteProfile(userId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: keys.profile(userId) }));
}

/** Writes both sides of a membership: the user's list of workspaces and the team list. */
export async function putMembership(m: Member): Promise<void> {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: { ...keys.membership(m.userId, m.tenantId), ...m } } },
        { Put: { TableName: TABLE, Item: { ...keys.member(m.tenantId, m.userId), ...m } } },
      ],
    }),
  );
}

export async function deleteMembership(tenantId: string, userId: string): Promise<void> {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: TABLE, Key: keys.membership(userId, tenantId) } },
        { Delete: { TableName: TABLE, Key: keys.member(tenantId, userId) } },
      ],
    }),
  );
}

export async function listMembers(tenantId: string): Promise<Member[]> {
  return listByPrefix<Member>(tenantId, 'MEMBER#');
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export async function putInvite(invite: Invite): Promise<void> {
  const pointer = keys.invitee(invite.email, invite.tenantId, invite.inviteId);
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: { ...keys.invite(invite.tenantId, invite.inviteId), ...invite } } },
        invite.status === 'pending'
          ? { Put: { TableName: TABLE, Item: { ...pointer, tenantId: invite.tenantId, inviteId: invite.inviteId } } }
          : { Delete: { TableName: TABLE, Key: pointer } },
      ],
    }),
  );
}

export async function getInvite(tenantId: string, inviteId: string): Promise<Invite | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.invite(tenantId, inviteId) }));
  return res.Item ? strip<Invite>(res.Item) : undefined;
}

export async function listInvites(tenantId: string): Promise<Invite[]> {
  return listByPrefix<Invite>(tenantId, 'INVITE#');
}

/** Pending invites addressed to this email, across all workspaces. */
export async function listInvitesForEmail(email: string): Promise<Invite[]> {
  const pointers = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': `INVITEE#${email.toLowerCase()}`, ':prefix': 'INVITE#' },
  });
  const invites = await Promise.all(pointers.map((p) => getInvite(p.tenantId as string, p.inviteId as string)));
  return invites.filter((i): i is Invite => !!i && i.status === 'pending');
}

// ---------------------------------------------------------------------------
// MSP clients
// ---------------------------------------------------------------------------

export const listClients = (tenantId: string) => listByPrefix<Client>(tenantId, 'CLIENT#');

export async function putClient(c: Client): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.client(c.tenantId, c.clientId), ...c } }));
}

export async function deleteClient(tenantId: string, clientId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: keys.client(tenantId, clientId) }));
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export async function putApproval(a: ApprovalRequest): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.approval(a.tenantId, a.requestId), ...a } }));
}

/** Saves a decision only if the request is still pending, so two admins can't both apply it. */
export async function claimApproval(a: ApprovalRequest): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { ...keys.approval(a.tenantId, a.requestId), ...a },
        ConditionExpression: '#s = :pending',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':pending': 'pending' },
      }),
    );
    return true;
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export async function getApproval(tenantId: string, requestId: string): Promise<ApprovalRequest | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.approval(tenantId, requestId) }));
  return res.Item ? strip<ApprovalRequest>(res.Item) : undefined;
}

export async function listApprovals(tenantId: string): Promise<ApprovalRequest[]> {
  return listByPrefix<ApprovalRequest>(tenantId, 'APPROVAL#');
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
          { Put: { TableName: TABLE, Item: { ...keys.member(tenantId, userId), ...membership, joinedAt: now } } },
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

// ---------------------------------------------------------------------------
// Scale events and recurring schedules
// ---------------------------------------------------------------------------

async function listByPrefix<T>(tenantId: string, prefix: string): Promise<T[]> {
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':prefix': prefix },
  });
  return items.map((i) => strip<T>(i));
}

export const listEvents = (tenantId: string) => listByPrefix<ScaleEvent>(tenantId, 'EVENT#');
export const listSchedules = (tenantId: string) => listByPrefix<ScaleSchedule>(tenantId, 'SCHEDULE#');

export async function getEvent(tenantId: string, eventId: string): Promise<ScaleEvent | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.event(tenantId, eventId) }));
  return res.Item ? strip<ScaleEvent>(res.Item) : undefined;
}

export async function putEvent(event: ScaleEvent): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.event(event.tenantId, event.eventId), ...event } }));
}

export async function getSchedule(tenantId: string, scheduleId: string): Promise<ScaleSchedule | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.schedule(tenantId, scheduleId) }));
  return res.Item ? strip<ScaleSchedule>(res.Item) : undefined;
}

export async function putSchedule(schedule: ScaleSchedule): Promise<void> {
  await ddb.send(
    new PutCommand({ TableName: TABLE, Item: { ...keys.schedule(schedule.tenantId, schedule.scheduleId), ...schedule } }),
  );
}

export async function deleteScheduleItem(tenantId: string, scheduleId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: keys.schedule(tenantId, scheduleId) }));
}

// ---------------------------------------------------------------------------
// Settings, insights, audit queries
// ---------------------------------------------------------------------------

export async function getSettingsItem(tenantId: string): Promise<WorkspaceSettings | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: `TENANT#${tenantId}`, sk: 'SETTINGS' } }));
  return res.Item ? strip<WorkspaceSettings>(res.Item) : undefined;
}

export async function putSettingsItem(settings: WorkspaceSettings): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: `TENANT#${settings.tenantId}`, sk: 'SETTINGS', ...settings } }));
}

export async function getInsightsReport(tenantId: string): Promise<InsightsReport | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: `TENANT#${tenantId}`, sk: 'INSIGHTS' } }));
  return res.Item ? strip<InsightsReport>(res.Item) : undefined;
}

export async function putInsightsReport(report: InsightsReport): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: `TENANT#${report.tenantId}`, sk: 'INSIGHTS', ...report } }));
}

/** Newest audit entries first. `cursor` is the sk of the last entry from the previous page. */
export async function listAudit(
  tenantId: string,
  limit: number,
  cursor?: string,
): Promise<{ entries: AuditEntry[]; nextCursor?: string }> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':prefix': 'AUDIT#' },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: cursor ? { pk: `TENANT#${tenantId}`, sk: cursor } : undefined,
    }),
  );
  const entries = (res.Items ?? []).map((i) => strip<AuditEntry>(i));
  const last = res.LastEvaluatedKey?.sk;
  return { entries, nextCursor: typeof last === 'string' ? last : undefined };
}

/** Audit entries since a point in time, oldest first. */
export async function listAuditSince(tenantId: string, sinceIso: string): Promise<AuditEntry[]> {
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':from': `AUDIT#${sinceIso}`, ':to': 'AUDIT#~' },
  });
  return items.map((i) => strip<AuditEntry>(i));
}

/** Every tenant id (for the background sweep). Fine at this scale; add a GSI when tenants grow. */
export async function listTenantIds(): Promise<string[]> {
  const ids: string[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: 'sk = :meta AND begins_with(pk, :tenant)',
        ExpressionAttributeValues: { ':meta': 'META', ':tenant': 'TENANT#' },
        ProjectionExpression: 'tenantId',
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) if (typeof item.tenantId === 'string') ids.push(item.tenantId);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return ids;
}
