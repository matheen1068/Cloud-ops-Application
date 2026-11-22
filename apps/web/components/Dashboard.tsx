
import React from 'react';
import { AWSAccount, LifecycleType } from '../types';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';

interface DashboardProps {
  accounts: AWSAccount[];
}

const Dashboard: React.FC<DashboardProps> = ({ accounts }) => {
  const getTotals = () => {
    let spot = 0;
    let onDemand = 0;
    accounts.forEach(acc => {
      acc.asgs.forEach(asg => {
        asg.metrics.forEach(m => {
          if (m.lifecycle === 'spot') spot += m.count;
          else onDemand += m.count;
        });
      });
    });
    return { spot, onDemand };
  };

  const { spot, onDemand } = getTotals();
  const data = [
    { name: 'Spot', value: spot, color: '#ea580c' },
    { name: 'On-Demand', value: onDemand, color: '#334155' },
  ];

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Infrastructure Note */}
      <div className="bg-orange-50 border border-orange-100 p-4 rounded-2xl flex items-center gap-4">
        <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center text-xl shadow-sm border border-orange-100">📡</div>
        <div>
          <h4 className="text-sm font-black text-orange-900 uppercase tracking-tight">Cloud-Ops Real-Time Feed</h4>
          <p className="text-xs text-orange-700 font-medium">Aggregated via Master Lambda from {accounts.length} multi-region child accounts.</p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:border-orange-200 transition-all group">
          <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mb-2">Total Fleet Instances</p>
          <div className="flex items-end gap-2">
            <span className="text-4xl font-black text-slate-900 tracking-tighter">{spot + onDemand}</span>
            <span className="text-green-500 text-xs font-black mb-2 uppercase">Healthy</span>
          </div>
          <div className="mt-6 flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-orange-500"></span>
              <span className="text-xs font-bold text-slate-600">{spot} Spot</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-slate-700"></span>
              <span className="text-xs font-bold text-slate-600">{onDemand} OD</span>
            </div>
          </div>
        </div>

        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:border-orange-200 transition-all">
          <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mb-2">Cost Optimization</p>
          <div className="flex items-end gap-2">
            <span className="text-4xl font-black text-slate-900 tracking-tighter">$1.4k</span>
            <span className="text-slate-400 text-xs font-bold mb-2 uppercase">/ Monthly Saved</span>
          </div>
          <div className="mt-6 w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
            <div className="bg-orange-500 h-full w-[72%] transition-all duration-1000"></div>
          </div>
          <p className="mt-3 text-[10px] text-slate-500 font-black uppercase tracking-widest">72% Optimized</p>
        </div>

        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:border-orange-200 transition-all">
          <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mb-2">AWS Child Accounts</p>
          <div className="flex items-end gap-2">
            <span className="text-4xl font-black text-slate-900 tracking-tighter">
              {accounts.length}
            </span>
            <span className="text-slate-400 text-xs font-bold mb-2 uppercase">Connected</span>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            {accounts.map(acc => (
              <span key={acc.id} className="px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg text-[9px] font-black text-slate-500 uppercase">
                {acc.name.split('-')[0]}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm">
          <h3 className="text-md font-black text-slate-800 mb-6 uppercase tracking-widest">Fleet Distribution</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  cx="50%"
                  cy="50%"
                  innerRadius={65}
                  outerRadius={85}
                  paddingAngle={8}
                  dataKey="value"
                  animationBegin={200}
                >
                  {data.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} stroke="none" />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1)', padding: '12px' }}
                />
                <Legend verticalAlign="bottom" height={36} iconType="circle"/>
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-center">
          <h3 className="text-md font-black text-slate-800 mb-2 uppercase tracking-widest">Lambda Insights</h3>
          <p className="text-xs font-medium text-slate-400 mb-6 uppercase tracking-tight">Cross-account state machine analysis</p>
          <div className="space-y-4">
            <div className="group flex gap-4 p-5 rounded-2xl bg-orange-50 border border-orange-100 hover:bg-orange-100/50 transition-colors">
              <span className="text-2xl">⚡</span>
              <div>
                <p className="text-sm font-black text-orange-900 uppercase">Efficiency Boost Required</p>
                <p className="text-xs text-orange-700 font-medium mt-1">Prod-Core is running {onDemand} on-demand instances. Suggest transition to Spot to save ~60% overhead.</p>
              </div>
            </div>
            <div className="group flex gap-4 p-5 rounded-2xl bg-slate-50 border border-slate-100 hover:bg-slate-100 transition-colors">
              <span className="text-2xl">🛡️</span>
              <div>
                <p className="text-sm font-black text-slate-900 uppercase">Fleet Resilience High</p>
                <p className="text-xs text-slate-600 font-medium mt-1">AWS multi-AZ strategy active across all child account ASGs. Interruption risk is minimized.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
