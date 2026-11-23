import React, { useEffect, useState } from 'react';
import { confirmSignUp, resendSignUpCode, signIn, signUp } from '../lib/auth';

interface LoginProps {
  onLogin: (email: string) => void;
}

type Mode = 'signIn' | 'signUp' | 'confirm';

const COPY: Record<Mode, { button: string; hint: string }> = {
  signIn: { button: 'SIGN IN', hint: 'AWS Centralized Fleet Management' },
  signUp: { button: 'CREATE ACCOUNT', hint: 'Create your free Cloud-Ops workspace' },
  confirm: { button: 'VERIFY EMAIL', hint: 'Enter the code we emailed you' },
};

const inputClass =
  'w-full px-5 py-4 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-orange-500/50 transition-all text-sm font-medium bg-slate-50/50';
const labelClass = 'text-[11px] font-black text-slate-400 uppercase tracking-wider';

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
  };

  const doSignIn = async () => {
    const result = await signIn({ username: email, password });
    if (result.isSignedIn) {
      onLogin(email);
      return;
    }
    if (result.nextStep.signInStep === 'CONFIRM_SIGN_UP') {
      await resendSignUpCode({ username: email });
      setNotice('Your email is not verified yet. We sent you a new code.');
      setMode('confirm');
      return;
    }
    throw new Error(`One more step is needed to sign in: ${result.nextStep.signInStep}`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      if (mode === 'signIn') {
        await doSignIn();
      } else if (mode === 'signUp') {
        const result = await signUp({
          username: email,
          password,
          options: { userAttributes: { email } },
        });
        if (result.nextStep.signUpStep === 'CONFIRM_SIGN_UP') {
          setNotice(`We sent a verification code to ${email}.`);
          setMode('confirm');
        } else {
          await doSignIn();
        }
      } else {
        await confirmSignUp({ username: email, confirmationCode: code.trim() });
        await doSignIn();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const resend = async () => {
    setError(null);
    try {
      await resendSignUpCode({ username: email });
      setNotice(`New code sent to ${email}.`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900 p-6 relative overflow-hidden">
      <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-orange-600/10 blur-[150px] rounded-full -translate-y-1/2 translate-x-1/2 animate-float"></div>
      <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-blue-600/10 blur-[150px] rounded-full translate-y-1/2 -translate-x-1/2 animate-float-delayed"></div>

      <div className={`w-full max-w-md relative z-10 transition-all duration-1000 transform ${isVisible ? 'translate-y-0 opacity-100 scale-100' : 'translate-y-12 opacity-0 scale-95'}`}>
        <div className="bg-white rounded-3xl shadow-[0_35px_60px_-15px_rgba(0,0,0,0.5)] overflow-hidden border border-white/20">
          <div className="p-8 sm:p-12">
            <div className="mb-10 text-center">
              <h1 className="text-4xl tracking-tighter flex items-center justify-center gap-0">
                <span className="font-[900] text-slate-900">Cloud</span>
                <span className="font-[900] text-orange-600">-Ops</span>
              </h1>
              <div className="mt-5 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-50 border border-slate-200">
                <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse"></span>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Cognito User Pool Auth</span>
              </div>
              <p className="text-slate-500 mt-5 text-sm font-medium">{COPY[mode].hint}</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="space-y-2">
                <label className={labelClass} htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  disabled={mode === 'confirm'}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputClass}
                  placeholder="you@company.com"
                />
              </div>

              {mode !== 'confirm' ? (
                <div className="space-y-2">
                  <label className={labelClass} htmlFor="password">Password</label>
                  <input
                    id="password"
                    type="password"
                    required
                    minLength={mode === 'signUp' ? 12 : undefined}
                    autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={inputClass}
                  />
                  {mode === 'signUp' && (
                    <p className="text-[11px] text-slate-400 font-medium">12+ characters with upper and lower case letters and a number.</p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <label className={labelClass} htmlFor="code">Verification code</label>
                    <button type="button" onClick={resend} className="text-xs font-bold text-orange-600 hover:text-orange-700">Resend</button>
                  </div>
                  <input
                    id="code"
                    inputMode="numeric"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className={inputClass}
                    placeholder="123456"
                  />
                </div>
              )}

              {notice && <p className="text-xs font-medium text-green-700 bg-green-50 border border-green-100 rounded-xl p-3">{notice}</p>}
              {error && <p className="text-xs font-medium text-red-700 bg-red-50 border border-red-100 rounded-xl p-3">{error}</p>}

              <button
                type="submit"
                disabled={isLoading}
                className="w-full bg-slate-900 text-white font-black py-4 rounded-2xl hover:bg-slate-800 active:scale-[0.98] transition-all flex items-center justify-center gap-3 shadow-xl shadow-slate-900/20 disabled:opacity-60"
              >
                {isLoading ? (
                  <div className="w-5 h-5 border-3 border-white/20 border-t-white rounded-full animate-spin"></div>
                ) : (
                  <>
                    <span>{COPY[mode].button}</span>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
                  </>
                )}
              </button>
            </form>

            <p className="mt-6 text-center text-xs font-medium text-slate-500">
              {mode === 'signIn' ? (
                <>New to Cloud-Ops? <button onClick={() => switchMode('signUp')} className="font-black text-orange-600 hover:underline">Create an account</button></>
              ) : (
                <>Already have an account? <button onClick={() => switchMode('signIn')} className="font-black text-orange-600 hover:underline">Sign in</button></>
              )}
            </p>
          </div>

          <div className="px-8 py-6 bg-slate-50 border-t border-slate-100 flex flex-col items-center gap-4">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Federated Identity Access</p>
            <button disabled className="w-full flex items-center justify-center gap-3 px-6 py-3 border-2 border-slate-200 rounded-2xl text-xs font-black text-slate-400 cursor-not-allowed">
              <img src="https://upload.wikimedia.org/wikipedia/commons/9/93/Amazon_Web_Services_Logo.svg" className="h-4 opacity-50" alt="AWS" />
              FEDERATED SSO LOGIN · SOON
            </button>
          </div>
        </div>

        <div className="mt-10 flex items-center justify-center gap-8">
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
