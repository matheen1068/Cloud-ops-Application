import React, { useCallback, useEffect, useState } from 'react';
import type { AuditEntry } from '@cloud-ops/shared';
import { api } from '../lib/api';

const LABELS: Record<string, string> = {
  'account.connected': 'Account connected',
  'account.disconnected': 'Account disconnected',
  'asg.capacity-changed': 'Capacity changed',
  'scale-event.created': 'Event created',
  'scale-event.started': 'Event started',
  'scale-event.completed': 'Event completed',
  'scale-event.failed': 'Event failed',
  'scale-event.cancelled': 'Event cancelled / ended early',
  'schedule.created': 'Schedule created',
  'schedule.deleted': 'Schedule deleted',
  'schedule.switched-off': 'Schedule switched off',
  'schedule.switched-on': 'Schedule switched on',
  'settings.updated': 'Settings updated',
  'devops-agent.investigation-sent': 'Sent to DevOps Agent',
};

const cap = (c?: { min: number; desired: number; max: number }) => (c ? `${c.min}/${c.desired}/${c.max}` : '');

/** Everything that changed, who did it, and the result. Newest first. */
const Activity: React.FC = () => {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (after?: string) => {
    setLoading(true);
    try {
      const page = await api.listAudit(after);
      setEntries((e) => (after ? [...e, ...page.entries] : page.entries));
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h3 className="text-xl font-black text-slate-900 tracking-tight">Activity</h3>
        <p className="text-sm text-slate-500">Every change Cloud-Ops made or was asked to make, newest first.</p>
      </div>
      {error && <p className="p-4 rounded-2xl bg-red-50 border border-red-100 text-sm text-red-700">{error}</p>}

      <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100">
        {entries.length === 0 && !loading && <p className="p-8 text-center text-sm text-slate-400">Nothing yet.</p>}
        {entries.map((e) => (
          <div key={e.auditId} className="p-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-mono text-xs text-slate-400 w-40 shrink-0">{new Date(e.at).toLocaleString()}</span>
            <span className={`w-2 h-2 rounded-full ${e.result === 'success' ? 'bg-green-500' : 'bg-red-500'}`}></span>
            <span className="font-black text-slate-800">{LABELS[e.action] ?? e.action}</span>
            {e.asg && <span className="text-slate-600">{e.asg.asgName} <span className="text-[10px] font-bold text-slate-400 uppercase">{e.asg.region}</span></span>}
            {e.before && e.after && <span className="font-mono text-xs text-slate-500">{cap(e.before)} → {cap(e.after)}</span>}
            {e.message && <span className="text-slate-500 truncate max-w-md">{e.message}</span>}
            <span className="ml-auto text-xs text-slate-400">{e.actor === 'system' ? 'Cloud-Ops' : e.actor.email}</span>
          </div>
        ))}
      </div>

      {cursor && (
        <div className="text-center">
          <button onClick={() => load(cursor)} disabled={loading} className="px-5 py-3 rounded-2xl text-xs font-black uppercase bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-60">
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
};

export default Activity;
