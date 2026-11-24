import React, { useCallback, useEffect, useState } from 'react';
import { PLAN_IDS, type PlanId, type PlatformTenant } from '@cloud-ops/shared';
import { api } from '../lib/api';

/** Platform operator only: every workspace on this deployment, and their plans. */
const Platform: React.FC = () => {
  const [tenants, setTenants] = useState<PlatformTenant[] | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTenants((await api.listPlatformTenants()).tenants);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const change = async (t: PlatformTenant, plan: PlanId) => {
    if (!window.confirm(`Move "${t.name}" from ${t.plan} to ${plan}?`)) return;
    setBusy(t.tenantId);
    setError(null);
    try {
      await api.setTenantPlan(t.tenantId, plan);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!tenants) return <p className="text-sm text-slate-400">{error ?? 'Loading workspaces…'}</p>;
  const q = filter.trim().toLowerCase();
  const shown = q ? tenants.filter((t) => `${t.name} ${t.owners.join(' ')} ${t.tenantId}`.toLowerCase().includes(q)) : tenants;
  const byPlan = PLAN_IDS.map((p) => `${tenants.filter((t) => t.plan === p).length} ${p}`).join(' · ');

  return (
    <div className="max-w-6xl space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="text-xl font-black text-slate-900 tracking-tight">Platform</h3>
          <p className="text-sm text-slate-500">{tenants.length} workspaces · {byPlan}</p>
        </div>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search name, owner or id" className="px-4 py-2 rounded-xl border border-slate-200 text-sm w-72" />
      </div>
      {error && <p className="p-4 rounded-2xl bg-red-50 border border-red-100 text-sm text-red-700">{error}</p>}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[10px] font-black uppercase text-slate-400 border-b border-slate-100">
            <tr>
              <th className="text-left p-4">Workspace</th>
              <th className="text-left p-4">Owners</th>
              <th className="text-right p-4">Accounts</th>
              <th className="text-right p-4">Members</th>
              <th className="text-left p-4">Created</th>
              <th className="text-left p-4">Plan</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((t) => (
              <tr key={t.tenantId}>
                <td className="p-4">
                  <p className="font-bold text-slate-800">{t.name}</p>
                  <p className="font-mono text-[11px] text-slate-400">{t.tenantId}</p>
                </td>
                <td className="p-4 text-slate-600">{t.owners.join(', ') || '–'}</td>
                <td className="p-4 text-right font-bold">{t.accounts}</td>
                <td className="p-4 text-right font-bold">{t.members}</td>
                <td className="p-4 text-slate-500">{t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '–'}</td>
                <td className="p-4">
                  <select
                    value={t.plan}
                    disabled={busy === t.tenantId}
                    onChange={(e) => change(t, e.target.value as PlanId)}
                    className="px-3 py-2 rounded-lg border border-slate-200 text-xs font-black uppercase bg-white"
                  >
                    {PLAN_IDS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Platform;
