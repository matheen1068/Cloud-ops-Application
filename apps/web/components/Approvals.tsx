import React, { useCallback, useEffect, useState } from 'react';
import type { ApprovalRequest, MeResponse } from '@cloud-ops/shared';
import { api } from '../lib/api';

const STATUS_STYLE: Record<ApprovalRequest['status'], string> = {
  pending: 'bg-amber-50 text-amber-700',
  approved: 'bg-green-50 text-green-700',
  rejected: 'bg-red-50 text-red-700',
  failed: 'bg-red-50 text-red-700',
  cancelled: 'bg-slate-100 text-slate-500',
  expired: 'bg-slate-100 text-slate-500',
};
const KIND_LABEL: Record<ApprovalRequest['kind'], string> = {
  capacity: 'Scale now',
  'scale-event': 'Scale event',
  schedule: 'Schedule',
};

const Card: React.FC<{ a: ApprovalRequest; me: MeResponse; onDone: () => Promise<void> }> = ({ a, me, onDone }) => {
  const [note, setNote] = useState('');
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mine = a.requestedBy.userId === me.user.userId;
  const isAdmin = me.user.role === 'owner' || me.user.role === 'admin';
  const pending = a.status === 'pending';

  const act = async (action: 'approve' | 'reject' | 'cancel', extra: { breakGlassReason?: string } = {}) => {
    setBusy(true);
    setError(null);
    try {
      await api.decideApproval(a.requestId, action, { note: note.trim() || undefined, ...extra });
      await onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className={`bg-white rounded-2xl border p-5 space-y-3 ${pending ? 'border-amber-200' : 'border-slate-200'}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className={`px-2 py-1 rounded text-[10px] font-black uppercase ${STATUS_STYLE[a.status]}`}>{a.status}</span>
        <span className="text-[10px] font-black uppercase text-slate-400">{KIND_LABEL[a.kind]}</span>
        {a.breakGlass && <span className="px-2 py-1 rounded text-[10px] font-black uppercase bg-red-600 text-white">Emergency override</span>}
        <span className="ml-auto text-xs text-slate-400">
          {mine ? 'You' : a.requestedBy.email} · {new Date(a.requestedAt).toLocaleString()}
        </span>
      </div>
      <p className="font-black text-slate-900">{a.summary}</p>
      <ul className="text-xs text-slate-600 space-y-1 font-mono">
        {a.details.map((d) => <li key={d}>{d}</li>)}
      </ul>
      {pending && <p className="text-xs text-slate-400">Expires {new Date(a.expiresAt).toLocaleString()}</p>}
      {a.decidedBy && !pending && (
        <p className="text-xs text-slate-500">
          {a.status === 'cancelled' ? 'Cancelled' : 'Decided'} by {a.decidedBy.email}
          {a.decidedAt && ` · ${new Date(a.decidedAt).toLocaleString()}`}
          {a.note && ` · "${a.note}"`}
        </p>
      )}
      {a.result && <p className={`text-xs font-bold ${a.status === 'failed' ? 'text-red-700' : 'text-green-700'}`}>{a.result}</p>}
      {error && <p className="text-xs text-red-700">{error}</p>}

      {pending && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {(isAdmin && !mine) || override ? (
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={override ? 'Why can’t this wait for a second person? (required)' : 'Note (optional)'}
              className="flex-1 min-w-[200px] px-3 py-2 rounded-lg border border-slate-200 text-sm"
            />
          ) : null}
          {isAdmin && !mine && (
            <>
              <button onClick={() => act('approve')} disabled={busy} className="px-4 py-2 rounded-lg text-[11px] font-black uppercase bg-green-600 text-white hover:bg-green-700 disabled:opacity-60">
                Approve & apply
              </button>
              <button onClick={() => act('reject')} disabled={busy} className="px-4 py-2 rounded-lg text-[11px] font-black uppercase bg-slate-100 text-slate-700 hover:bg-red-50 hover:text-red-700 disabled:opacity-60">
                Reject
              </button>
            </>
          )}
          {mine && override && (
            <button
              onClick={() => act('approve', { breakGlassReason: note.trim() })}
              disabled={busy || note.trim().length < 10}
              className="px-4 py-2 rounded-lg text-[11px] font-black uppercase bg-red-600 text-white hover:bg-red-700 disabled:opacity-60"
            >
              Override & apply
            </button>
          )}
          {mine && me.user.role === 'owner' && !override && (
            <button onClick={() => setOverride(true)} className="px-4 py-2 rounded-lg text-[11px] font-black uppercase text-red-600 hover:bg-red-50">
              Emergency override
            </button>
          )}
          {(mine || isAdmin) && (
            <button onClick={() => act('cancel')} disabled={busy} className="px-4 py-2 rounded-lg text-[11px] font-black uppercase text-slate-500 hover:bg-slate-100 disabled:opacity-60">
              Cancel request
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/** Changes waiting for a second person, and what was decided. */
const Approvals: React.FC<{ me: MeResponse; onChanged: () => Promise<void> }> = ({ me, onChanged }) => {
  const [list, setList] = useState<ApprovalRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList((await api.listApprovals()).approvals);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const done = async () => {
    await load();
    await onChanged();
  };

  if (!list) return <p className="text-sm text-slate-400">{error ?? 'Loading approvals…'}</p>;
  const pending = list.filter((a) => a.status === 'pending');
  const history = list.filter((a) => a.status !== 'pending');

  return (
    <div className="max-w-4xl space-y-8 animate-in fade-in duration-500">
      <div>
        <h3 className="text-xl font-black text-slate-900 tracking-tight">Approvals</h3>
        <p className="text-sm text-slate-500">
          Accounts marked "Require approval" in Account Explorer need a second owner or admin before a change goes out.
        </p>
      </div>
      {error && <p className="p-4 rounded-2xl bg-red-50 border border-red-100 text-sm text-red-700">{error}</p>}

      <section className="space-y-3">
        <h4 className="text-xs font-black uppercase text-slate-400">Waiting ({pending.length})</h4>
        {pending.length === 0 && <p className="text-sm text-slate-400">Nothing waiting for approval.</p>}
        {pending.map((a) => <Card key={a.requestId} a={a} me={me} onDone={done} />)}
      </section>

      {history.length > 0 && (
        <section className="space-y-3">
          <h4 className="text-xs font-black uppercase text-slate-400">History</h4>
          {history.map((a) => <Card key={a.requestId} a={a} me={me} onDone={done} />)}
        </section>
      )}
    </div>
  );
};

export default Approvals;
