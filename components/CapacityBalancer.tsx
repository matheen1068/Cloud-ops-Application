
import React, { useState, useEffect } from 'react';
import { AWSAccount, ASG } from '../types';

interface CapacityBalancerProps {
  accounts: AWSAccount[];
}

const CapacityBalancer: React.FC<CapacityBalancerProps> = ({ accounts }) => {
  const allAsgs = accounts.flatMap(acc => acc.asgs.map(asg => ({ ...asg, accountName: acc.name })));
  
  const [selectedAsgId, setSelectedAsgId] = useState<string>(allAsgs[0]?.id || '');
  const [desiredCapacity, setDesiredCapacity] = useState<number>(20);
  const [onDemandBase, setOnDemandBase] = useState<number>(2);
  const [onDemandPercentageAboveBase, setOnDemandPercentageAboveBase] = useState<number>(20);
  const [minCpu, setMinCpu] = useState<number>(2);
  const [minRam, setMinRam] = useState<number>(8);

  const selectedAsg = allAsgs.find(a => a.id === selectedAsgId);

  const instanceCatalog = [
    { type: 't3.medium', cpu: 2, ram: 4, price: 0.0416 },
    { type: 't3.large', cpu: 2, ram: 8, price: 0.0832 },
    { type: 'm5.large', cpu: 2, ram: 8, price: 0.096 },
    { type: 'm5.xlarge', cpu: 4, ram: 16, price: 0.192 },
    { type: 'c5.large', cpu: 2, ram: 4, price: 0.085 },
    { type: 'c5.xlarge', cpu: 4, ram: 8, price: 0.17 },
    { type: 'r5.large', cpu: 2, ram: 16, price: 0.126 },
    { type: 'r5.xlarge', cpu: 4, ram: 32, price: 0.252 },
  ];

  const matchingInstances = instanceCatalog.filter(inst => inst.cpu >= minCpu && inst.ram >= minRam);

  const calculateDistribution = () => {
    const odBase = Math.min(onDemandBase, desiredCapacity);
    const remaining = desiredCapacity - odBase;
    const odAboveBase = Math.round((remaining * onDemandPercentageAboveBase) / 100);
    const spot = remaining - odAboveBase;
    const totalOD = odBase + odAboveBase;

    return { totalOD, spot };
  };

  const { totalOD, spot } = calculateDistribution();

  return (
    <div className="space-y-8 animate-in slide-in-from-right-4 duration-500">
      <div className="bg-slate-900 rounded-3xl p-8 text-white shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 right-0 p-8 opacity-10 text-8xl">⚖️</div>
        <div className="relative z-10">
          <h2 className="text-3xl font-black tracking-tighter mb-2">Fleet Capacity Balancer</h2>
          <p className="text-slate-400 font-medium max-w-md">
            Simulate AWS Auto Scaling Group mixed instances policy to optimize for cost and availability.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Configuration Panel */}
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-6">Target Configuration</h3>
            
            <div className="space-y-6">
              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2">Select ASG</label>
                <select 
                  value={selectedAsgId}
                  onChange={(e) => setSelectedAsgId(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold text-slate-800 focus:ring-2 focus:ring-orange-500 outline-none transition-all"
                >
                  {allAsgs.map(asg => (
                    <option key={asg.id} value={asg.id}>
                      {asg.name} ({asg.accountName})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider">Desired Capacity</label>
                  <span className="text-xs font-black text-slate-900">{desiredCapacity}</span>
                </div>
                <input 
                  type="range" 
                  min="1" 
                  max="100" 
                  value={desiredCapacity}
                  onChange={(e) => setDesiredCapacity(parseInt(e.target.value))}
                  className="w-full h-2 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-orange-600"
                />
              </div>

              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider">On-Demand Base</label>
                  <span className="text-xs font-black text-slate-900">{onDemandBase}</span>
                </div>
                <input 
                  type="range" 
                  min="0" 
                  max={desiredCapacity} 
                  value={onDemandBase}
                  onChange={(e) => setOnDemandBase(parseInt(e.target.value))}
                  className="w-full h-2 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-slate-800"
                />
                <p className="mt-2 text-[9px] text-slate-400 font-medium italic">Minimum number of On-Demand instances to maintain.</p>
              </div>

              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider">OD % Above Base</label>
                  <span className="text-xs font-black text-slate-900">{onDemandPercentageAboveBase}%</span>
                </div>
                <input 
                  type="range" 
                  min="0" 
                  max="100" 
                  value={onDemandPercentageAboveBase}
                  onChange={(e) => setOnDemandPercentageAboveBase(parseInt(e.target.value))}
                  className="w-full h-2 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-slate-800"
                />
                <p className="mt-2 text-[9px] text-slate-400 font-medium italic">Percentage of On-Demand for capacity beyond the base.</p>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-6">Instance Requirements</h3>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-[9px] font-black text-slate-400 uppercase">vCPU (Min)</label>
                  <span className="text-[10px] font-bold text-slate-700">2</span>
                </div>
                <div className="flex gap-2">
                  {[1, 2, 4, 8, 16].map(v => (
                    <button 
                      key={v} 
                      onClick={() => setMinCpu(v)}
                      className={`flex-1 py-1 text-[10px] font-bold rounded border transition-colors ${v === minCpu ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-[9px] font-black text-slate-400 uppercase">RAM (Min GiB)</label>
                  <span className="text-[10px] font-bold text-slate-700">{minRam}</span>
                </div>
                <div className="flex gap-2">
                  {[2, 4, 8, 16, 32].map(r => (
                    <button 
                      key={r} 
                      onClick={() => setMinRam(r)}
                      className={`flex-1 py-1 text-[10px] font-bold rounded border transition-colors ${r === minRam ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-8">
                <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Matching Pool ({matchingInstances.length})</h4>
                <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar pr-2">
                  {matchingInstances.map(inst => (
                    <div key={inst.type} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-100">
                      <div>
                        <p className="text-xs font-bold text-slate-800 font-mono">{inst.type}</p>
                        <p className="text-[9px] text-slate-500 font-medium">{inst.cpu} vCPU • {inst.ram} GiB RAM</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] font-black text-slate-900">${inst.price}/hr</p>
                        <p className="text-[8px] text-green-600 font-bold uppercase">Available</p>
                      </div>
                    </div>
                  ))}
                  {matchingInstances.length === 0 && (
                    <div className="text-center py-4 text-slate-400 text-xs font-medium italic">
                      No instances match these requirements.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="bg-orange-600 p-6 rounded-2xl text-white shadow-lg shadow-orange-900/20">
            <h4 className="text-xs font-black uppercase tracking-widest mb-2">Optimization Tip</h4>
            <p className="text-xs font-medium text-orange-100 leading-relaxed">
              For non-critical workloads, set On-Demand Base to 0 and OD % Above Base to 20% to maximize Spot savings while maintaining a small safety buffer.
            </p>
          </div>
        </div>

        {/* Visualization Panel */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm h-full flex flex-col">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-8">Fleet Distribution Simulation</h3>
            
            <div className="flex-1 flex flex-col justify-center">
              <div className="grid grid-cols-2 gap-8 mb-12">
                <div className="text-center p-6 bg-slate-50 rounded-3xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">On-Demand Instances</p>
                  <p className="text-6xl font-black text-slate-900 tracking-tighter">{totalOD}</p>
                  <p className="text-xs font-bold text-slate-500 mt-2">Guaranteed Capacity</p>
                </div>
                <div className="text-center p-6 bg-orange-50 rounded-3xl border border-orange-100">
                  <p className="text-[10px] font-black text-orange-400 uppercase tracking-widest mb-2">Spot Instances</p>
                  <p className="text-6xl font-black text-orange-600 tracking-tighter">{spot}</p>
                  <p className="text-xs font-bold text-orange-500 mt-2">Cost Optimized</p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex justify-between text-[10px] font-black text-slate-400 uppercase tracking-widest">
                  <span>Spot ({Math.round((spot/desiredCapacity)*100)}%)</span>
                  <span>On-Demand ({Math.round((totalOD/desiredCapacity)*100)}%)</span>
                </div>
                <div className="w-full h-12 bg-slate-100 rounded-2xl flex overflow-hidden shadow-inner border-4 border-white">
                  <div 
                    className="bg-orange-500 h-full transition-all duration-500 ease-out flex items-center justify-center text-white text-[10px] font-black"
                    style={{ width: `${(spot / desiredCapacity) * 100}%` }}
                  >
                    {spot > 0 && 'SPOT'}
                  </div>
                  <div 
                    className="bg-slate-800 h-full transition-all duration-500 ease-out flex items-center justify-center text-white text-[10px] font-black"
                    style={{ width: `${(totalOD / desiredCapacity) * 100}%` }}
                  >
                    {totalOD > 0 && 'OD'}
                  </div>
                </div>
              </div>

              <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex items-center gap-4 p-4 bg-green-50 rounded-2xl border border-green-100">
                  <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-xl shadow-sm">💰</div>
                  <div>
                    <p className="text-[10px] font-black text-green-800 uppercase">Estimated Savings</p>
                    <p className="text-lg font-black text-green-900 tracking-tight">~{Math.round((spot / desiredCapacity) * 70)}%</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 p-4 bg-blue-50 rounded-2xl border border-blue-100">
                  <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-xl shadow-sm">🛡️</div>
                  <div>
                    <p className="text-[10px] font-black text-blue-800 uppercase">Resilience Score</p>
                    <p className="text-lg font-black text-blue-900 tracking-tight">{totalOD > desiredCapacity * 0.3 ? 'High' : 'Medium'}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-8 pt-8 border-t border-slate-100 flex justify-end">
              <button className="px-8 py-4 bg-slate-900 text-white rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-slate-800 transition-all shadow-xl shadow-slate-900/20 active:scale-95">
                Apply to AWS Fleet
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CapacityBalancer;
