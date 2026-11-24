/**
 * Organization discovery. From a connected management account (role deployed with
 * IsOrgManagementAccount=true), walk the OU tree, list member accounts, and check which
 * already have CloudOpsAccessRole (usually deployed by the StackSet).
 */
import {
  DescribeOrganizationCommand,
  ListRootsCommand,
  OrganizationsClient,
  paginateListAccountsForParent,
  paginateListOrganizationalUnitsForParent,
} from '@aws-sdk/client-organizations';
import type { AwsAccount, DiscoveredAccount, DiscoveryResult, Tenant } from '@cloud-ops/shared';
import { accountIdOf, assumeAccessRole } from './aws.js';
import { requireEnv } from './db.js';
import { HttpError } from './http.js';

const MAX_OUS = 200;
const MAX_ACCOUNTS = 300;
const CONCURRENCY = 8;

export function memberRoleArn(managementRoleArn: string, accountId: string): string {
  const partition = managementRoleArn.split(':')[1] || 'aws';
  return `arn:${partition}:iam::${accountId}:role/${requireEnv('ACCESS_ROLE_NAME')}`;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function explain(err: unknown): never {
  const e = err as Error;
  if (e.name === 'AWSOrganizationsNotInUseException') throw new HttpError(400, 'This account is not part of an AWS Organization.');
  if (e.name === 'AccessDeniedException' || e.name === 'AccessDenied' || /not authorized/i.test(e.message)) {
    throw new HttpError(400, "This account's role can't read the organization. Connect the management account with the role deployed using IsOrgManagementAccount=true.");
  }
  throw new HttpError(502, `AWS Organizations: ${e.message}`);
}

export async function discoverOrganization(tenant: Tenant, management: AwsAccount, connected: AwsAccount[]): Promise<DiscoveryResult> {
  const credentials = await assumeAccessRole(management.roleArn, tenant.externalId, tenant.tenantId);
  const org = new OrganizationsClient({ region: 'us-east-1', credentials });

  let organizationId: string | undefined;
  const found: { accountId: string; name: string; ouPath: string; active: boolean }[] = [];
  let truncated = false;
  try {
    organizationId = (await org.send(new DescribeOrganizationCommand({}))).Organization?.Id;
    const roots = (await org.send(new ListRootsCommand({}))).Roots ?? [];
    const queue = roots.map((r) => ({ id: r.Id!, path: 'Root' }));
    let ous = 0;
    while (queue.length) {
      const parent = queue.shift()!;
      for await (const page of paginateListAccountsForParent({ client: org }, { ParentId: parent.id })) {
        for (const a of page.Accounts ?? []) {
          found.push({ accountId: a.Id!, name: a.Name ?? a.Id!, ouPath: parent.path, active: (a.State ?? a.Status) === 'ACTIVE' });
        }
      }
      for await (const page of paginateListOrganizationalUnitsForParent({ client: org }, { ParentId: parent.id })) {
        for (const ou of page.OrganizationalUnits ?? []) {
          if (++ous > MAX_OUS) {
            truncated = true;
            continue;
          }
          queue.push({ id: ou.Id!, path: `${parent.path} / ${ou.Name}` });
        }
      }
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    explain(err);
  }

  if (found.length > MAX_ACCOUNTS) truncated = true;
  const connectedIds = new Set(connected.map((a) => a.accountId));
  const accounts: DiscoveredAccount[] = await mapLimit(found.slice(0, MAX_ACCOUNTS), CONCURRENCY, async (a) => {
    const base = { accountId: a.accountId, name: a.name, ouPath: a.ouPath };
    if (connectedIds.has(a.accountId)) return { ...base, status: 'connected' as const };
    if (!a.active) return { ...base, status: 'suspended' as const };
    try {
      const creds = await assumeAccessRole(memberRoleArn(management.roleArn, a.accountId), tenant.externalId, tenant.tenantId);
      if ((await accountIdOf(creds)) !== a.accountId) throw new Error('Role answered from a different account.');
      return { ...base, status: 'ready' as const };
    } catch (err) {
      return { ...base, status: 'no-role' as const, message: (err as Error).message.slice(0, 200) };
    }
  });

  accounts.sort((x, y) => x.ouPath.localeCompare(y.ouPath) || x.name.localeCompare(y.name));
  return { organizationId, managementAccountId: management.accountId, accounts, truncated: truncated || undefined };
}
