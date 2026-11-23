import React, { useEffect, useState } from 'react';
import type { DevOpsAgentAuth, NotifyOn, SettingsView, UpdateSettingsRequest } from '@cloud-ops/shared';
import { api } from '../lib/api';

const inputClass =
  'w-full px-4 py-3 rounded-xl border border-slate-200 text-sm font-medium bg-slate-50/50 focus:outline-none focus:ring-2 focus:ring-orange-500/50';
const labelClass = 'text-[10px] font-black text-slate-400 uppercase tracking-wider';

const NOTIFY_LABELS: Record<keyof NotifyOn, string> = {
  eventStarted: 'Scale event started',
  eventCompleted: 'Scale event completed (with report)',
  failures: 'Failures (events and schedules)',
  leftovers: 'Leftover and idle capacity found',
};

const Section: React.FC<{ title: string; subtitle: string; children: React.ReactNode }> = ({ title, subtitle, children }) => (
  <section className="bg-white rounded-3xl border border-slate-200 p-8 space-y-5">
    <div>
      <h3 className="text-lg font-black text-slate-900">{title}</h3>
      <p className="text-sm text-slate-500">{subtitle}</p>
    </div>
    {children}
  </section>
);

const Settings: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const [view, setView] = useState<SettingsView | null>(null);
  const [slackUrl, setSlackUrl] = useState('');
  const [emails, setEmails] = useState('');
  const [agentUrl, setAgentUrl] = useState('');
  const [agentAuth, setAgentAuth] = useState<DevOpsAgentAuth>('hmac');
  const [agentSecret, setAgentSecret] = useState('');
  const [notifyOn, setNotifyOn] = useState<NotifyOn | null>(null);
  const [leftoverHours, setLeftoverHours] = useState(6);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const apply = (s: SettingsView) => {
    setView(s);
    setEmails(s.email.recipients.join(', '));
    setNotifyOn(s.notifyOn);
    setLeftoverHours(s.leftoverHours);
    if (s.devopsAgent.auth) setAgentAuth(s.devopsAgent.auth);
  };

  useEffect(() => {
    api.getSettings().then(({ settings }) => apply(settings)).catch((err) => setMessage({ ok: false, text: err.message }));
  }, []);

  const save = async (patch: UpdateSettingsRequest) => {
    setBusy('save');
    setMessage(null);
    try {
      const { settings } = await api.updateSettings(patch);
      apply(settings);
      setSlackUrl('');
      setAgentUrl('');
      setAgentSecret('');
      setMessage({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const saveAll = () => {
    const patch: UpdateSettingsRequest = {
      emailRecipients: emails.split(',').map((e) => e.trim()).filter(Boolean),
      notifyOn: notifyOn ?? undefined,
      leftoverHours,
    };
    if (slackUrl.trim()) patch.slackWebhookUrl = slackUrl.trim();
    if (agentUrl.trim() || agentSecret.trim()) {
      patch.devopsAgent = { webhookUrl: agentUrl.trim(), auth: agentAuth, secret: agentSecret.trim() };
    }
    save(patch);
  };

  const test = async () => {
    setBusy('test');
    setMessage(null);
    try {
      const { results } = await api.testSettings();
      const failed = Object.entries(results).filter(([, r]) => r !== 'ok');
      setMessage(
        failed.length === 0
          ? { ok: true, text: `Test sent to ${Object.keys(results).join(', ')}.` }
          : { ok: false, text: failed.map(([ch, r]) => `${ch}: ${r}`).join(' · ') },
      );
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  if (!view || !notifyOn) return <p className="text-sm text-slate-400">{message?.text ?? 'Loading settings…'}</p>;

  return (
    <div className="max-w-4xl space-y-6 animate-in fade-in duration-500">
      {!canEdit && (
        <p className="p-4 rounded-2xl bg-slate-100 text-sm text-slate-600">Only owners and admins can change settings.</p>
      )}

      <Section title="Slack" subtitle="Post event updates, failures and insights to a channel using an incoming webhook.">
        <p className="text-xs font-bold text-slate-500">
          {view.slack.configured ? `Connected: ${view.slack.hint}` : 'Not connected'}
        </p>
        <div className="flex gap-2">
          <input
            value={slackUrl}
            onChange={(e) => setSlackUrl(e.target.value)}
            placeholder={view.slack.configured ? 'Paste a new URL to replace it' : 'https://hooks.slack.com/services/…'}
            className={`${inputClass} font-mono`}
            disabled={!canEdit}
          />
          {view.slack.configured && canEdit && (
            <button onClick={() => save({ slackWebhookUrl: null })} className="px-4 rounded-xl text-[11px] font-black uppercase text-slate-500 hover:bg-slate-100">
              Remove
            </button>
          )}
        </div>
      </Section>

      <Section title="Email" subtitle="Same notifications by email (sent through Amazon SES).">
        {view.email.available ? (
          <label className="space-y-2 block">
            <span className={labelClass}>Recipients (comma separated, up to 10)</span>
            <input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="oncall@company.com" className={inputClass} disabled={!canEdit} />
          </label>
        ) : (
          <p className="text-xs text-slate-500">
            Email isn't set up on this deployment yet. Verify a sender address in SES, then deploy with
            <span className="font-mono"> CLOUDOPS_SENDER_EMAIL</span> set.
          </p>
        )}
      </Section>

      <Section
        title="AWS DevOps Agent (bring your own)"
        subtitle="When an event or schedule fails, open an investigation in your own DevOps Agent Space. It runs in your AWS account and is billed to you."
      >
        <p className="text-xs font-bold text-slate-500">
          {view.devopsAgent.configured ? `Connected (${view.devopsAgent.auth?.toUpperCase()}): ${view.devopsAgent.hint}` : 'Not connected'}
        </p>
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="space-y-2 sm:col-span-3">
            <span className={labelClass}>Webhook URL (Agent Space → Capabilities → Webhook)</span>
            <input value={agentUrl} onChange={(e) => setAgentUrl(e.target.value)} placeholder="https://event-ai.us-east-1.api.aws/webhook/generic/…" className={`${inputClass} font-mono`} disabled={!canEdit} />
          </label>
          <label className="space-y-2">
            <span className={labelClass}>Authentication</span>
            <select value={agentAuth} onChange={(e) => setAgentAuth(e.target.value as DevOpsAgentAuth)} className={inputClass} disabled={!canEdit}>
              <option value="hmac">HMAC secret</option>
              <option value="bearer">API key (Bearer)</option>
            </select>
          </label>
          <label className="space-y-2 sm:col-span-2">
            <span className={labelClass}>{agentAuth === 'hmac' ? 'Webhook secret' : 'API key'}</span>
            <input type="password" value={agentSecret} onChange={(e) => setAgentSecret(e.target.value)} placeholder="Stored securely, never shown again" className={inputClass} disabled={!canEdit} />
          </label>
        </div>
        {view.devopsAgent.configured && canEdit && (
          <button onClick={() => save({ devopsAgent: null })} className="text-[11px] font-black uppercase text-slate-500 hover:text-red-600">
            Disconnect DevOps Agent
          </button>
        )}
      </Section>

      <Section title="What to notify about" subtitle="Applies to every connected channel.">
        <div className="grid sm:grid-cols-2 gap-3">
          {(Object.keys(NOTIFY_LABELS) as (keyof NotifyOn)[]).map((k) => (
            <label key={k} className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100 cursor-pointer">
              <input type="checkbox" checked={notifyOn[k]} onChange={(e) => setNotifyOn({ ...notifyOn, [k]: e.target.checked })} className="accent-orange-600" disabled={!canEdit} />
              <span className="text-sm font-bold text-slate-700">{NOTIFY_LABELS[k]}</span>
            </label>
          ))}
        </div>
        <label className="space-y-2 block max-w-xs">
          <span className={labelClass}>Flag manual scale-ups still in place after (hours)</span>
          <input type="number" min={1} max={168} value={leftoverHours} onChange={(e) => setLeftoverHours(Number(e.target.value))} className={inputClass} disabled={!canEdit} />
        </label>
      </Section>

      {message && (
        <p className={`p-4 rounded-2xl text-sm font-medium ${message.ok ? 'bg-green-50 text-green-800 border border-green-100' : 'bg-red-50 text-red-700 border border-red-100'}`}>
          {message.text}
        </p>
      )}

      {canEdit && (
        <div className="flex justify-end gap-2">
          <button onClick={test} disabled={busy !== null} className="px-5 py-3 rounded-2xl text-xs font-black uppercase bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-60">
            {busy === 'test' ? 'Sending…' : 'Send test'}
          </button>
          <button onClick={saveAll} disabled={busy !== null} className="px-6 py-3 rounded-2xl text-xs font-black uppercase text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-60">
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  );
};

export default Settings;
