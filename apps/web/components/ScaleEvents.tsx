import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  validateCapacity,
  type CapacitySettings,
  type ReadinessResult,
  type ScaleEvent,
} from '@cloud-ops/shared';
import { api } from '../lib/api';
import type { ASG, AWSAccount } from '../types';
import ReadinessList, { hasFailures } from './ReadinessList';

interface Props {
  accounts: AWSAccount[];
  canOperate: boolean;
  onChanged: () => void; // refresh fleet numbers elsewhere in the app
}

const STATUS_STYLE: Record<ScaleEvent['status'], string> = {
  scheduled: 'bg-blue-50 text-blue-700',
  'scaling-up': 'bg-amber-50 text-amber-800',
  active: 'bg-green-50 text-green-700',
  'scaling-down': 'bg-amber-50 text-amber-800',
  completed: 'bg-slate-100 text-slate-600',
  failed: 'bg-red-50 text-red-700',
  cancelled: 'bg-slate-100 text-slate-400',
};
const LIVE: ScaleEvent['status'][] = ['scheduled', 'scaling-up', 'active', 'scaling-down'];

const inputClass =
  'w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-medium bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/50';
const labelClass = 'text-[10px] font-black text-slate-400 uppercase tracking-wider';

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** yyyy-MM-ddTHH:mm in local time, for <input type="datetime-local"> */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Event capacity from a multiplier: min = desired so capacity holds during the event. */
function multiply(c: CapacitySettings, m: number): CapacitySettings {
  const desired = Math.max(1, Math.ceil(Math.max(c.desired, 1) * m));
  return { min: desired, desired, max: Math.max(c.max, desired) };
}

