
import React from 'react';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onLogout: () => void;
  user: string;
}

const Layout: React.FC<LayoutProps> = ({ children, activeTab, setActiveTab, onLogout, user }) => {
  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'accounts', label: 'Account Explorer', icon: '🏢' },
    { id: 'analytics', label: 'Analytics', icon: '📈' },
    { id: 'balancer', label: 'Capacity Balancer', icon: '⚖️' },
    { id: 'ai', label: 'Bedrock Advisor', icon: '✨' },
  ];

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-900 text-white flex flex-col shrink-0">
        <div className="p-6 border-b border-slate-800">
          <h1 className="text-xl tracking-tighter flex items-center gap-0">
            <span className="font-black text-white">Cloud</span>
            <span className="font-black text-orange-500">-Ops</span>
          </h1>
          <p className="text-[10px] text-slate-500 mt-1 uppercase tracking-widest font-bold">AWS Cognito Secured</p>
        </div>
        
        <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 ${
                activeTab === item.id 
                  ? 'bg-orange-600 text-white shadow-lg shadow-orange-900/40 translate-x-1' 
                  : 'text-slate-400 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <span>{item.icon}</span>
              <span className="font-bold text-sm tracking-tight">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="p-4 border-t border-slate-800 bg-slate-950/30">
          <div className="flex items-center gap-2 mb-4 px-2">
            <div className="w-2 h-2 rounded-full bg-orange-500 animate-pulse"></div>
            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-tighter">Lambda Sync Active</span>
          </div>
          <div className="flex items-center gap-3 p-3 bg-slate-800/50 rounded-lg">
            <div className="w-8 h-8 rounded-full bg-orange-500 flex items-center justify-center text-xs font-black shadow-inner">
              {user.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold truncate">{user}</p>
              <p className="text-xs text-slate-500 truncate">Cognito Auth</p>
            </div>
            <button 
              onClick={onLogout}
              className="p-1 text-slate-400 hover:text-red-400 transition-colors"
              title="Logout"
            >
              🚪
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8 shrink-0">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-black text-slate-800 capitalize tracking-tight">
              {activeTab.replace('-', ' ')}
            </h2>
            <div className="h-4 w-px bg-slate-300"></div>
            <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded border border-slate-200 font-black">
              MULTI-ACCOUNT HUB
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="relative flex items-center gap-2">
              <span className="text-[10px] text-slate-400 font-bold">CROSS-ACCOUNT LAMBDA</span>
              <span className="w-2 h-2 bg-green-500 rounded-full shadow-[0_0_8px_rgba(34,197,94,0.6)]"></span>
            </div>
            <div className="h-8 w-px bg-slate-200"></div>
            <button className="text-sm text-orange-600 font-bold hover:underline">Help & Docs</button>
          </div>
        </header>
        
        <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
          {children}
        </div>
      </main>
    </div>
  );
};

export default Layout;
