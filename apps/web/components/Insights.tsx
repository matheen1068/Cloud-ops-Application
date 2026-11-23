import React, { useEffect, useState } from 'react';
import type { InsightsReport } from '@cloud-ops/shared';
import { api } from '../lib/api';

/** Dashboard card: capacity someone forgot to scale back, and fleets that look idle. */
const Insights: React.FC = () => {
  const [report, setReport] = useState<InsightsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getInsights()
      .then(({ report }) => setReport(report))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const { report } = await api.runInsights();
      setReport(report);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm flex flex-col">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h3 className="text-md font-black text-slate-800 uppercase tracking-widest">Capacity Insights</h3>
          <p className="text-xs font-medium text-slate-400 uppercase tracking-tight">
            {report ? `Checked ${new Date(report.generatedAt).toLocaleString()}` : 'Forgotten scale-ups and idle fleets'}
          </p>
        </div>
        <button onClick={run} disabled={running} className="shrink-0 px-4 py-2 rounded-xl text-[11px] font-black uppercase bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-60">
          {running ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {error && <p className="text-xs text-red-700 mb-3">{error}</p>}
      {loading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : !report ? (
        <p className="text-sm text-slate-500">No check has run yet. It runs every 6 hours, or press Check now.</p>
      ) : report.insights.length === 0 ? (
        <div className="flex gap-4 p-5 rounded-2xl bg-green-50 border border-green-100">
          <span className="text-2xl">✅</span>
          <div>
            <p className="text-sm font-black text-green-900 uppercase">All clear</p>
            <p className="text-xs text-green-700 font-medium mt-1">No forgotten scale-ups or idle Auto Scaling groups.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {report.insights.map((i) => (
            <div key={i.id} className={`flex gap-4 p-5 rounded-2xl border ${i.type === 'idle' ? 'bg-slate-50 border-slate-100' : 'bg-orange-50 border-orange-100'}`}>
              <span className="text-2xl">{i.type === 'idle' ? '💤' : '⏳'}</span>
              <div className="min-w-0">
                <p className={`text-sm font-black ${i.type === 'idle' ? 'text-slate-900' : 'text-orange-900'}`}>{i.title}</p>
                <p className={`text-xs font-medium mt-1 ${i.type === 'idle' ? 'text-slate-600' : 'text-orange-700'}`}>{i.detail}</p>
                {i.instanceHours !== undefined && (
                  <p className="text-[10px] font-black uppercase text-slate-400 mt-2">≈ {i.instanceHours} instance-hours</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {report && report.errors.length > 0 && (
        <p className="text-[11px] text-amber-700 mt-3">Couldn't check: {report.errors.map((e) => `${e.accountId}${e.region ? ` (${e.region})` : ''}`).join(', ')}</p>
      )}
    </div>
  );
};

export default Insights;
