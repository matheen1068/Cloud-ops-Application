// Workspace settings: notification channels and integrations.
// Secrets (Slack URL, DevOps Agent secret) are stored server-side and only ever returned masked.
import {
  DEFAULT_NOTIFY_ON,
  type SettingsView,
  type UpdateSettingsRequest,
  type WorkspaceSettings,
} from '@cloud-ops/shared';
import { getSettingsItem, putSettingsItem } from './db.js';
import { HttpError } from './http.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function getSettings(tenantId: string): Promise<WorkspaceSettings> {
  const stored = await getSettingsItem(tenantId);
  return {
    tenantId,
    emailRecipients: [],
    leftoverHours: 6,
    ...stored,
    notifyOn: { ...DEFAULT_NOTIFY_ON, ...stored?.notifyOn },
  };
}

export const emailAvailable = () => !!process.env.SENDER_EMAIL;

/** Shows enough to recognise the value, never enough to reuse it. */
function hint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}/…${url.slice(-4)}`;
  } catch {
    return `…${url.slice(-4)}`;
  }
}

export function toView(s: WorkspaceSettings): SettingsView {
  return {
    slack: { configured: !!s.slackWebhookUrl, hint: s.slackWebhookUrl ? hint(s.slackWebhookUrl) : undefined },
    email: { available: emailAvailable(), recipients: s.emailRecipients },
    devopsAgent: {
      configured: !!s.devopsAgent,
      auth: s.devopsAgent?.auth,
      hint: s.devopsAgent ? hint(s.devopsAgent.webhookUrl) : undefined,
    },
    notifyOn: s.notifyOn,
    leftoverHours: s.leftoverHours,
  };
}

function httpsHost(url: string, field: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, `${field} is not a valid URL.`);
  }
  if (u.protocol !== 'https:') throw new HttpError(400, `${field} must use https.`);
  return u.host;
}

export async function updateSettings(
  tenantId: string,
  email: string,
  req: UpdateSettingsRequest,
): Promise<WorkspaceSettings> {
  const s = await getSettings(tenantId);

  if (req.slackWebhookUrl === null) delete s.slackWebhookUrl;
  else if (req.slackWebhookUrl !== undefined) {
    if (httpsHost(req.slackWebhookUrl, 'Slack webhook URL') !== 'hooks.slack.com') {
      throw new HttpError(400, 'Use a Slack incoming webhook URL (https://hooks.slack.com/services/…).');
    }
    s.slackWebhookUrl = req.slackWebhookUrl;
  }

  if (req.emailRecipients !== undefined) {
    const list = [...new Set(req.emailRecipients.map((e) => e.trim()).filter(Boolean))];
    if (list.length > 10) throw new HttpError(400, 'Up to 10 email recipients.');
    const bad = list.find((e) => !EMAIL.test(e));
    if (bad) throw new HttpError(400, `Not an email address: ${bad}`);
    s.emailRecipients = list;
  }

  if (req.devopsAgent === null) delete s.devopsAgent;
  else if (req.devopsAgent !== undefined) {
    const { webhookUrl, auth, secret } = req.devopsAgent;
    const host = httpsHost(webhookUrl, 'DevOps Agent webhook URL');
    if (!host.endsWith('.api.aws') && !host.endsWith('.amazonaws.com')) {
      throw new HttpError(400, 'Use the webhook URL from your AWS DevOps Agent Space (…api.aws/webhook/generic/…).');
    }
    if (auth !== 'hmac' && auth !== 'bearer') throw new HttpError(400, 'auth must be hmac or bearer.');
    if (typeof secret !== 'string' || secret.length < 8) throw new HttpError(400, 'Paste the webhook secret or token.');
    s.devopsAgent = { webhookUrl, auth, secret };
  }

  if (req.notifyOn) {
    for (const [k, v] of Object.entries(req.notifyOn)) {
      if (k in s.notifyOn && typeof v === 'boolean') (s.notifyOn as unknown as Record<string, boolean>)[k] = v;
    }
  }

  if (req.leftoverHours !== undefined) {
    if (!Number.isInteger(req.leftoverHours) || req.leftoverHours < 1 || req.leftoverHours > 168) {
      throw new HttpError(400, 'leftoverHours must be 1-168.');
    }
    s.leftoverHours = req.leftoverHours;
  }

  s.updatedAt = new Date().toISOString();
  s.updatedBy = email;
  await putSettingsItem(s);
  return s;
}
