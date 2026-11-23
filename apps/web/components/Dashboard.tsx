
import React from 'react';
import { AWSAccount } from '../types';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';

interface DashboardProps {
  accounts: AWSAccount[];
  onConnect: () => void;
}

const Dashboard: React.FC<DashboardProps> = ({ accounts, onConnect }) => {
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
  const asgs = accounts.flatMap((a) => a.asgs);
  const desired = asgs.reduce((sum, g) => sum + g.capacity.desired, 0);
  const inService = asgs.reduce((sum, g) => sum + g.inService, 0);
  const regions = new Set(asgs.map((g) => g.region)).size;
  const data = [
    { name: 'Spot', value: spot, color: '#ea580c' },
    { name: 'On-Demand', value: onDemand, color: '#334155' },
  ];

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {accounts.length === 0 && (
        <div className="bg-slate-900 text-white p-8 rounded-3xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
          <div>
            <h3 className="text-2xl font-black tracking-tight">Connect your first AWS account</h3>
            <p className="text-sm text-slate-400 mt-1">Deploy one IAM role, paste its ARN, and every Auto Scaling group shows up here.</p>
          </div>
          <button onClick={onConnect} className="px-6 py-3 bg-orange-600 rounded-2xl text-xs font-black uppercase hover:bg-orange-700 transition-all">
            Connect account
          </button>
        </div>
      )}

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
            <span className="text-green-500 text-xs font-black mb-2 uppercase">{inService} in service</span>
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
          <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mb-2">Desired Capacity</p>
          <div className="flex items-end gap-2">
            <span className="text-4xl font-black text-slate-900 tracking-tighter">{desired}</span>
            <span className="text-slate-400 text-xs font-bold mb-2 uppercase">instances</span>
          </div>
          <p className="mt-6 text-[10px] text-slate-500 font-black uppercase tracking-widest">
            {asgs.length} ASGs · {regions} {regions === 1 ? 'region' : 'regions'}
          </p>
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
                {acc.name}
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
                <p className="text-sm font-black text-orange-900 uppercase">{onDemand > 0 ? 'Spot opportunity' : 'No on-demand capacity running'}</p>
                <p className="text-xs text-orange-700 font-medium mt-1">
                  {onDemand > 0
                    ? `${onDemand} on-demand ${onDemand === 1 ? 'instance is' : 'instances are'} running. Fault-tolerant workloads could move to Spot.`
                    : 'Nothing to optimise right now.'}
                </p>
              </div>
            </div>
            <div className="group flex gap-4 p-5 rounded-2xl bg-slate-50 border border-slate-100 hover:bg-slate-100 transition-colors">
              <span className="text-2xl">🛡️</span>
              <div>
                <p className="text-sm font-black text-slate-900 uppercase">Coverage</p>
                <p className="text-xs text-slate-600 font-medium mt-1">
                  Watching {asgs.length} Auto Scaling groups in {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'} across {regions} {regions === 1 ? 'region' : 'regions'}.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
