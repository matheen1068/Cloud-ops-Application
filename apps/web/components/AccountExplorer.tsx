import React, { useState } from 'react';
import { validateCapacity, type CapacitySettings, type ReadinessResult } from '@cloud-ops/shared';
import { api } from '../lib/api';
import { ASG, AWSAccount } from '../types';
import ReadinessList, { hasFailures, hasProblems } from './ReadinessList';

interface AccountExplorerProps {
  accounts: AWSAccount[];
  canOperate: boolean;
  onScale: (asg: ASG, capacity: CapacitySettings, reason: string) => Promise<void>;
  onConnect: () => void;
  canAdmin?: boolean;
  onToggleApproval?: (accountId: string, requireApproval: boolean) => Promise<void>;
}

const AccountExplorer: React.FC<AccountExplorerProps> = ({ accounts, canOperate, onScale, onConnect, canAdmin, onToggleApproval }) => {
  const [toggling, setToggling] = useState<string | null>(null);
  const [expandedAccount, setExpandedAccount] = useState<string | null>(accounts[0]?.id || null);

  if (accounts.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center space-y-4">
        <p className="text-4xl">🏢</p>
        <h3 className="text-xl font-black text-slate-900">No accounts connected yet</h3>
        <p className="text-sm text-slate-500">Connect an AWS account to see and scale its Auto Scaling groups.</p>
        <button onClick={onConnect} className="px-6 py-3 bg-orange-600 text-white rounded-2xl text-xs font-black uppercase hover:bg-orange-700">
          Connect account
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      {accounts.map((account) => (
        <div
          key={account.id}
          className={`bg-white rounded-xl border transition-all ${
            expandedAccount === account.id ? 'border-blue-200 shadow-md' : 'border-slate-200 shadow-sm hover:border-slate-300'
          }`}
        >
          <button
            onClick={() => setExpandedAccount(expandedAccount === account.id ? null : account.id)}
            className="w-full px-6 py-4 flex items-center justify-between text-left"
          >
            <div className="flex items-center gap-4">
              <div className="p-2 bg-slate-100 rounded-lg text-slate-500">🏢</div>
              <div>
                <h3 className="font-bold text-slate-900">{account.name}</h3>
                <p className="text-xs text-slate-500">
                  AWS ID: {account.id} · {account.regions.join(', ')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-6">
              {account.requireApproval && (
                <span className="px-2 py-1 rounded text-[10px] font-black uppercase bg-amber-50 text-amber-700">🔒 Needs approval</span>
              )}
              <span
                className={`px-2 py-1 rounded text-[10px] font-black uppercase ${
                  account.accessLevel === 'Operate' ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'
                }`}
              >
                {account.accessLevel === 'Operate' ? 'Can scale' : 'Read-only'}
              </span>
              <div className="hidden sm:flex flex-col items-end">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">ASGs</span>
                <span className="text-lg font-bold text-slate-800">{account.asgs.length}</span>
              </div>
              <span className={`text-xl transition-transform ${expandedAccount === account.id ? 'rotate-180' : ''}`}>⌄</span>
            </div>
          </button>

          {expandedAccount === account.id && (
            <div className="px-6 pb-6 pt-2 border-t border-slate-50 grid grid-cols-1 gap-4">
              {canAdmin && onToggleApproval && (
                <label className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-xl border border-slate-100 bg-slate-50 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="accent-orange-600"
                    checked={!!account.requireApproval}
                    disabled={toggling === account.id}
                    onChange={async (e) => {
                      setToggling(account.id);
                      try {
                        await onToggleApproval(account.id, e.target.checked);
                      } finally {
                        setToggling(null);
                      }
                    }}
                  />
                  <span className="font-bold text-slate-700">Require approval for changes in this account</span>
                  <span className="text-xs text-slate-400">Scale Now, new events and schedules need a second owner or admin</span>
                </label>
              )}
              {account.asgs.length === 0 && (
                <p className="text-sm text-slate-500 py-4">No Auto Scaling groups found in {account.regions.join(', ')}.</p>
              )}
              {account.asgs.map((asg) => (
                <AsgCard
                  key={asg.id}
                  asg={asg}
                  canScale={canOperate && account.accessLevel === 'Operate'}
                  onScale={onScale}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

const numberInput =
  'w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-orange-500/50';

const AsgCard: React.FC<{
  asg: ASG;
  canScale: boolean;
  onScale: AccountExplorerProps['onScale'];
}> = ({ asg, canScale, onScale }) => {
  const [editing, setEditing] = useState(false);
  const [capacity, setCapacity] = useState<CapacitySettings>(asg.capacity);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Readiness results for the capacity currently in the form; null = not checked yet.
  const [checks, setChecks] = useState<ReadinessResult[] | null>(null);

  const open = () => {
    setCapacity(asg.capacity);
    setReason('');
    setError(null);
    setChecks(null);
    setEditing(true);
  };

  const scale = async () => {
    await onScale(asg, capacity, reason);
    setEditing(false);
    setChecks(null);
  };

  // First click runs the readiness check. All clear: apply straight away.
  // Problems: show them and let the user choose "Apply anyway".
  const apply = async () => {
    const invalid = validateCapacity(capacity);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (checks) {
        await scale();
        return;
      }
      const { results } = await api.readiness({
        targets: [{ asg: { accountId: asg.accountId, region: asg.region, asgName: asg.name }, capacity }],
      });
      if (hasProblems(results)) setChecks(results);
      else await scale();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof CapacitySettings, label: string) => (
    <label className="space-y-1">
      <span className="text-[10px] font-black text-slate-400 uppercase">{label}</span>
      <input
        type="number"
        min={0}
        value={capacity[key]}
        onChange={(e) => {
          setCapacity({ ...capacity, [key]: Number(e.target.value) });
          setChecks(null); // capacity changed: check again
        }}
        className={numberInput}
      />
    </label>
  );

  return (
    <div className="p-4 bg-slate-50 rounded-lg border border-slate-100">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h4 className="font-semibold text-slate-800 flex items-center gap-2">
            {asg.name}
            {asg.managed && (
              <span className="px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 text-[9px] font-black uppercase">Managed</span>
            )}
          </h4>
          <p className="text-[10px] font-bold text-slate-400 uppercase">{asg.region}</p>
        </div>
        {canScale && !editing && (
          <button onClick={open} className="px-4 py-2 bg-slate-900 text-white rounded-xl text-[11px] font-black uppercase hover:bg-slate-800">
            Scale
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {(
          [
            ['Min', asg.capacity.min],
            ['Desired', asg.capacity.desired],
            ['Max', asg.capacity.max],
            ['In service', asg.inService],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="bg-white p-3 rounded border border-slate-200 shadow-sm">
            <p className="text-xs font-medium text-slate-500">{label}</p>
            <p className="text-lg font-bold text-slate-900">{value}</p>
          </div>
        ))}
      </div>

      {asg.metrics.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {asg.metrics.map((m) => (
            <span
              key={m.lifecycle}
              className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-tight ${
                m.lifecycle === 'spot' ? 'bg-blue-100 text-blue-700' : 'bg-indigo-100 text-indigo-700'
              }`}
            >
              {m.count} {m.lifecycle} · <span className="font-mono normal-case">{m.type}</span>
            </span>
          ))}
        </div>
      )}

      {editing && (
        <div className="mt-4 p-4 bg-white rounded-xl border border-orange-200 space-y-4">
          <div className="grid grid-cols-3 gap-3">
            {field('min', 'Min')}
            {field('desired', 'Desired')}
            {field('max', 'Max')}
          </div>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional), e.g. IPL final"
            className={numberInput}
          />
          {checks && <ReadinessList results={checks} />}
          {error && <p className="text-xs font-medium text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(false)} className="px-4 py-2 rounded-xl text-[11px] font-black uppercase text-slate-500 hover:bg-slate-100">
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={saving}
              className={`px-4 py-2 text-white rounded-xl text-[11px] font-black uppercase disabled:opacity-60 ${
                checks && hasFailures(checks) ? 'bg-red-600 hover:bg-red-700' : 'bg-orange-600 hover:bg-orange-700'
              }`}
            >
              {saving ? (checks ? 'Applying…' : 'Checking…') : checks ? 'Apply anyway' : 'Check & apply'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AccountExplorer;
