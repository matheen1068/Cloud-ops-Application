import React, { useState } from 'react';
import type { AccessLevel, MeResponse } from '@cloud-ops/shared';
import { api } from '../lib/api';
import { getConfig } from '../lib/config';

interface ConnectAccountProps {
  onboarding: MeResponse['onboarding'];
  onConnected: () => Promise<void>;
}

const inputClass =
  'w-full px-4 py-3 rounded-xl border border-slate-200 text-sm font-medium bg-slate-50/50 focus:outline-none focus:ring-2 focus:ring-orange-500/50';
const labelClass = 'text-[10px] font-black text-slate-400 uppercase tracking-wider';

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 px-3 py-1 rounded-lg bg-slate-100 text-[10px] font-black uppercase text-slate-600 hover:bg-orange-100 hover:text-orange-700"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
};

const ConnectAccount: React.FC<ConnectAccountProps> = ({ onboarding, onConnected }) => {
  const [roleArn, setRoleArn] = useState('');
  const [alias, setAlias] = useState('');
  const [regions, setRegions] = useState(getConfig().region);
  const [accessLevel, setAccessLevel] = useState<AccessLevel>('Operate');
  const [showExternalId, setShowExternalId] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!onboarding) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center text-sm text-slate-500">
        Only workspace owners and admins can connect AWS accounts.
      </div>
    );
  }

  const command = [
    'aws cloudformation deploy --stack-name cloudops-access-role',
    '--template-file cloudops-access-role.yaml --capabilities CAPABILITY_NAMED_IAM',
    `--parameter-overrides PlatformAccountId=${onboarding.platformAccountId}`,
    `PlatformRoleName=${onboarding.platformRoleName}`,
    `ExternalId=${onboarding.externalId}`,
    `AccessLevel=${accessLevel}`,
  ].join(' \\\n  ');

  const values: [string, string, boolean?][] = [
    ['Platform account ID', onboarding.platformAccountId],
    ['Platform role name', onboarding.platformRoleName],
    ['External ID', onboarding.externalId, true],
  ];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.connectAccount({
        roleArn: roleArn.trim(),
        alias: alias.trim(),
        regions: regions.split(',').map((r) => r.trim()).filter(Boolean),
        accessLevel,
      });
      await onConnected();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-8 animate-in fade-in duration-500">
      {/* Step 1 */}
      <section className="bg-white rounded-3xl border border-slate-200 p-8 space-y-6">
        <div>
          <p className="text-[10px] font-black text-orange-600 uppercase tracking-widest">Step 1</p>
          <h3 className="text-2xl font-black text-slate-900 tracking-tight">Create the access role in the AWS account</h3>
          <p className="text-sm text-slate-500 mt-1">
            One IAM role, <span className="font-mono">{onboarding.accessRoleName}</span>, that only Cloud-Ops can assume, and only with your external ID.
            It can read ASGs and change capacity. No deletes, no instance changes.
          </p>
        </div>

        <div className="grid gap-3">
          {values.map(([label, value, secret]) => (
            <div key={label} className="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-50 border border-slate-100">
              <div className="min-w-0">
                <p className={labelClass}>{label}</p>
                <p className="font-mono text-sm text-slate-800 truncate">
                  {secret && !showExternalId ? '•'.repeat(24) : value}
                </p>
              </div>
              <div className="flex gap-2">
                {secret && (
                  <button
                    type="button"
                    onClick={() => setShowExternalId(!showExternalId)}
                    className="px-3 py-1 rounded-lg text-[10px] font-black uppercase text-slate-500 hover:bg-slate-100"
                  >
                    {showExternalId ? 'Hide' : 'Show'}
                  </button>
                )}
                <CopyButton text={value} />
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className={labelClass}>
              Run with the AWS CLI, signed in to the account you're connecting
            </p>
            <div className="flex gap-2">
              <a
                href="/onboarding/cloudops-access-role.yaml"
                download
                className="px-3 py-1 rounded-lg bg-slate-100 text-[10px] font-black uppercase text-slate-600 hover:bg-orange-100 hover:text-orange-700"
              >
                Download template
              </a>
              <CopyButton text={command.replace(/ \\\n {2}/g, ' ')} />
            </div>
          </div>
          <pre className="bg-slate-900 text-orange-200 text-xs p-4 rounded-xl overflow-x-auto">{command}</pre>
          <p className="text-xs text-slate-400">
            Prefer Terraform or a whole AWS Organization? See <span className="font-mono">onboarding/</span> in the repo.
          </p>
        </div>
      </section>

      {/* Step 2 */}
      <section className="bg-white rounded-3xl border border-slate-200 p-8 space-y-6">
        <div>
          <p className="text-[10px] font-black text-orange-600 uppercase tracking-widest">Step 2</p>
          <h3 className="text-2xl font-black text-slate-900 tracking-tight">Connect it</h3>
          <p className="text-sm text-slate-500 mt-1">Cloud-Ops assumes the role to check it works before saving.</p>
        </div>

        <form onSubmit={submit} className="grid gap-5">
          <label className="space-y-2">
            <span className={labelClass}>Role ARN</span>
            <input
              required
              value={roleArn}
              onChange={(e) => setRoleArn(e.target.value)}
              placeholder={`arn:aws:iam::123456789012:role/${onboarding.accessRoleName}`}
              className={`${inputClass} font-mono`}
            />
          </label>
          <div className="grid sm:grid-cols-3 gap-5">
            <label className="space-y-2">
              <span className={labelClass}>Name</span>
              <input required value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Production" className={inputClass} />
            </label>
            <label className="space-y-2">
              <span className={labelClass}>Regions (comma separated)</span>
              <input required value={regions} onChange={(e) => setRegions(e.target.value)} className={inputClass} />
            </label>
            <label className="space-y-2">
              <span className={labelClass}>Access level</span>
              <select value={accessLevel} onChange={(e) => setAccessLevel(e.target.value as AccessLevel)} className={inputClass}>
                <option value="Operate">Operate (can scale)</option>
                <option value="ReadOnly">Read-only</option>
              </select>
            </label>
          </div>
          {error && <p className="text-sm font-medium text-red-700 bg-red-50 border border-red-100 rounded-xl p-3">{error}</p>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="px-8 py-3 bg-slate-900 text-white rounded-2xl text-xs font-black uppercase hover:bg-slate-800 disabled:opacity-60"
            >
              {saving ? 'Checking role…' : 'Connect account'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
};

export default ConnectAccount;
