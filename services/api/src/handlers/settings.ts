// GET  /settings        notifications and integrations (secrets masked)
// PUT  /settings        update (owners and admins)
// POST /settings/test   send a test message to every configured channel
import type { UpdateSettingsRequest } from '@cloud-ops/shared';
import { writeAudit } from '../lib/db.js';
import { handle, HttpError, json, parseBody } from '../lib/http.js';
import { sendSlack, sendToDevOpsAgent } from '../lib/notify.js';
import { getSettings, toView, updateSettings } from '../lib/settings.js';
import { ADMIN_ROLES, getCaller, requireRole, resolveTenant } from '../lib/tenant.js';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

export const handler = handle(async (event) => {
  const caller = getCaller(event);
  const { tenant, membership } = await resolveTenant(caller);

  switch (event.routeKey) {
    case 'GET /settings':
      return json(200, { settings: toView(await getSettings(tenant.tenantId)) });

    case 'PUT /settings': {
      requireRole(membership, ADMIN_ROLES);
      const updated = await updateSettings(tenant.tenantId, caller.email, parseBody<UpdateSettingsRequest>(event));
      await writeAudit({
        tenantId: tenant.tenantId,
        actor: { userId: caller.userId, email: caller.email },
        action: 'settings.updated',
        result: 'success',
      });
      return json(200, { settings: toView(updated) });
    }

    case 'POST /settings/test': {
      requireRole(membership, ADMIN_ROLES);
      const s = await getSettings(tenant.tenantId);
      const notice = {
        kind: 'test' as const,
        level: 'info' as const,
        title: 'Cloud-Ops test notification',
        lines: [`Sent by ${caller.email}. If you can read this, notifications work.`],
      };
      // Test each channel separately so the UI can say exactly which one failed.
      const results: Record<string, string> = {};
      const run = async (name: string, fn: () => Promise<void>) => {
        try {
          await fn();
          results[name] = 'ok';
        } catch (err) {
          results[name] = (err as Error).message;
        }
      };
      if (s.slackWebhookUrl) await run('slack', () => sendSlack(s.slackWebhookUrl!, notice));
      if (s.emailRecipients.length && process.env.SENDER_EMAIL) {
        await run('email', async () => {
          await new SESv2Client({}).send(
            new SendEmailCommand({
              FromEmailAddress: process.env.SENDER_EMAIL,
              Destination: { ToAddresses: s.emailRecipients },
              Content: { Simple: { Subject: { Data: notice.title }, Body: { Text: { Data: notice.lines.join('\n') } } } },
            }),
          );
        });
      }
      if (s.devopsAgent) {
        await run('devopsAgent', () =>
          sendToDevOpsAgent(s.devopsAgent!, {
            ...notice,
            kind: 'failure',
            title: 'Cloud-Ops connection test (no action needed)',
            incident: { id: `cloudops-test-${Date.now()}`, priority: 'LOW', service: 'Cloud-Ops test' },
          }),
        );
      }
      if (Object.keys(results).length === 0) throw new HttpError(400, 'No channels are configured yet.');
      return json(200, { results });
    }

    default:
      throw new HttpError(404, 'Not found.');
  }
});