const ScaleEvents: React.FC<Props> = ({ accounts, canOperate, onChanged }) => {
  const [events, setEvents] = useState<ScaleEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const { events } = await api.listEvents();
      setEvents(events);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while something is scheduled or running, so the timeline updates live.
  useEffect(() => {
    if (!events.some((e) => LIVE.includes(e.status))) return;
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [events, load]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xl font-black text-slate-900 tracking-tight">Scale Events</h3>
          <p className="text-sm text-slate-500">Pre-scale before a known spike, hold, then scale back automatically.</p>
        </div>
        {canOperate && !showForm && (
          <button onClick={() => setShowForm(true)} className="px-5 py-3 bg-orange-600 text-white rounded-2xl text-xs font-black uppercase hover:bg-orange-700">
            New event
          </button>
        )}
      </div>

      {error && <p className="p-4 rounded-2xl bg-red-50 border border-red-100 text-sm text-red-700">{error}</p>}

      {showForm && (
        <EventForm
          accounts={accounts}
          onCancel={() => setShowForm(false)}
          onCreated={async () => {
            setShowForm(false);
            await load();
          }}
        />
      )}

      {loading ? (
        <p className="text-sm text-slate-400">Loading events…</p>
      ) : events.length === 0 && !showForm ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center space-y-2">
          <p className="text-4xl">🗓️</p>
          <h4 className="text-lg font-black text-slate-900">No scale events yet</h4>
          <p className="text-sm text-slate-500">Plan one for your next live match, sale or launch.</p>
        </div>
      ) : (
        events.map((e) => (
          <EventCard
            key={e.eventId}
            event={e}
            canOperate={canOperate}
            onChanged={async () => {
              await load();
              onChanged();
            }}
          />
        ))
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------

const EventForm: React.FC<{ accounts: AWSAccount[]; onCancel: () => void; onCreated: () => Promise<void> }> = ({
  accounts,
  onCancel,
  onCreated,
}) => {
  const defaultStart = useMemo(() => {
    const d = new Date(Date.now() + 2 * 3600_000);
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
    return d;
  }, []);
  const [name, setName] = useState('');
  const [start, setStart] = useState(toLocalInput(defaultStart));
  const [end, setEnd] = useState(toLocalInput(new Date(defaultStart.getTime() + 3 * 3600_000)));
  const [prescale, setPrescale] = useState(30);
  const [multiplier, setMultiplier] = useState(2);
  const [selected, setSelected] = useState<Record<string, CapacitySettings>>({});
  const [checks, setChecks] = useState<ReadinessResult[] | null>(null);
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const operable = accounts.filter((a) => a.accessLevel === 'Operate');
  const allAsgs: ASG[] = operable.flatMap((a) => a.asgs);
  const byId = Object.fromEntries(allAsgs.map((g) => [g.id, g]));

  const toggle = (g: ASG) => {
    setChecks(null);
    setSelected((s) => {
      const next = { ...s };
      if (next[g.id]) delete next[g.id];
      else next[g.id] = multiply(g.capacity, multiplier);
      return next;
    });
  };

  const applyMultiplier = () => {
    setChecks(null);
    setSelected((s) => Object.fromEntries(Object.keys(s).map((id) => [id, multiply(byId[id].capacity, multiplier)])));
  };

  const targets = (Object.entries(selected) as [string, CapacitySettings][]).map(([id, target]) => {
    const g = byId[id];
    return { asg: { accountId: g.accountId, region: g.region, asgName: g.name }, target };
  });

  const hours = Math.max(0, (new Date(end).getTime() - new Date(start).getTime()) / 3600_000 + prescale / 60);
  const extraInstanceHours = Math.round(
    (Object.entries(selected) as [string, CapacitySettings][]).reduce((sum, [id, t]) => sum + Math.max(0, t.desired - byId[id].capacity.desired), 0) * hours,
  );

  const validate = (): string | null => {
    if (!name.trim()) return 'Give the event a name.';
    if (targets.length === 0) return 'Pick at least one ASG.';
    if (new Date(end) <= new Date(start)) return 'The event must end after it starts.';
    for (const t of targets) {
      const invalid = validateCapacity(t.target);
      if (invalid) return `${t.asg.asgName}: ${invalid}`;
    }
    return null;
  };

  const runChecks = async () => {
    const invalid = validate();
    if (invalid) return setError(invalid);
    setBusy('check');
    setError(null);
    try {
      const { results } = await api.readiness({ targets: targets.map((t) => ({ asg: t.asg, capacity: t.target })) });
      setChecks(results);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const invalid = validate();
    if (invalid) return setError(invalid);
    setBusy('save');
    setError(null);
    try {
      await api.createEvent({
        name: name.trim(),
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(end).toISOString(),
        prescaleMinutes: prescale,
        targets,
      });
      await onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="bg-white rounded-3xl border border-orange-200 p-8 space-y-6">
      <div className="grid sm:grid-cols-4 gap-4">
        <label className="space-y-1 sm:col-span-4">
          <span className={labelClass}>Event name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="IPL final, Diwali sale, Product launch…" className={inputClass} />
        </label>
        <label className="space-y-1">
          <span className={labelClass}>Traffic starts</span>
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={inputClass} />
        </label>
        <label className="space-y-1">
          <span className={labelClass}>Ends (scale back)</span>
          <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={inputClass} />
        </label>
        <label className="space-y-1">
          <span className={labelClass}>Pre-scale (minutes before)</span>
          <input type="number" min={0} max={240} value={prescale} onChange={(e) => setPrescale(Number(e.target.value))} className={inputClass} />
        </label>
        <div className="space-y-1">
          <span className={labelClass}>Multiplier</span>
          <div className="flex gap-2">
            <input type="number" min={1} step={0.5} value={multiplier} onChange={(e) => setMultiplier(Number(e.target.value))} className={inputClass} />
            <button type="button" onClick={applyMultiplier} className="px-3 rounded-lg bg-slate-100 text-[10px] font-black uppercase text-slate-600 hover:bg-slate-200">
              Apply
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <span className={labelClass}>Auto Scaling groups</span>
        {allAsgs.length === 0 && <p className="text-sm text-slate-500">No ASGs in accounts connected with Operate access.</p>}
        {allAsgs.map((g) => {
          const t = selected[g.id];
          return (
            <div key={g.id} className={`p-3 rounded-xl border ${t ? 'border-orange-200 bg-orange-50/40' : 'border-slate-100 bg-slate-50'}`}>
              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={!!t} onChange={() => toggle(g)} className="accent-orange-600" />
                <span className="text-sm font-bold text-slate-800">{g.name}</span>
                <span className="text-[10px] font-bold text-slate-400 uppercase">{g.region}</span>
                <span className="ml-auto text-xs text-slate-500">
                  now {g.capacity.min}/{g.capacity.desired}/{g.capacity.max}
                </span>
              </label>
              {t && (
                <div className="mt-3 grid grid-cols-3 gap-3">
                  {(['min', 'desired', 'max'] as const).map((k) => (
                    <label key={k} className="space-y-1">
                      <span className={labelClass}>{k}</span>
                      <input
                        type="number"
                        min={0}
                        value={t[k]}
                        onChange={(e) => {
                          setChecks(null);
                          setSelected((s) => ({ ...s, [g.id]: { ...s[g.id], [k]: Number(e.target.value) } }));
                        }}
                        className={inputClass}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {targets.length > 0 && (
        <p className="text-xs font-medium text-slate-500">
          ≈ <span className="font-black text-slate-800">{extraInstanceHours}</span> extra instance-hours over the event (including pre-scale).
        </p>
      )}

      {checks && <ReadinessList results={checks} />}
      {error && <p className="text-sm font-medium text-red-700 bg-red-50 border border-red-100 rounded-xl p-3">{error}</p>}

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-4 py-3 rounded-2xl text-xs font-black uppercase text-slate-500 hover:bg-slate-100">
          Cancel
        </button>
        <button
          onClick={runChecks}
          disabled={busy !== null}
          className="px-5 py-3 rounded-2xl text-xs font-black uppercase bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-60"
        >
          {busy === 'check' ? 'Checking…' : 'Check readiness'}
        </button>
        <button
          onClick={save}
          disabled={busy !== null}
          className={`px-6 py-3 rounded-2xl text-xs font-black uppercase text-white disabled:opacity-60 ${
            checks && hasFailures(checks) ? 'bg-red-600 hover:bg-red-700' : 'bg-slate-900 hover:bg-slate-800'
          }`}
        >
          {busy === 'save' ? 'Scheduling…' : checks && hasFailures(checks) ? 'Schedule anyway' : 'Schedule event'}
        </button>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------

const EventCard: React.FC<{ event: ScaleEvent; canOperate: boolean; onChanged: () => Promise<void> }> = ({
  event,
  canOperate,
  onChanged,
}) => {
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upAt = new Date(new Date(event.startsAt).getTime() - event.prescaleMinutes * 60_000).toISOString();
  const canEnd = ['scaling-up', 'active'].includes(event.status) || (event.status === 'failed' && event.targets.some((t) => t.state === 'scaled'));
  const timeline = showAll ? [...event.timeline].reverse() : [...event.timeline].reverse().slice(0, 5);
  const hasProblems = event.timeline.some((t) => t.level !== 'info');
  const [sent, setSent] = useState(false);

  const investigate = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.investigateEvent(event.eventId);
      setSent(true);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const act = async () => {
    const question = event.status === 'scheduled' ? `Cancel "${event.name}"?` : `End "${event.name}" now and scale back to baseline?`;
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      await api.cancelEvent(event.eventId);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h4 className="text-lg font-black text-slate-900">{event.name}</h4>
            <span className={`px-2 py-1 rounded text-[10px] font-black uppercase ${STATUS_STYLE[event.status]}`}>{event.status}</span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {when(event.startsAt)} → {when(event.endsAt)} · scale-up {when(upAt)} · by {event.createdBy}
          </p>
        </div>
        {canOperate && (event.status === 'scheduled' || canEnd) && (
          <button
            onClick={act}
            disabled={busy}
            className="shrink-0 px-4 py-2 rounded-xl text-[11px] font-black uppercase border-2 border-slate-200 text-slate-600 hover:border-red-200 hover:text-red-600 disabled:opacity-60"
          >
            {busy ? 'Working…' : event.status === 'scheduled' ? 'Cancel' : 'End now'}
          </button>
        )}
      </div>

      <div className="grid gap-2">
        {event.targets.map((t) => (
          <div key={`${t.asg.accountId}-${t.asg.asgName}`} className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100 text-xs">
            <span className="font-bold text-slate-800">{t.asg.asgName}</span>
            <span className="text-[10px] font-bold text-slate-400 uppercase">{t.asg.region}</span>
            <span className="text-slate-500">
              {t.baseline ? `${t.baseline.min}/${t.baseline.desired}/${t.baseline.max} → ` : ''}
              <span className="font-black text-slate-800">{t.target.min}/{t.target.desired}/{t.target.max}</span>
            </span>
            <span className="ml-auto px-2 py-0.5 rounded bg-white border border-slate-200 text-[10px] font-black uppercase text-slate-500">{t.state}</span>
          </div>
        ))}
      </div>

      {event.report && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            ['Launched', `${event.report.launches}`],
            ['Failed launches', `${event.report.failedLaunches}`],
            ['Ready after', event.report.slowestReadySeconds !== undefined ? `${Math.floor(event.report.slowestReadySeconds / 60)}m ${event.report.slowestReadySeconds % 60}s` : 'n/a'],
            ['Extra instance-hours', `${event.report.extraInstanceHours}`],
          ].map(([label, value]) => (
            <div key={label} className="p-3 rounded-xl bg-white border border-slate-200">
              <p className="text-[10px] font-black text-slate-400 uppercase">{label}</p>
              <p className={`text-lg font-black ${label === 'Failed launches' && value !== '0' ? 'text-red-600' : 'text-slate-900'}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {canOperate && hasProblems && event.status !== 'scheduled' && (
        <button
          onClick={investigate}
          disabled={busy || sent}
          className="px-4 py-2 rounded-xl text-[11px] font-black uppercase bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {sent ? 'Sent to DevOps Agent ✓' : 'Send to AWS DevOps Agent'}
        </button>
      )}

      <div className="space-y-1">
        {timeline.map((t, i) => (
          <p key={i} className={`text-xs ${t.level === 'error' ? 'text-red-700' : t.level === 'warn' ? 'text-amber-800' : 'text-slate-500'}`}>
            <span className="font-mono text-slate-400 mr-2">{new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            {t.message}
          </p>
        ))}
        {event.timeline.length > 5 && (
          <button onClick={() => setShowAll(!showAll)} className="text-[10px] font-black uppercase text-orange-600 hover:underline">
            {showAll ? 'Show less' : `Show all ${event.timeline.length}`}
          </button>
        )}
      </div>
      {error && <p className="text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
};

export default ScaleEvents;
