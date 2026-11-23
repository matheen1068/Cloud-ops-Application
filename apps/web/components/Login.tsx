
import React, { useState, useEffect } from 'react';

interface LoginProps {
  onLogin: (user: string) => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [email, setEmail] = useState('admin@enterprise.cloud');
  const [isLoading, setIsLoading] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    // Simulate AWS Cognito roundtrip
    setTimeout(() => {
      onLogin(email);
      setIsLoading(false);
    }, 1500);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900 p-6 relative overflow-hidden">
      {/* Background Decorative Elements with floating animations */}
      <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-orange-600/10 blur-[150px] rounded-full -translate-y-1/2 translate-x-1/2 animate-float"></div>
      <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-blue-600/10 blur-[150px] rounded-full translate-y-1/2 -translate-x-1/2 animate-float-delayed"></div>

      <div className={`w-full max-w-md relative z-10 transition-all duration-1000 transform ${isVisible ? 'translate-y-0 opacity-100 scale-100' : 'translate-y-12 opacity-0 scale-95'}`}>
        <div className="bg-white rounded-3xl shadow-[0_35px_60px_-15px_rgba(0,0,0,0.5)] overflow-hidden border border-white/20">
          <div className="p-8 sm:p-12">
            <div className={`mb-10 text-center transition-all delay-300 duration-700 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
              <h1 className="text-4xl tracking-tighter flex items-center justify-center gap-0">
                <span className="font-[900] text-slate-900">Cloud</span>
                <span className="font-[900] text-orange-600">-Ops</span>
              </h1>
              <div className="mt-5 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-50 border border-slate-200">
                <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse"></span>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Cognito User Pool Auth</span>
              </div>
              <p className="text-slate-500 mt-5 text-sm font-medium">AWS Centralized Fleet Management</p>
            </div>

            <form onSubmit={handleSubmit} className={`space-y-6 transition-all delay-500 duration-700 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
              <div className="space-y-2">
                <label className="text-[11px] font-black text-slate-400 uppercase tracking-wider" htmlFor="email">Cognito Username / Email</label>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-orange-500/50 transition-all text-sm font-medium bg-slate-50/50"
                  placeholder="admin@cloudops.internal"
                />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between">
                  <label className="text-[11px] font-black text-slate-400 uppercase tracking-wider" htmlFor="password">Password</label>
                  <a href="#" className="text-xs font-bold text-orange-600 hover:text-orange-700 transition-colors">Forgot?</a>
                </div>
                <input
                  id="password"
                  type="password"
                  required
                  defaultValue="••••••••"
                  className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-orange-500/50 transition-all text-sm font-medium bg-slate-50/50"
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full bg-slate-900 text-white font-black py-4 rounded-2xl hover:bg-slate-800 active:scale-[0.98] transition-all flex items-center justify-center gap-3 shadow-xl shadow-slate-900/20"
              >
                {isLoading ? (
                  <div className="w-5 h-5 border-3 border-white/20 border-t-white rounded-full animate-spin"></div>
                ) : (
                  <>
                    <span>SIGN IN</span>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
                  </>
                )}
              </button>
            </form>
          </div>

          <div className={`px-8 py-6 bg-slate-50 border-t border-slate-100 flex flex-col items-center gap-4 transition-all delay-700 duration-700 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Federated Identity Access</p>
            <button className="w-full flex items-center justify-center gap-3 px-6 py-3 border-2 border-slate-200 rounded-2xl text-xs font-black text-slate-600 hover:bg-white hover:border-orange-500/30 hover:text-orange-600 transition-all">
              <img src="https://upload.wikimedia.org/wikipedia/commons/9/93/Amazon_Web_Services_Logo.svg" className="h-4" alt="AWS" />
              FEDERATED SSO LOGIN
            </button>
          </div>
        </div>
        
        <div className={`mt-10 flex items-center justify-center gap-8 transition-all delay-900 duration-700 ${isVisible ? 'opacity-100' : 'opacity-0'}`}>
           <div className="flex flex-col items-center">
             <span className="text-[10px] font-black text-slate-500 uppercase tracking-tighter">Lambda Aggregator</span>
             <div className="w-6 h-1 bg-orange-500 rounded-full mt-1"></div>
           </div>
           <div className="flex flex-col items-center">
             <span className="text-[10px] font-black text-slate-500 uppercase tracking-tighter">DynamoDB State</span>
             <div className="w-6 h-1 bg-blue-500 rounded-full mt-1"></div>
           </div>
           <div className="flex flex-col items-center">
             <span className="text-[10px] font-black text-slate-500 uppercase tracking-tighter">Cross-Account</span>
             <div className="w-6 h-1 bg-green-500 rounded-full mt-1"></div>
           </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
