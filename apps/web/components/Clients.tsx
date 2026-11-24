import React, { useState } from 'react';
import type { ClientView } from '@cloud-ops/shared';
import { api } from '../lib/api';
import type { AWSAccount } from '../types';

/** MSP plan: group accounts by end customer, so you can filter and limit who sees what. */
const Clients: React.FC<{ clients: ClientView[]; accounts: AWSAccount[]; canEdit: boolean; onChanged: () => Promise<void> }> = ({
  clients,
  accounts,
  canEdit,
  onChanged,
}) => {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unassigned = accounts.filter((a) => !a.clientId);

  return (
    <div className="max-w-5xl space-y-6 animate-in fade-in duration-500">
      <div>
        <h3 className="text-xl font-black text-slate-900 tracking-tight">Clients</h3>
        <p className="text-sm text-slate-500">
          Group accounts by customer. In Team, you can limit an operator or viewer to some clients.
        </p>
      </div>
      {error && <p className="p-4 rounded-2xl bg-red-50 border border-red-100 text-sm text-red-700">{error}</p>}

      {canEdit && (
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Client name, e.g. Acme Retail"
            className="flex-1 px-4 py-3 rounded-xl border border-slate-200 text-sm font-medium bg-slate-50/50"
          />
          <button
            onClick={() => run(async () => { await api.createClient(name.trim()); setName(''); })}
            disabled={busy || !name.trim()}
            className="px-6 py-3 rounded-xl text-xs font-black uppercase text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-60"
          >
            Add client
          </button>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {clients.map((c) => (
          <section key={c.clientId} className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
            <div className="flex items-center gap-2">
              {editing?.id === c.clientId ? (
                <>
                  <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className="flex-1 px-3 py-1 rounded-lg border border-slate-200 text-sm font-bold" />
                  <button onClick={() => run(async () => { await api.renameClient(c.clientId, editing.name.trim()); setEditing(null); })} className="text-[11px] font-black uppercase text-orange-600">Save</button>
                </>
              ) : (
                <>
                  <h4 className="flex-1 font-black text-slate-900">{c.name}</h4>
                  <span className="text-xs font-bold text-slate-400">{c.accountCount} account{c.accountCount === 1 ? '' : 's'}</span>
                  {canEdit && (
                    <>
                      <button onClick={() => setEditing({ id: c.clientId, name: c.name })} className="text-[11px] font-black uppercase text-slate-400 hover:text-slate-700">Rename</button>
                      <button
                        onClick={() => window.confirm(`Delete ${c.name}? Its accounts stay connected but become unassigned, and people limited to it lose access.`) && run(() => api.deleteClient(c.clientId))}
                        className="text-[11px] font-black uppercase text-slate-400 hover:text-red-600"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
            <ul className="space-y-1">
              {accounts.filter((a) => a.clientId === c.clientId).map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 text-slate-700">{a.name} <span className="font-mono text-xs text-slate-400">{a.id}</span></span>
                  {canEdit && (
                    <button onClick={() => run(() => api.updateAccount(a.id, { clientId: null }))} className="text-[11px] font-black uppercase text-slate-400 hover:text-red-600">Remove</button>
                  )}
                </li>
              ))}
            </ul>
            {canEdit && unassigned.length > 0 && (
              <select
                value=""
                disabled={busy}
                onChange={(e) => e.target.value && run(() => api.updateAccount(e.target.value, { clientId: c.clientId }))}
                className="w-full px-3 py-2 rounded-lg border border-dashed border-slate-300 text-xs text-slate-500 bg-white"
              >
                <option value="">+ Add an unassigned account</option>
                {unassigned.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
              </select>
            )}
          </section>
        ))}
      </div>
      {clients.length === 0 && <p className="text-sm text-slate-400">No clients yet.</p>}
    </div>
  );
};

export default Clients;
