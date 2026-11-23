import React, { useCallback, useEffect, useState } from 'react';
import type { CapacitySettings, MeResponse } from '@cloud-ops/shared';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import AccountExplorer from './components/AccountExplorer';
import ConnectAccount from './components/ConnectAccount';
import Analytics from './components/Analytics';
import CapacityBalancer from './components/CapacityBalancer';
import AIAdvisor from './components/AIAdvisor';
import Login from './components/Login';
import { api } from './lib/api';
import { toUiAccounts } from './lib/adapters';
import { currentEmail, signOut } from './lib/auth';
import type { ASG, AWSAccount } from './types';

interface FleetState {
  me: MeResponse | null;
  accounts: AWSAccount[];
  warnings: string[]; // per-account/region problems from /asgs
  loading: boolean;
  error: string | null;
}

const EMPTY: FleetState = { me: null, accounts: [], warnings: [], loading: false, error: null };

const App: React.FC = () => {
  // undefined = still checking for an existing session
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [fleet, setFleet] = useState<FleetState>(EMPTY);

  useEffect(() => {
    currentEmail().then(setUser);
  }, []);

  const refresh = useCallback(async () => {
    setFleet((f) => ({ ...f, loading: true, error: null }));
    try {
      // /me first: on a brand-new user it creates the workspace.
      const me = await api.me();
      const [{ accounts }, asgs] = await Promise.all([api.listAccounts(), api.listAsgs()]);
      setFleet({
        me,
        accounts: toUiAccounts(accounts, asgs.asgs),
        warnings: asgs.errors.map((e) => `${e.accountId}${e.region ? ` (${e.region})` : ''}: ${e.message}`),
        loading: false,
        error: null,
      });
    } catch (err) {
      setFleet((f) => ({ ...f, loading: false, error: (err as Error).message }));
    }
  }, []);

  useEffect(() => {
    if (user) refresh();
  }, [user, refresh]);

  const handleLogout = async () => {
    await signOut();
    setUser(null);
    setFleet(EMPTY);
    setActiveTab('dashboard');
  };

  const handleScale = async (asg: ASG, capacity: CapacitySettings, reason: string) => {
    await api.setCapacity({
      asg: { accountId: asg.accountId, region: asg.region, asgName: asg.name },
      capacity,
      reason: reason || undefined,
    });
    await refresh();
  };

  if (user === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="w-10 h-10 border-4 border-slate-700 border-t-orange-500 rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user) return <Login onLogin={setUser} />;

  const role = fleet.me?.user.role;
  const canOperate = role === 'owner' || role === 'admin' || role === 'operator';

  const renderContent = () => {
    switch (activeTab) {
      case 'accounts':
        return (
          <AccountExplorer
            accounts={fleet.accounts}
            canOperate={canOperate}
            onScale={handleScale}
            onConnect={() => setActiveTab('connect')}
          />
        );
      case 'connect':
        return (
          <ConnectAccount
            onboarding={fleet.me?.onboarding}
            onConnected={async () => {
              await refresh();
              setActiveTab('accounts');
            }}
          />
        );
      case 'analytics':
        return <Analytics />;
      case 'balancer':
        return <CapacityBalancer accounts={fleet.accounts} />;
      case 'ai':
        return <AIAdvisor accounts={fleet.accounts} />;
      default:
        return <Dashboard accounts={fleet.accounts} onConnect={() => setActiveTab('connect')} />;
    }
  };

  return (
    <Layout
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      onLogout={handleLogout}
      onRefresh={refresh}
      refreshing={fleet.loading}
      user={user}
      subtitle={fleet.me ? `${fleet.me.user.role} · ${fleet.me.tenant.plan} plan` : 'Cognito Auth'}
    >
      {fleet.error && (
        <div className="mb-6 p-4 rounded-2xl bg-red-50 border border-red-100 text-sm font-medium text-red-700">
          {fleet.error}
        </div>
      )}
      {fleet.warnings.length > 0 && (
        <div className="mb-6 p-4 rounded-2xl bg-amber-50 border border-amber-100 text-xs font-medium text-amber-800 space-y-1">
          {fleet.warnings.map((w) => (
            <p key={w}>⚠️ {w}</p>
          ))}
        </div>
      )}
      {renderContent()}
    </Layout>
  );
};

export default App;
