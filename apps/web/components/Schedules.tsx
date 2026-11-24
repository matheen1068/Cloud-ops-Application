import React, { useCallback, useEffect, useState } from 'react';
import { offShareOfWeek, refLabel, WEEKDAYS, type ScaleSchedule, type Weekday } from '@cloud-ops/shared';
import { api } from '../lib/api';
import { labelOf, refOf } from '../lib/adapters';
import type { ASG, AWSAccount } from '../types';

interface Props {
  accounts: AWSAccount[];
  canOperate: boolean;
  onChanged: () => void;
}

const inputClass =
  'w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-medium bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/50';
const labelClass = 'text-[10px] font-black text-slate-400 uppercase tracking-wider';
const pct = (n: number) => `${Math.round(n * 100)}%`;

const Schedules: React.FC<Props> = ({ accounts, canOperate, onChanged }) => {
  const [schedules, setSchedules] = useState<ScaleSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const { schedules } = await api.listSchedules();
      setSchedules(schedules);
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

  const remove = async (s: ScaleSchedule) => {
    const off = s.targets.some((t) => t.state === 'off');
    if (!window.confirm(`Delete "${s.name}"?${off ? ' ASGs that are off right now will be switched back on.' : ''}`)) return;
    try {
      await api.deleteSchedule(s.scheduleId);
      await load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xl font-black text-slate-900 tracking-tight">Schedules</h3>
          <p className="text-sm text-slate-500">Switch non-production ASGs off outside working hours. They come back with the same capacity.</p>
        </div>
        {canOperate && !showForm && (
          <button onClick={() => setShowForm(true)} className="px-5 py-3 bg-orange-600 text-white rounded-2xl text-xs font-black uppercase hover:bg-orange-700">
            New schedule
          </button>
        )}
      </div>

      {error && <p className="p-4 rounded-2xl bg-red-50 border border-red-100 text-sm text-red-700">{error}</p>}

      {showForm && (
        <ScheduleForm
          accounts={accounts}
          onCancel={() => setShowForm(false)}
          onCreated={async () => {
            setShowForm(false);
            await load();
          }}
        />
      )}

      {loading ? (
        <p className="text-sm text-slate-400">Loading schedules…</p>
      ) : schedules.length === 0 && !showForm ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center space-y-2">
          <p className="text-4xl">🌙</p>
          <h4 className="text-lg font-black text-slate-900">No schedules yet</h4>
          <p className="text-sm text-slate-500">Dev and staging only used 9 to 8 on weekdays? That's about 65% of the week they could be off.</p>
        </div>
      ) : (
        schedules.map((s) => (
          <div key={s.scheduleId} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="text-lg font-black text-slate-900">{s.name}</h4>
                <p className="text-xs text-slate-500 mt-1">
                  On {s.onAt}–{s.offAt} · {s.days.join(', ')} · {s.timezone}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-2xl font-black text-green-600">{pct(offShareOfWeek(s.days, s.onAt, s.offAt))}</p>
                  <p className="text-[10px] font-black text-slate-400 uppercase">of the week off</p>
                </div>
                {canOperate && (
                  <button onClick={() => remove(s)} className="px-4 py-2 rounded-xl text-[11px] font-black uppercase border-2 border-slate-200 text-slate-600 hover:border-red-200 hover:text-red-600">
                    Delete
                  </button>
                )}
              </div>
            </div>
            <div className="grid gap-2">
              {s.targets.map((t) => (
                <div key={`${t.asg.accountId}-${t.asg.asgName}`} className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100 text-xs">
                  <span className="font-bold text-slate-800">{refLabel(t.asg)}</span>
                  <span className="text-[10px] font-bold text-slate-400 uppercase">{t.asg.region}</span>
                  {t.state === 'off' && t.baseline && (
                    <span className="text-slate-500">comes back as {t.baseline.min}/{t.baseline.desired}/{t.baseline.max}</span>
                  )}
                  {t.message && <span className="text-red-700">{t.message}</span>}
                  <span
                    className={`ml-auto px-2 py-0.5 rounded text-[10px] font-black uppercase ${
                      t.state === 'off' ? 'bg-slate-800 text-white' : t.state === 'error' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
                    }`}
                  >
                    {t.state}
                  </span>
                </div>
              ))}
            </div>
            {s.timeline.length > 0 && (
              <p className="text-xs text-slate-400">
                Last: {new Date(s.timeline[s.timeline.length - 1].at).toLocaleString()} · {s.timeline[s.timeline.length - 1].message}
              </p>
            )}
          </div>
        ))
      )}
    </div>
  );
};

