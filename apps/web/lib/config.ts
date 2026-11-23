// Runtime config, loaded from /config.json before the app renders.
// - Hosted (CloudFront): CDK writes config.json from the stack outputs on every deploy.
// - Local dev: `npm run config -w @cloud-ops/web` pulls the same values into public/config.json.

export interface AppConfig {
  apiUrl: string;
  region: string;
  userPoolId: string;
  userPoolClientId: string;
}

let current: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('config.json not found');
  const raw = (await res.json()) as AppConfig;
  if (!raw.apiUrl || !raw.userPoolId || !raw.userPoolClientId) {
    throw new Error('config.json is missing apiUrl, userPoolId or userPoolClientId');
  }
  current = { ...raw, apiUrl: raw.apiUrl.replace(/\/$/, '') };
  return current;
}

export function getConfig(): AppConfig {
  if (!current) throw new Error('Config not loaded yet');
  return current;
}
