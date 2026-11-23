// Typed client for the Cloud-Ops API. Request/response types are shared with the Lambdas.
import type {
  AwsAccount,
  CapacityChangeRequest,
  CapacitySettings,
  ConnectAccountRequest,
  ListAsgsResponse,
  MeResponse,
} from '@cloud-ops/shared';
import { idToken } from './auth';
import { getConfig } from './config';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(getConfig().apiUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${await idToken()}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  me: () => request<MeResponse>('GET', '/me'),
  listAccounts: () => request<{ accounts: AwsAccount[] }>('GET', '/accounts'),
  connectAccount: (req: ConnectAccountRequest) => request<{ account: AwsAccount }>('POST', '/accounts', req),
  listAsgs: () => request<ListAsgsResponse>('GET', '/asgs'),
  setCapacity: (req: CapacityChangeRequest) =>
    request<{ before: CapacitySettings; after: CapacitySettings }>('PUT', '/asgs/capacity', req),
};
