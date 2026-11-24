import React from 'react';
import { refLabel, type ReadinessResult } from '@cloud-ops/shared';

const STYLE = {
  pass: { icon: '✓', box: 'bg-green-50 border-green-100', title: 'text-green-800', detail: 'text-green-700' },
  warn: { icon: '!', box: 'bg-amber-50 border-amber-100', title: 'text-amber-900', detail: 'text-amber-800' },
  fail: { icon: '✕', box: 'bg-red-50 border-red-100', title: 'text-red-800', detail: 'text-red-700' },
} as const;

/** Shows readiness checks; passes collapse into one line so problems stand out. */
const ReadinessList: React.FC<{ results: ReadinessResult[] }> = ({ results }) => (
  <div className="space-y-4">
    {results.map((r) => {
      const problems = r.checks.filter((c) => c.status !== 'pass');
      const passed = r.checks.length - problems.length;
      return (
        <div key={`${r.asg.accountId}-${r.asg.region}-${r.asg.asgName}`} className="space-y-2">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
            {refLabel(r.asg)} · {r.asg.region}
          </p>
          {problems.map((c) => {
            const s = STYLE[c.status];
            return (
              <div key={c.id} className={`flex gap-3 p-3 rounded-xl border ${s.box}`}>
                <span className={`font-black ${s.title}`}>{s.icon}</span>
                <div>
                  <p className={`text-xs font-black ${s.title}`}>{c.title}</p>
                  <p className={`text-xs font-medium ${s.detail}`}>{c.detail}</p>
                </div>
              </div>
            );
          })}
          {passed > 0 && (
            <p className="text-xs font-bold text-green-700">✓ {passed} {passed === 1 ? 'check' : 'checks'} passed</p>
          )}
        </div>
      );
    })}
  </div>
);

export const hasProblems = (results: ReadinessResult[]) =>
  results.some((r) => r.checks.some((c) => c.status !== 'pass'));
export const hasFailures = (results: ReadinessResult[]) =>
  results.some((r) => r.checks.some((c) => c.status === 'fail'));

export default ReadinessList;
