
import React, { useState, useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { generateLast24Hours, generateLast7Days } from '../mockData';

const Analytics: React.FC = () => {
  const [timeRange, setTimeRange] = useState<'24h' | '7d'>('24h');
  
  const data = useMemo(() => {
    return timeRange === '24h' ? generateLast24Hours() : generateLast7Days();
  }, [timeRange]);

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-bold text-slate-800">Fleet Trends</h3>
        <div className="flex bg-slate-200 p-1 rounded-lg">
          <button
            onClick={() => setTimeRange('24h')}
            className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all ${
              timeRange === '24h' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Last 24 Hours
          </button>
          <button
            onClick={() => setTimeRange('7d')}
            className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all ${
              timeRange === '7d' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Last 7 Days
          </button>
        </div>
      </div>

      <div className="bg-white p-8 rounded-xl border border-slate-200 shadow-sm">
        <div className="h-96">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <defs>
                <linearGradient id="colorSpot" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2}/>
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                </linearGradient>
                <linearGradient id="colorOnDemand" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2}/>
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis 
                dataKey="timestamp" 
                axisLine={false} 
                tickLine={false} 
                tick={{ fontSize: 10, fill: '#64748b' }}
                dy={10}
              />
              <YAxis 
                axisLine={false} 
                tickLine={false} 
                tick={{ fontSize: 10, fill: '#64748b' }}
              />
              <Tooltip 
                contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
              />
              <Legend verticalAlign="top" align="right" height={36}/>
              <Area 
                type="monotone" 
                dataKey="spot" 
                name="Spot Instances"
                stroke="#3b82f6" 
                fillOpacity={1} 
                fill="url(#colorSpot)" 
                strokeWidth={3}
              />
              <Area 
                type="monotone" 
                dataKey="onDemand" 
                name="On-Demand"
                stroke="#6366f1" 
                fillOpacity={1} 
                fill="url(#colorOnDemand)" 
                strokeWidth={3}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="bg-slate-900 text-white p-6 rounded-xl shadow-lg relative overflow-hidden">
          <div className="relative z-10">
            <h4 className="text-lg font-bold mb-2">Spot Interruption Risk</h4>
            <p className="text-sm text-slate-400 mb-4">Current fleet is 65% diversified across 4 availability zones. Risk level: Low.</p>
            <div className="flex items-center gap-4">
              <span className="text-2xl font-bold text-green-400">Stable</span>
              <div className="h-2 flex-1 bg-slate-800 rounded-full">
                <div className="h-full w-4/5 bg-green-400 rounded-full"></div>
              </div>
            </div>
          </div>
          <div className="absolute top-0 right-0 p-4 opacity-10 text-6xl">🛡️</div>
        </div>

        <div className="bg-blue-600 text-white p-6 rounded-xl shadow-lg relative overflow-hidden">
          <div className="relative z-10">
            <h4 className="text-lg font-bold mb-2">Projected Monthly Savings</h4>
            <p className="text-sm text-blue-100 mb-4">Based on current spot strategy vs 100% on-demand pricing.</p>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold">$12,400</span>
              <span className="text-xs font-medium text-blue-200">estimated annual $148K</span>
            </div>
          </div>
          <div className="absolute top-0 right-0 p-4 opacity-10 text-6xl">📈</div>
        </div>
      </div>
    </div>
  );
};

export default Analytics;
