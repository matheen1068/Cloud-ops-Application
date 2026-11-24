import React, { useEffect, useState } from 'react';
import type { PlanUsage } from '@cloud-ops/shared';
import { api } from '../lib/api';

const Meter: React.FC<{ label: string; used: number; max: number | null }> = ({ label, used, max }) => {
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs font-bold text-slate-600">
        <span>{label}</span>
        <span>{used} / {max ?? '∞'}</span>
      </div>
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-orange-500'}`} style={{ width: max ? `${pct}%` : '4%' }} />
      </div>
    </div>
  );
};

/** Settings: the workspace's plan and how much of it is used. */
const PlanCard: React.FC = () => {
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getPlan().then(({ usage }) => setUsage(usage)).catch((err) => setError(err.message));
  }, []);

  if (!usage) return error ? <p className="max-w-4xl mb-6 text-sm text-red-700">{error}</p> : null;
  const features = [
    ['Client groups and per-client access', usage.limits.clientGroups],
    ['SSO', usage.limits.sso],
  ] as const;

  return (
    <section className="max-w-4xl mb-6 bg-white rounded-3xl border border-slate-200 p-8 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-black text-slate-900">Plan</h3>
          <p className="text-sm text-slate-500">Need more? Plan changes are handled by the Cloud-Ops team until self-serve billing opens.</p>
        </div>
        <span className="px-4 py-2 rounded-full bg-slate-900 text-white text-xs font-black uppercase">{usage.plan}</span>
      </div>
      <div className="grid sm:grid-cols-2 gap-6">
        <Meter label="AWS accounts" used={usage.accounts} max={usage.limits.maxAwsAccounts} />
        <Meter label="Users (incl. pending invites)" used={usage.users} max={usage.limits.maxUsers} />
      </div>
      <div className="flex flex-wrap gap-2">
        {features.map(([label, on]) => (
          <span key={label} className={`px-3 py-1 rounded-full text-[11px] font-bold ${on ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-400'}`}>
            {on ? '✓' : '–'} {label}
          </span>
        ))}
      </div>
    </section>
  );
};

export default PlanCard;
