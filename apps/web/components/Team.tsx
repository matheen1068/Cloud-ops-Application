import React, { useCallback, useEffect, useState } from 'react';
import type { CreateInviteResponse, MeResponse, TeamView, UserRole } from '@cloud-ops/shared';
import { api } from '../lib/api';

const ROLES: { id: UserRole; label: string; help: string }[] = [
  { id: 'viewer', label: 'Viewer', help: 'Sees everything, changes nothing' },
  { id: 'operator', label: 'Operator', help: 'Scales, runs events and schedules' },
  { id: 'admin', label: 'Admin', help: 'Plus accounts, team, settings, approvals' },
  { id: 'owner', label: 'Owner', help: 'Plus owners and emergency override' },
];
const inputClass =
  'px-4 py-3 rounded-xl border border-slate-200 text-sm font-medium bg-slate-50/50 focus:outline-none focus:ring-2 focus:ring-orange-500/50';

const Team: React.FC<{ me: MeResponse; onLeft: () => void }> = ({ me, onLeft }) => {
  const [team, setTeam] = useState<TeamView | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('operator');
  const [sent, setSent] = useState<CreateInviteResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const myRole = me.user.role;
  const isAdmin = myRole === 'owner' || myRole === 'admin';

  const load = useCallback(async () => {
    try {
      setTeam(await api.listMembers());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sendInvite = () =>
    run(async () => {
      setSent(await api.invite({ email: email.trim(), role }));
      setEmail('');
      setCopied(false);
    });

  const leave = () => {
    if (!window.confirm(`Leave ${me.tenant.name}? You'll need a new invite to come back.`)) return;
    run(async () => {
      await api.removeMember(me.user.userId);
      onLeft();
    });
  };

  if (!team) return <p className="text-sm text-slate-400">{error ?? 'Loading team…'}</p>;
  const used = team.members.length + team.invites.length;

  return (
    <div className="max-w-5xl space-y-6 animate-in fade-in duration-500">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="text-xl font-black text-slate-900 tracking-tight">Team</h3>
          <p className="text-sm text-slate-500">Who can see and change {me.tenant.name}.</p>
        </div>
        <span className="text-xs font-black uppercase text-slate-400">
          {used} / {team.maxUsers ?? '∞'} seats · {me.tenant.plan} plan
        </span>
      </div>

      {error && <p className="p-4 rounded-2xl bg-red-50 border border-red-100 text-sm text-red-700">{error}</p>}

      {isAdmin && (
        <section className="bg-white rounded-3xl border border-slate-200 p-6 space-y-4">
          <div className="flex flex-wrap gap-2">
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" className={`${inputClass} flex-1 min-w-[220px]`} />
            <select value={role} onChange={(e) => setRole(e.target.value as UserRole)} className={inputClass}>
              {ROLES.filter((r) => r.id !== 'owner' || myRole === 'owner').map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
            <button onClick={sendInvite} disabled={busy || !email.trim()} className="px-6 py-3 rounded-xl text-xs font-black uppercase text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-60">
              Invite
            </button>
          </div>
          <p className="text-xs text-slate-400">{ROLES.find((r) => r.id === role)?.help}</p>
          {sent && (
            <div className="p-4 rounded-2xl bg-green-50 border border-green-100 space-y-2">
              <p className="text-sm font-bold text-green-900">
                {sent.emailed ? `Invite emailed to ${sent.invite.email}.` : `Invite created for ${sent.invite.email}. Send them this link:`}
              </p>
              <div className="flex gap-2">
                <input readOnly value={sent.link} className="flex-1 px-3 py-2 rounded-lg bg-white border border-green-200 font-mono text-xs" />
                <button
                  onClick={() => navigator.clipboard.writeText(sent.link).then(() => setCopied(true))}
                  className="px-3 rounded-lg text-[11px] font-black uppercase bg-white border border-green-200 text-green-800"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="text-xs text-green-700">They sign up or sign in with that email address. The invite expires in 7 days.</p>
            </div>
          )}
        </section>
      )}

      <section className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100">
        {team.members.map((m) => {
          const self = m.userId === me.user.userId;
          const canEdit = isAdmin && !self && (m.role !== 'owner' || myRole === 'owner');
          return (
            <div key={m.userId} className="p-4 flex flex-wrap items-center gap-4">
              <div className="w-9 h-9 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-xs font-black">
                {m.email.slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-slate-800 truncate">{m.email}{self && <span className="text-slate-400 font-medium"> (you)</span>}</p>
                {m.joinedAt && <p className="text-xs text-slate-400">Joined {new Date(m.joinedAt).toLocaleDateString()}</p>}
              </div>
              {canEdit ? (
                <select
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => run(() => api.setMemberRole(m.userId, e.target.value as UserRole))}
                  className="px-3 py-2 rounded-lg border border-slate-200 text-xs font-bold bg-white"
                >
                  {ROLES.filter((r) => r.id !== 'owner' || myRole === 'owner').map((r) => (
                    <option key={r.id} value={r.id}>{r.label}</option>
                  ))}
                </select>
              ) : (
                <span className="px-3 py-1 rounded-full bg-slate-100 text-[11px] font-black uppercase text-slate-600">{m.role}</span>
              )}
              {canEdit && (
                <button
                  onClick={() => window.confirm(`Remove ${m.email}?`) && run(() => api.removeMember(m.userId))}
                  disabled={busy}
                  className="text-[11px] font-black uppercase text-slate-400 hover:text-red-600"
                >
                  Remove
                </button>
              )}
              {self && me.workspaces.length > 1 && (
                <button onClick={leave} disabled={busy} className="text-[11px] font-black uppercase text-slate-400 hover:text-red-600">
                  Leave
                </button>
              )}
            </div>
          );
        })}
      </section>

      {team.invites.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-black uppercase text-slate-400">Pending invites</h4>
          <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100">
            {team.invites.map((i) => (
              <div key={i.inviteId} className="p-4 flex flex-wrap items-center gap-4 text-sm">
                <span className="font-bold text-slate-700 flex-1">{i.email}</span>
                <span className="text-xs font-black uppercase text-slate-500">{i.role}</span>
                <span className="text-xs text-slate-400">Expires {new Date(i.expiresAt).toLocaleDateString()}</span>
                <button onClick={() => run(() => api.revokeInvite(i.inviteId))} disabled={busy} className="text-[11px] font-black uppercase text-slate-400 hover:text-red-600">
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};

export default Team;
