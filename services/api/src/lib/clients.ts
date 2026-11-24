// MSP client groups: end customers whose AWS accounts the MSP manages.
import { randomUUID } from 'node:crypto';
import { PLAN_LIMITS, type Client, type ClientRequest, type ClientView, type Membership, type Tenant } from '@cloud-ops/shared';
import { deleteClient, listAccounts, listClients, putAccount, putClient, writeAudit } from './db.js';
import { HttpError } from './http.js';
import { isScoped } from './scope.js';
import type { Caller } from './tenant.js';

export function requireClientGroups(tenant: Tenant): void {
  if (!PLAN_LIMITS[tenant.plan].clientGroups) throw new HttpError(403, 'Client groups are part of the MSP plan.');
}

function cleanName(req: ClientRequest): string {
  const name = typeof req?.name === 'string' ? req.name.trim() : '';
  if (name.length < 1 || name.length > 64) throw new HttpError(400, 'name must be 1-64 characters.');
  return name;
}

export async function clientViews(tenant: Tenant, membership: Membership): Promise<ClientView[]> {
  const [clients, accounts] = await Promise.all([listClients(tenant.tenantId), listAccounts(tenant.tenantId)]);
  return clients
    .filter((c) => !isScoped(membership) || membership.clientIds!.includes(c.clientId))
    .map((c) => ({ ...c, accountCount: accounts.filter((a) => a.clientId === c.clientId).length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createClient(tenant: Tenant, caller: Caller, req: ClientRequest): Promise<Client> {
  requireClientGroups(tenant);
  const name = cleanName(req);
  const existing = await listClients(tenant.tenantId);
  if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `A client called "${name}" already exists.`);
  if (existing.length >= 500) throw new HttpError(400, 'A workspace can have up to 500 clients.');
  const client: Client = { tenantId: tenant.tenantId, clientId: randomUUID(), name, createdAt: new Date().toISOString() };
  await putClient(client);
  await writeAudit({ tenantId: tenant.tenantId, actor: { userId: caller.userId, email: caller.email }, action: 'client.created', result: 'success', message: name });
  return client;
}

export async function renameClient(tenant: Tenant, caller: Caller, clientId: string, req: ClientRequest): Promise<Client> {
  const name = cleanName(req);
  const clients = await listClients(tenant.tenantId);
  const client = clients.find((c) => c.clientId === clientId);
  if (!client) throw new HttpError(404, 'Client not found.');
  if (clients.some((c) => c.clientId !== clientId && c.name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(409, `A client called "${name}" already exists.`);
  }
  const updated = { ...client, name };
  await putClient(updated);
  await writeAudit({ tenantId: tenant.tenantId, actor: { userId: caller.userId, email: caller.email }, action: 'client.updated', result: 'success', message: `${client.name} → ${name}` });
  return updated;
}

/** Deleting a client unassigns its accounts. People limited to it then see nothing for it. */
export async function removeClient(tenant: Tenant, caller: Caller, clientId: string): Promise<void> {
  const client = (await listClients(tenant.tenantId)).find((c) => c.clientId === clientId);
  if (!client) throw new HttpError(404, 'Client not found.');
  for (const account of await listAccounts(tenant.tenantId)) {
    if (account.clientId === clientId) await putAccount({ ...account, clientId: undefined });
  }
  await deleteClient(tenant.tenantId, clientId);
  await writeAudit({ tenantId: tenant.tenantId, actor: { userId: caller.userId, email: caller.email }, action: 'client.deleted', result: 'success', message: client.name });
}

/** Checks client ids exist (and the plan has client groups). Returns them de-duplicated. */
export async function validClientIds(tenant: Tenant, ids: unknown): Promise<string[]> {
  requireClientGroups(tenant);
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== 'string')) {
    throw new HttpError(400, 'clientIds must be a non-empty list of client ids.');
  }
  const known = new Set((await listClients(tenant.tenantId)).map((c) => c.clientId));
  const unknown = (ids as string[]).find((i) => !known.has(i));
  if (unknown) throw new HttpError(400, `Unknown client: ${unknown}`);
  return [...new Set(ids as string[])];
}
