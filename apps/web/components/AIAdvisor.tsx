
import React, { useState, useEffect } from 'react';
import { AWSAccount } from '../types';
import { getAIRecommendations } from '../services/geminiService';

interface AIAdvisorProps {
  accounts: AWSAccount[];
}

const AIAdvisor: React.FC<AIAdvisorProps> = ({ accounts }) => {
  const [recommendations, setRecommendations] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const fetchRecommendations = async () => {
      setLoading(true);
      const result = await getAIRecommendations(accounts);
      setRecommendations(result);
      setLoading(false);
    };
    fetchRecommendations();
  }, [accounts]);

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-700">
      <div className="text-center space-y-4">
        <div className="relative inline-block">
          <div className="absolute inset-0 bg-gradient-to-tr from-orange-400 to-purple-500 blur-xl opacity-30 animate-pulse rounded-full"></div>
          <div className="relative p-4 bg-white rounded-3xl border border-slate-100 text-4xl shadow-xl">☁️</div>
        </div>
        <h3 className="text-3xl font-black text-slate-900 tracking-tighter">Amazon Bedrock Advisor</h3>
        <p className="text-slate-500 max-w-lg mx-auto font-medium text-sm">
          Deep reasoning models analyzing your multi-account EC2 fleet metrics. 
          Powered by centralized Lambda telemetry.
        </p>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl overflow-hidden">
        <div className="p-6 bg-slate-900 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex space-x-1">
              <span className="w-2 h-2 bg-purple-500 rounded-full"></span>
              <span className="w-2 h-2 bg-orange-500 rounded-full"></span>
              <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
            </div>
            <span className="text-white font-black text-[11px] uppercase tracking-widest">Bedrock Analysis Stream</span>
          </div>
          <div className="flex items-center gap-4">
             <span className="text-[10px] font-bold text-slate-400">MODEL: ANTHROPIC CLAUDE 3 (via Bedrock)</span>
             <button 
                onClick={() => window.location.reload()} 
                className="text-xs font-black text-slate-400 hover:text-white transition-colors uppercase tracking-tight"
              >
                Refresh
              </button>
          </div>
        </div>

        <div className="p-10">
          {loading ? (
            <div className="space-y-8">
              <div className="space-y-3">
                <div className="h-4 bg-slate-100 rounded-full w-3/4 animate-pulse"></div>
                <div className="h-4 bg-slate-100 rounded-full w-1/2 animate-pulse"></div>
              </div>
              <div className="space-y-3">
                <div className="h-4 bg-slate-100 rounded-full w-2/3 animate-pulse"></div>
                <div className="h-4 bg-slate-100 rounded-full w-1/3 animate-pulse"></div>
              </div>
              <div className="pt-8 flex flex-col items-center gap-4">
                <div className="w-10 h-10 border-4 border-slate-100 border-t-orange-500 rounded-full animate-spin"></div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Invoking Bedrock Inference...</p>
              </div>
            </div>
          ) : (
            <div className="prose prose-slate max-w-none">
              <div className="whitespace-pre-wrap text-slate-700 leading-relaxed font-medium text-sm sm:text-base">
                {recommendations}
              </div>
            </div>
          )}
        </div>

        {!loading && (
          <div className="px-10 py-8 bg-slate-50 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-3">
               <div className="p-2 bg-orange-100 rounded-xl text-orange-600 font-bold text-xs">AWS OPTIMIZED</div>
               <p className="text-[11px] text-slate-500 font-bold uppercase tracking-tight">
                 Fleet health Score: <span className="text-slate-900">94/100</span>
               </p>
            </div>
            <div className="flex gap-3">
              <button className="px-6 py-3 bg-slate-200 text-slate-700 rounded-2xl text-[11px] font-black uppercase hover:bg-slate-300 transition-all">
                Export Plan
              </button>
              <button className="px-6 py-3 bg-orange-600 text-white rounded-2xl text-[11px] font-black uppercase shadow-lg shadow-orange-900/20 hover:bg-orange-700 transition-all">
                Execute Recommendations
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm text-center group hover:border-orange-200 transition-all">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Cost Optimization</p>
          <p className="text-4xl font-black text-slate-900 group-hover:text-orange-600 transition-colors tracking-tighter">88%</p>
        </div>
        <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm text-center group hover:border-orange-200 transition-all">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Inference Latency</p>
          <p className="text-4xl font-black text-slate-900 group-hover:text-orange-600 transition-colors tracking-tighter">1.2s</p>
        </div>
        <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm text-center group hover:border-orange-200 transition-all">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Confidence Level</p>
          <p className="text-4xl font-black text-slate-900 group-hover:text-orange-600 transition-colors tracking-tighter">98%</p>
        </div>
      </div>
    </div>
  );
};

export default AIAdvisor;