const ScheduleForm: React.FC<{ accounts: AWSAccount[]; onCancel: () => void; onCreated: () => Promise<void> }> = ({
  accounts,
  onCancel,
  onCreated,
}) => {
  const [name, setName] = useState('');
  const [days, setDays] = useState<Weekday[]>(['MON', 'TUE', 'WED', 'THU', 'FRI']);
  const [onAt, setOnAt] = useState('09:00');
  const [offAt, setOffAt] = useState('20:00');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const asgs: ASG[] = accounts.filter((a) => a.accessLevel === 'Operate').flatMap((a) => [...a.asgs, ...a.services]);
  const share = offAt > onAt && days.length > 0 ? offShareOfWeek(days, onAt, offAt) : 0;

  const toggleDay = (d: Weekday) => setDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d]));
  const togglePick = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    if (!name.trim()) return setError('Give the schedule a name.');
    if (picked.size === 0) return setError('Pick at least one ASG.');
    if (offAt <= onAt) return setError('The off time must be later than the on time.');
    setSaving(true);
    setError(null);
    try {
      await api.createSchedule({
        name: name.trim(),
        timezone,
        days,
        onAt,
        offAt,
        asgs: asgs.filter((g) => picked.has(g.id)).map((g) => refOf(g)),
      });
      await onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bg-white rounded-3xl border border-orange-200 p-8 space-y-6">
      <div className="grid sm:grid-cols-4 gap-4">
        <label className="space-y-1 sm:col-span-4">
          <span className={labelClass}>Schedule name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Staging office hours" className={inputClass} />
        </label>
        <label className="space-y-1">
          <span className={labelClass}>On at</span>
          <input type="time" value={onAt} onChange={(e) => setOnAt(e.target.value)} className={inputClass} />
        </label>
        <label className="space-y-1">
          <span className={labelClass}>Off at</span>
          <input type="time" value={offAt} onChange={(e) => setOffAt(e.target.value)} className={inputClass} />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className={labelClass}>Timezone</span>
          <input value={timezone} onChange={(e) => setTimezone(e.target.value)} className={inputClass} />
        </label>
      </div>

      <div className="space-y-2">
        <span className={labelClass}>Running days (off all day on the others)</span>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => toggleDay(d)}
              className={`px-3 py-2 rounded-lg text-[11px] font-black border ${
                days.includes(d) ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <span className={labelClass}>Auto Scaling groups</span>
        {asgs.length === 0 && <p className="text-sm text-slate-500">No ASGs in accounts connected with Operate access.</p>}
        {asgs.map((g) => (
          <label key={g.id} className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer ${picked.has(g.id) ? 'border-orange-200 bg-orange-50/40' : 'border-slate-100 bg-slate-50'}`}>
            <input type="checkbox" checked={picked.has(g.id)} onChange={() => togglePick(g.id)} className="accent-orange-600" />
            <span className="text-sm font-bold text-slate-800">{labelOf(g)}{g.kind === 'ecs' && <span className="ml-2 px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 text-[9px] font-black uppercase">ECS</span>}</span>
            <span className="text-[10px] font-bold text-slate-400 uppercase">{g.region}</span>
            <span className="ml-auto text-xs text-slate-500">now {g.capacity.min}/{g.capacity.desired}/{g.capacity.max}</span>
          </label>
        ))}
      </div>

      <div className="p-4 rounded-2xl bg-green-50 border border-green-100">
        <p className="text-sm font-black text-green-800">These ASGs will be off {pct(share)} of the week.</p>
        <p className="text-xs text-green-700">That's roughly {pct(share)} fewer instance-hours for them. The first switch-off happens at the next {offAt}.</p>
      </div>

      {error && <p className="text-sm font-medium text-red-700 bg-red-50 border border-red-100 rounded-xl p-3">{error}</p>}

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-4 py-3 rounded-2xl text-xs font-black uppercase text-slate-500 hover:bg-slate-100">
          Cancel
        </button>
        <button onClick={save} disabled={saving} className="px-6 py-3 rounded-2xl text-xs font-black uppercase text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-60">
          {saving ? 'Saving…' : 'Create schedule'}
        </button>
      </div>
    </section>
  );
};

export default Schedules;
