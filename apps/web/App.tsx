
import React, { useState, useEffect } from 'react';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import AccountExplorer from './components/AccountExplorer';
import Analytics from './components/Analytics';
import CapacityBalancer from './components/CapacityBalancer';
import AIAdvisor from './components/AIAdvisor';
import Login from './components/Login';
import { MOCK_ACCOUNTS } from './mockData';
import { AuthState } from './types';

const App: React.FC = () => {
  const [auth, setAuth] = useState<AuthState>({
    isAuthenticated: false,
    user: null,
  });
  const [activeTab, setActiveTab] = useState('dashboard');

  const handleLogin = (user: string) => {
    setAuth({ isAuthenticated: true, user });
  };

  const handleLogout = () => {
    setAuth({ isAuthenticated: false, user: null });
    setActiveTab('dashboard');
  };

  if (!auth.isAuthenticated) {
    return <Login onLogin={handleLogin} />;
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return <Dashboard accounts={MOCK_ACCOUNTS} />;
      case 'accounts':
        return <AccountExplorer accounts={MOCK_ACCOUNTS} />;
      case 'analytics':
        return <Analytics />;
      case 'balancer':
        return <CapacityBalancer accounts={MOCK_ACCOUNTS} />;
      case 'ai':
        return <AIAdvisor accounts={MOCK_ACCOUNTS} />;
      default:
        return <Dashboard accounts={MOCK_ACCOUNTS} />;
    }
  };

  return (
    <Layout 
      activeTab={activeTab} 
      setActiveTab={setActiveTab} 
      onLogout={handleLogout}
      user={auth.user || 'Guest'}
    >
      {renderContent()}
    </Layout>
  );
};

export default App;
