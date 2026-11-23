/**
 * Notifications: Slack, email (SES, optional) and the customer's own AWS DevOps Agent.
 * Notifying must never break an operation, so every channel is best-effort and errors
 * are only logged.
 */
import { createHmac } from 'node:crypto';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { WorkspaceSettings } from '@cloud-ops/shared';
import { getSettings } from './settings.js';

export type NoticeKind = 'event-started' | 'event-completed' | 'failure' | 'leftovers' | 'test';

export interface Notice {
  kind: NoticeKind;
  level: 'info' | 'warn' | 'error';
  title: string;
  lines: string[];
  /** Failures only: also open an investigation in the customer's DevOps Agent. */
  incident?: { id: string; priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'; service: string };
}

const ICON = { info: '✅', warn: '⚠️', error: '🚨' } as const;
const ses = new SESv2Client({});

function wanted(s: WorkspaceSettings, kind: NoticeKind): boolean {
  switch (kind) {
    case 'event-started':
      return s.notifyOn.eventStarted;
    case 'event-completed':
      return s.notifyOn.eventCompleted;
    case 'failure':
      return s.notifyOn.failures;
    case 'leftovers':
      return s.notifyOn.leftovers;
    default:
      return true;
  }
}

export async function notify(tenantId: string, notice: Notice): Promise<void> {
  try {
    const settings = await getSettings(tenantId);
    if (!wanted(settings, notice.kind)) return;
    await Promise.allSettled([
      settings.slackWebhookUrl ? sendSlack(settings.slackWebhookUrl, notice) : null,
      settings.emailRecipients.length ? sendEmail(settings.emailRecipients, notice) : null,
      notice.incident && settings.devopsAgent ? sendToDevOpsAgent(settings.devopsAgent, notice) : null,
    ]);
  } catch (err) {
    console.error('notify failed', err);
  }
}

export async function sendSlack(url: string, notice: Notice): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `${ICON[notice.level]} *${notice.title}*\n${notice.lines.map((l) => `• ${l}`).join('\n')}` }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Slack answered ${res.status}`);
}

async function sendEmail(to: string[], notice: Notice): Promise<void> {
  const from = process.env.SENDER_EMAIL;
  if (!from) return;
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: to },
      Content: {
        Simple: {
          Subject: { Data: `[Cloud-Ops] ${notice.title}` },
          Body: { Text: { Data: `${notice.title}\n\n${notice.lines.map((l) => `- ${l}`).join('\n')}\n` } },
        },
      },
    }),
  );
}

/** DevOps Agent's documented timestamp format: %Y-%m-%dT%H:%M:%S.000Z */
export function agentTimestamp(d = new Date()): string {
  return `${d.toISOString().slice(0, 19)}.000Z`;
}

/** HMAC-SHA256 over "<timestamp>:<payload>" with the webhook secret, Base64-encoded. */
export function signAgentPayload(secret: string, timestamp: string, payload: string): string {
  return createHmac('sha256', secret).update(`${timestamp}:${payload}`, 'utf8').digest('base64');
}

/**
 * Opens an investigation in the customer's own AWS DevOps Agent Space (billed to them).
 * Only title, description, priority and the incident id reach the agent, so the
 * useful context goes into the description.
 */
export async function sendToDevOpsAgent(agent: NonNullable<WorkspaceSettings['devopsAgent']>, notice: Notice): Promise<void> {
  if (!notice.incident) return;
  const timestamp = agentTimestamp();
  const payload = JSON.stringify({
    eventType: 'incident',
    incidentId: notice.incident.id,
    action: 'created',
    priority: notice.incident.priority,
    title: notice.title,
    description: notice.lines.join('\n'),
    timestamp,
    service: notice.incident.service,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-amzn-event-timestamp': timestamp,
  };
  if (agent.auth === 'hmac') headers['x-amzn-event-signature'] = signAgentPayload(agent.secret, timestamp, payload);
  else headers.Authorization = `Bearer ${agent.secret}`;

  const res = await fetch(agent.webhookUrl, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`DevOps Agent answered ${res.status}`);
}
