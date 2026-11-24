/**
 * MSP access scoping. An operator or viewer can be limited to some clients
 * (Membership.clientIds). They then only see and act on accounts assigned to those clients.
 * Owners and admins always see the whole workspace.
 *
 * Hidden accounts answer "not connected" (404), so a scoped user can't probe for them.
 */
import type { AwsAccount, Membership } from '@cloud-ops/shared';
import { listAccounts } from './db.js';
import { HttpError } from './http.js';

export function isScoped(m: Membership): boolean {
  return Array.isArray(m.clientIds) && m.role !== 'owner' && m.role !== 'admin';
}

export function canSeeAccount(m: Membership, account: Pick<AwsAccount, 'clientId'> | undefined): boolean {
  if (!isScoped(m)) return true;
  return !!account?.clientId && m.clientIds!.includes(account.clientId);
}

export async function visibleAccounts(tenantId: string, m: Membership): Promise<AwsAccount[]> {
  return (await listAccounts(tenantId)).filter((a) => canSeeAccount(m, a));
}

/** null = everything is visible. */
export async function visibleAccountIds(tenantId: string, m: Membership): Promise<Set<string> | null> {
  if (!isScoped(m)) return null;
  return new Set((await visibleAccounts(tenantId, m)).map((a) => a.accountId));
}

export async function assertAccountsVisible(tenantId: string, m: Membership, accountIds: string[]): Promise<void> {
  const visible = await visibleAccountIds(tenantId, m);
  const hidden = visible && accountIds.find((id) => !visible.has(id));
  if (hidden) throw new HttpError(404, `Account ${hidden} is not connected.`);
}

/** Keeps items whose accounts are all visible. */
export function filterByAccounts<T>(items: T[], visible: Set<string> | null, accountsOf: (item: T) => (string | undefined)[]): T[] {
  if (!visible) return items;
  return items.filter((i) => {
    const ids = accountsOf(i).filter((id): id is string => !!id);
    return ids.length > 0 && ids.every((id) => visible.has(id));
  });
}
