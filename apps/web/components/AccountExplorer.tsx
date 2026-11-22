
import React, { useState } from 'react';
import { AWSAccount, ASG, InstanceMetrics } from '../types';

interface AccountExplorerProps {
  accounts: AWSAccount[];
}

const AccountExplorer: React.FC<AccountExplorerProps> = ({ accounts }) => {
  const [expandedAccount, setExpandedAccount] = useState<string | null>(accounts[0]?.id || null);

  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      {accounts.map((account) => (
        <div 
          key={account.id} 
          className={`bg-white rounded-xl border transition-all ${
            expandedAccount === account.id ? 'border-blue-200 shadow-md' : 'border-slate-200 shadow-sm hover:border-slate-300'
          }`}
        >
          {/* Account Header */}
          <button
            onClick={() => setExpandedAccount(expandedAccount === account.id ? null : account.id)}
            className="w-full px-6 py-4 flex items-center justify-between text-left"
          >
            <div className="flex items-center gap-4">
              <div className="p-2 bg-slate-100 rounded-lg text-slate-500">
                🏢
              </div>
              <div>
                <h3 className="font-bold text-slate-900">{account.name}</h3>
                <p className="text-xs text-slate-500">AWS ID: {account.id}</p>
              </div>
            </div>
            <div className="flex items-center gap-8">
              <div className="hidden sm:flex flex-col items-end">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Running ASGs</span>
                <span className="text-lg font-bold text-slate-800">{account.asgs.length}</span>
              </div>
              <span className={`text-xl transition-transform ${expandedAccount === account.id ? 'rotate-180' : ''}`}>
                ⌄
              </span>
            </div>
          </button>

          {/* Account Content (ASGs) */}
          {expandedAccount === account.id && (
            <div className="px-6 pb-6 pt-2 border-t border-slate-50">
              <div className="grid grid-cols-1 gap-4">
                {account.asgs.map((asg) => (
                  <div key={asg.id} className="p-4 bg-slate-50 rounded-lg border border-slate-100">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h4 className="font-semibold text-slate-800">{asg.name}</h4>
                        <p className="text-[10px] font-bold text-slate-400 uppercase">{asg.region}</p>
                      </div>
                      <div className="flex gap-2">
                        {asg.metrics.map((m, idx) => (
                          <span 
                            key={idx} 
                            className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-tight ${
                              m.lifecycle === 'spot' ? 'bg-blue-100 text-blue-700' : 'bg-indigo-100 text-indigo-700'
                            }`}
                          >
                            {m.lifecycle}
                          </span>
                        ))}
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {asg.metrics.map((m, idx) => (
                        <div key={idx} className="bg-white p-3 rounded border border-slate-200 flex justify-between items-center shadow-sm">
                          <div>
                            <p className="text-xs font-medium text-slate-500">Instance Type</p>
                            <p className="text-sm font-bold text-slate-800 font-mono">{m.type}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs font-medium text-slate-500">Count</p>
                            <p className="text-lg font-bold text-slate-900">{m.count}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export default AccountExplorer;
