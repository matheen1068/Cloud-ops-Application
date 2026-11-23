import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { configureAuth } from './lib/auth';
import { loadConfig } from './lib/config';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find root element to mount to');
}
const root = ReactDOM.createRoot(rootElement);

// Load config.json first: it tells the app which API and Cognito pool to use.
loadConfig()
  .then((config) => {
    configureAuth(config);
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  })
  .catch((err: Error) => {
    root.render(
      <div className="min-h-screen flex items-center justify-center bg-slate-900 p-6">
        <div className="max-w-lg bg-white rounded-3xl p-10 space-y-4">
          <h1 className="text-2xl font-black text-slate-900">Cloud-Ops isn't configured yet</h1>
          <p className="text-sm text-slate-600">{err.message}</p>
          <p className="text-sm text-slate-600">
            For local development, deploy the platform once, then run:
          </p>
          <pre className="bg-slate-900 text-orange-300 text-xs p-4 rounded-xl overflow-x-auto">npm run config -w @cloud-ops/web</pre>
        </div>
      </div>,
    );
  });
