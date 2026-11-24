import React, { useMemo, useState } from 'react';
import type { AccessLevel, BulkConnectResponse, ClientView, DiscoveryResult } from '@cloud-ops/shared';
import { api } from '../lib/api';
import { getConfig } from '../lib/config';
import type { AWSAccount } from '../types';

const STATUS: Record<string, { label: string; style: string }> = {
  connected: { label: 'Connected', style: 'bg-green-50 text-green-700' },
  ready: { label: 'Role found', style: 'bg-blue-50 text-blue-700' },
  'no-role': { label: 'No role yet', style: 'bg-amber-50 text-amber-700' },
  suspended: { label: 'Suspended', style: 'bg-slate-100 text-slate-500' },
};

interface Row {
  selected: boolean;
  alias: string;
  clientId: string;
}

/**
 * Connect many accounts at once: scan the organization from its management account,
 * then connect every member account where the StackSet already created the role.
 */
const OrgDiscovery: React.FC<{ accounts: AWSAccount[]; clients: ClientView[]; clientGroups: boolean; onConnected: () => Promise<void> }> = ({
  accounts,
  clients,
  clientGroups,
  onConnected,
}) => {
  const candidates = accounts.filter((a) => a.connectionMethod !== 'organization');
  const [management, setManagement] = useState(candidates[0]?.id ?? '');
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [accessLevel, setAccessLevel] = useState<AccessLevel>('Operate');
  const [regions, setRegions] = useState(getConfig().region);
  const [busy, setBusy] = useState<'scan' | 'connect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BulkConnectResponse | null>(null);

  const scan = async () => {
    setBusy('scan');
    setError(null);
    setOutcome(null);
    try {
      const found = await api.discoverOrg(management);
      setResult(found);
      // Pre-select everything that can be connected; suggest a client from the OU name.
      const byName = new Map(clients.map((c) => [c.name.toLowerCase(), c.clientId]));
      setRows(
        Object.fromEntries(
          found.accounts
            .filter((a) => a.status === 'ready')
            .map((a) => {
              const ou = a.ouPath.split(' / ').pop()?.toLowerCase() ?? '';
              return [a.accountId, { selected: true, alias: a.name, clientId: byName.get(ou) ?? '' }];
            }),
        ),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const picked = useMemo(() => (Object.entries(rows) as [string, Row][]).filter(([, r]) => r.selected), [rows]);

  const connect = async () => {
    setBusy('connect');
    setError(null);
    try {
      const res = await api.bulkConnect({
        accessLevel,
        regions: regions.split(',').map((r) => r.trim()).filter(Boolean),
        accounts: picked.map(([accountId, r]) => ({ accountId, alias: r.alias.trim() || accountId, clientId: r.clientId || undefined })),
      });
      setOutcome(res);
      await onConnected();
      await scan();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const update = (id: string, patch: Partial<Row>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));
  const noRole = result?.accounts.filter((a) => a.status === 'no-role').length ?? 0;

  return (
    <section className="max-w-5xl bg-white rounded-3xl border border-slate-200 p-8 space-y-5 mt-8">
      <div>
        <h3 className="text-lg font-black text-slate-900">Connect a whole AWS Organization</h3>
        <p className="text-sm text-slate-500">
          Deploy the role to every member account with the StackSet in <span className="font-mono">onboarding/terraform/examples/organization</span>, connect the
          management account above with <span className="font-mono">IsOrgManagementAccount=true</span>, then scan.
        </p>
      </div>

      {candidates.length === 0 ? (
        <p className="text-sm text-slate-400">Connect the management account first.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <select value={management} onChange={(e) => setManagement(e.target.value)} className="px-4 py-3 rounded-xl border border-slate-200 text-sm font-bold bg-slate-50">
            {candidates.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.id})</option>
            ))}
          </select>
          <button onClick={scan} disabled={busy !== null} className="px-6 py-3 rounded-xl text-xs font-black uppercase text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-60">
            {busy === 'scan' ? 'Scanning…' : 'Scan organization'}
          </button>
        </div>
      )}

      {error && <p className="p-4 rounded-2xl bg-red-50 border border-red-100 text-sm text-red-700">{error}</p>}
      {outcome && (
        <p className={`p-4 rounded-2xl text-sm border ${outcome.failed.length ? 'bg-amber-50 border-amber-100 text-amber-900' : 'bg-green-50 border-green-100 text-green-800'}`}>
          Connected {outcome.connected.length}.
          {outcome.failed.map((f) => ` ${f.accountId}: ${f.message}`).join(' ·')}
        </p>
      )}

      {result && (
        <>
          <p className="text-xs font-bold text-slate-500">
            {result.organizationId} · {result.accounts.length} accounts
            {noRole > 0 && ` · ${noRole} without the role yet (deploy the StackSet to their OU, then scan again)`}
            {result.truncated && ' · large organization: only the first 300 accounts were checked'}
          </p>
          <div className="border border-slate-100 rounded-2xl divide-y divide-slate-100 max-h-[480px] overflow-y-auto">
            {result.accounts.map((a) => {
              const row = rows[a.accountId];
              return (
                <div key={a.accountId} className="p-3 flex flex-wrap items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="accent-orange-600"
                    disabled={!row}
                    checked={!!row?.selected}
                    onChange={(e) => update(a.accountId, { selected: e.target.checked })}
                  />
                  <div className="w-56 min-w-0">
                    {row ? (
                      <input value={row.alias} onChange={(e) => update(a.accountId, { alias: e.target.value })} className="w-full px-2 py-1 rounded border border-slate-200 text-sm font-bold" />
                    ) : (
                      <p className="font-bold text-slate-700 truncate">{a.name}</p>
                    )}
                    <p className="text-[11px] text-slate-400 font-mono">{a.accountId}</p>
                  </div>
                  <span className="text-xs text-slate-500 flex-1 min-w-[140px]">{a.ouPath}</span>
                  {row && clientGroups && (
                    <select value={row.clientId} onChange={(e) => update(a.accountId, { clientId: e.target.value })} className="px-2 py-1 rounded border border-slate-200 text-xs">
                      <option value="">No client</option>
                      {clients.map((c) => <option key={c.clientId} value={c.clientId}>{c.name}</option>)}
                    </select>
                  )}
                  <span className={`px-2 py-1 rounded text-[10px] font-black uppercase ${STATUS[a.status].style}`} title={a.message}>{STATUS[a.status].label}</span>
                </div>
              );
            })}
          </div>

          {Object.keys(rows).length > 0 && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1">
                <span className="text-[10px] font-black text-slate-400 uppercase">Role access level (as deployed)</span>
                <select value={accessLevel} onChange={(e) => setAccessLevel(e.target.value as AccessLevel)} className="block px-3 py-2 rounded-lg border border-slate-200 text-sm">
                  <option value="Operate">Operate</option>
                  <option value="ReadOnly">ReadOnly</option>
                </select>
              </label>
              <label className="space-y-1 flex-1 min-w-[200px]">
                <span className="text-[10px] font-black text-slate-400 uppercase">Regions to scan (comma separated)</span>
                <input value={regions} onChange={(e) => setRegions(e.target.value)} className="block w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-mono" />
              </label>
              <button
                onClick={connect}
                disabled={busy !== null || picked.length === 0 || picked.length > 50}
                className="px-6 py-3 rounded-xl text-xs font-black uppercase text-white bg-orange-600 hover:bg-orange-700 disabled:opacity-60"
              >
                {busy === 'connect' ? 'Connecting…' : `Connect ${picked.length} account${picked.length === 1 ? '' : 's'}`}
              </button>
            </div>
          )}
          {picked.length > 50 && <p className="text-xs text-amber-700">Connect up to 50 at a time.</p>}
        </>
      )}
    </section>
  );
};

export default OrgDiscovery;
