/*
 * Settings → Security — IP & Time-Based Access Control admin UI.
 *
 * This page only manages policies (create/edit/delete/list) through
 * backend/routes/security.js. It has no enforcement logic of its own — that
 * lives entirely in backend/services/accessControl.js and runs on every
 * login and every authenticated request regardless of whether this page is
 * ever opened. This page is a control panel for data those checks read.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ShieldCheck, Plus, Pencil, Trash2, X, Globe, Users as UsersIcon, User, Layers,
  AlertTriangle, MapPin, Lock, Wifi, Clock, CheckCircle2, XCircle, UserCheck, ChevronDown,
  Search, ChevronRight,
} from 'lucide-react';
import { api } from '../api';
import { PageHeader, EmptyState, friendlyError } from '../components/ui';
import { usePermissions } from '../context/usePermissions';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const APPLIES_TO_ICON = { all: Globe, role: Layers, team: UsersIcon, user: User };
const APPLIES_TO_LABEL = { all: 'All Users', role: 'Role', team: 'Team', user: 'Specific User' };

function appliesToText(p) {
  if (p.applies_to === 'all') return 'All Users';
  if (p.applies_to === 'role') return `Role: ${p.role_name || '—'}`;
  if (p.applies_to === 'team') return `Team: ${p.team_name || '—'}`;
  return `User: ${p.user_name || p.user_username || '—'}`;
}

function restrictionSummary(p) {
  const parts = [];
  if (p.ip_restriction_enabled) parts.push(`${p.allowed_ip_count ?? 0} IP${(p.allowed_ip_count ?? 0) === 1 ? '' : 's'}`);
  if (p.date_restriction_type === 'range') parts.push('date range');
  if (p.time_restriction_type === 'custom') parts.push(`${p.allowed_day_count ?? 0} day${(p.allowed_day_count ?? 0) === 1 ? '' : 's'}/wk`);
  return parts.length ? parts.join(' · ') : 'No restrictions (informational only)';
}

function fmtWhen(iso) {
  if (!iso) return '—';
  // SQLite's datetime('now') is UTC without a 'Z' suffix — append it so the
  // browser's Date parser treats it as UTC rather than (incorrectly) local.
  const d = new Date(iso.includes('T') || iso.endsWith('Z') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function daysUntil(dateStr) {
  const ms = new Date(`${dateStr}T00:00:00Z`) - new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

const REASON_LABEL = {
  no_policy: 'No policy applied', allowed: 'Allowed', ip_denied: 'IP not allowed',
  date_denied: 'Outside date range', time_denied: 'Outside allowed hours',
};

function KpiCard({ icon: Icon, label, value, tone = 'brand' }) {
  const colors = {
    brand: ['var(--color-brand-soft)', 'var(--color-brand)'],
    danger: ['var(--color-danger-soft)', 'var(--color-danger)'],
    success: ['var(--color-success-soft)', 'var(--color-success)'],
    warning: ['var(--color-warning-soft)', 'var(--color-warning-strong)'],
  }[tone];
  return (
    <div className="bg-white border border-line rounded-xl p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: colors[0], color: colors[1] }}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0">
        <div className="text-xl font-bold text-ink leading-tight">{value}</div>
        <div className="text-xs text-[var(--color-muted)] truncate">{label}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A type-to-filter combobox — spec section 23: "use searchable selectors
// instead of giant dropdowns." Filters the already-loaded list client-side;
// roles/teams/users are all small enough lists in this app that a server
// round-trip per keystroke would be overkill.
// ---------------------------------------------------------------------------
function SearchableSelect({ value, onChange, options, placeholder, getLabel = (o) => o.name, getValue = (o) => o.id }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const selected = options.find((o) => String(getValue(o)) === String(value));
  const filtered = query
    ? options.filter((o) => getLabel(o).toLowerCase().includes(query.toLowerCase()))
    : options;

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((s) => !s)}
        className="w-full border border-line rounded-lg px-3 py-2 text-sm text-left flex items-center justify-between bg-white">
        <span className={selected ? 'text-ink' : ''} style={!selected ? { color: 'var(--color-faint)' } : undefined}>
          {selected ? getLabel(selected) : placeholder}
        </span>
        <ChevronDown className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-muted)' }} />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-line rounded-lg shadow-lg overflow-hidden">
          <div className="p-2 border-b border-line">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-muted)' }} />
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…"
                className="w-full border border-line rounded-md pl-7 pr-2 py-1.5 text-xs" />
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 && <p className="text-xs px-3 py-2" style={{ color: 'var(--color-muted)' }}>No matches.</p>}
            {filtered.map((o) => (
              <button key={getValue(o)} type="button"
                onClick={() => { onChange(getValue(o)); setOpen(false); setQuery(''); }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-canvas">
                {getLabel(o)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// A plain-language preview of what a policy will actually do, before it's
// saved (spec section 28: "Review Effective Access" as an explicit step).
function reviewSummary({ appliesTo, roleId, teamId, userId, roles, teams, users, ipEnabled, ips, dateType, dateStart, dateEnd, timeType, dayWindows, timezone }) {
  const target = appliesTo === 'all' ? 'All users'
    : appliesTo === 'role' ? `Everyone in the "${roles.find((r) => String(r.id) === String(roleId))?.name || '—'}" role`
    : appliesTo === 'team' ? `Everyone on the "${teams.find((t) => String(t.id) === String(teamId))?.name || '—'}" team`
    : (users.find((u) => String(u.id) === String(userId))?.full_name || 'This user');

  const enabledIpCount = ips.filter((i) => i.enabled).length;
  const ipPart = !ipEnabled ? 'from any IP address'
    : enabledIpCount === 0 ? 'from NO approved IP — this will block everyone it applies to'
      : `only from ${enabledIpCount} approved IP address${enabledIpCount === 1 ? '' : 'es'}`;

  const datePart = dateType === 'range' ? `between ${dateStart || '—'} and ${dateEnd || 'no end date'}` : 'with no date limit';

  const activeDays = Object.values(dayWindows).filter((w) => w.length > 0).length;
  const timePart = timeType !== 'custom' ? 'at any time'
    : activeDays === 0 ? 'on NO allowed day — this will block everyone it applies to'
      : `only on ${activeDays} day${activeDays === 1 ? '' : 's'} per week, during their configured hours (${timezone})`;

  return `${target} will be able to sign in ${ipPart}, ${datePart}, ${timePart}.`;
}

// ---------------------------------------------------------------------------
// Policy Builder — the create/edit form (spec section 12)
// ---------------------------------------------------------------------------
function PolicyBuilder({ policyId, roles, teams, users, myIp, onClose, onSaved }) {
  const [loading, setLoading] = useState(!!policyId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState([]);

  const [name, setName] = useState('');
  const [appliesTo, setAppliesTo] = useState('all');
  const [roleId, setRoleId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [userId, setUserId] = useState('');
  const [status, setStatus] = useState('active');

  const [ipEnabled, setIpEnabled] = useState(false);
  const [ips, setIps] = useState([]);
  const [ipDraft, setIpDraft] = useState('');
  const [ipDescDraft, setIpDescDraft] = useState('');

  const [dateType, setDateType] = useState('permanent');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');

  const [timeType, setTimeType] = useState('always');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  // { 0: [{start,end}, ...], 1: [...] } — an ARRAY per day, so a day can have
  // more than one window (e.g. a lunch-hour split shift, 09:00-13:00 and
  // 14:00-18:00). An empty or missing array means that day isn't allowed.
  const [dayWindows, setDayWindows] = useState({});

  useEffect(() => {
    if (!policyId) return;
    api.securityPolicy(policyId).then((p) => {
      setName(p.name);
      setAppliesTo(p.applies_to);
      setRoleId(p.role_id || '');
      setTeamId(p.team_id || '');
      setUserId(p.user_id || '');
      setStatus(p.status);
      setIpEnabled(!!p.ip_restriction_enabled);
      setIps(p.ips.map((i) => ({ ip_or_cidr: i.ip_or_cidr, description: i.description || '', enabled: !!i.enabled })));
      setDateType(p.date_restriction_type);
      setDateStart(p.date_start || '');
      setDateEnd(p.date_end || '');
      setTimeType(p.time_restriction_type);
      setTimezone(p.timezone);
      const dw = {};
      for (const w of p.windows) {
        if (!dw[w.day_of_week]) dw[w.day_of_week] = [];
        dw[w.day_of_week].push({ start: w.start_time, end: w.end_time });
      }
      setDayWindows(dw);
    }).catch((e) => setError(friendlyError(e, 'Could not load this policy.'))).finally(() => setLoading(false));
  }, [policyId]);

  const addIp = () => {
    const value = ipDraft.trim();
    if (!value) return;
    setIps((list) => [...list, { ip_or_cidr: value, description: ipDescDraft.trim(), enabled: true }]);
    setIpDraft(''); setIpDescDraft('');
  };
  const removeIp = (i) => setIps((list) => list.filter((_, idx) => idx !== i));
  const toggleIp = (i) => setIps((list) => list.map((row, idx) => (idx === i ? { ...row, enabled: !row.enabled } : row)));

  const toggleDay = (day) => {
    setDayWindows((dw) => {
      const next = { ...dw };
      if (next[day]?.length) delete next[day];
      else next[day] = [{ start: '09:00', end: '18:00' }];
      return next;
    });
  };
  const addWindow = (day) => {
    setDayWindows((dw) => ({ ...dw, [day]: [...(dw[day] || []), { start: '09:00', end: '18:00' }] }));
  };
  const removeWindow = (day, idx) => {
    setDayWindows((dw) => {
      const next = { ...dw, [day]: dw[day].filter((_, i) => i !== idx) };
      if (next[day].length === 0) delete next[day];
      return next;
    });
  };
  const setWindowField = (day, idx, field, value) => {
    setDayWindows((dw) => ({ ...dw, [day]: dw[day].map((w, i) => (i === idx ? { ...w, [field]: value } : w)) }));
  };

  const wouldLockOutMe = ipEnabled && ips.some((i) => i.enabled) && myIp
    && !ips.some((i) => i.enabled && i.ip_or_cidr === myIp);

  const save = async () => {
    setSaving(true);
    setError('');
    const body = {
      name, applies_to: appliesTo,
      role_id: appliesTo === 'role' ? Number(roleId) : null,
      team_id: appliesTo === 'team' ? Number(teamId) : null,
      user_id: appliesTo === 'user' ? Number(userId) : null,
      status,
      ip_restriction_enabled: ipEnabled,
      ips,
      date_restriction_type: dateType,
      date_start: dateType === 'range' ? dateStart : null,
      date_end: dateType === 'range' ? dateEnd : null,
      time_restriction_type: timeType,
      timezone,
      windows: timeType === 'custom'
        ? Object.entries(dayWindows).flatMap(([day, windows]) => windows.map((w) => ({ day_of_week: Number(day), start_time: w.start, end_time: w.end })))
        : [],
    };
    try {
      const saveFn = policyId ? api.updateSecurityPolicy(policyId, body) : api.createSecurityPolicy(body);
      const result = await saveFn;
      if (result.warnings?.length) setWarnings(result.warnings);
      onSaved();
    } catch (e) {
      setError(friendlyError(e, 'Could not save this policy.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <div className="relative bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-ink">{policyId ? 'Edit Policy' : 'New Access Policy'}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-canvas">
            <X className="w-4 h-4" style={{ color: 'var(--color-muted)' }} />
          </button>
        </div>

        {loading ? <p className="text-sm text-center py-10" style={{ color: 'var(--color-muted)' }}>Loading…</p> : (
          <div className="space-y-4">
            {error && (
              <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>
            )}

            <div className="text-xs px-3 py-2 rounded-lg flex items-center gap-1.5" style={{ background: 'var(--color-brand-faint)', color: 'var(--color-muted)' }}>
              <MapPin className="w-3.5 h-3.5 shrink-0" /> Your current connection IP is <strong className="text-ink">{myIp || 'unknown'}</strong>
            </div>

            <label className="block">
              <span className="block text-xs font-medium text-ink mb-1">Policy Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Head Office Hours"
                className="w-full border border-line rounded-lg px-3 py-2 text-sm" />
            </label>

            <div>
              <span className="block text-xs font-medium text-ink mb-1">Applies To</span>
              <div className="grid grid-cols-4 gap-1.5">
                {['all', 'role', 'team', 'user'].map((key) => {
                  const Icon = APPLIES_TO_ICON[key];
                  return (
                    <button key={key} type="button" onClick={() => setAppliesTo(key)}
                      className={`flex flex-col items-center gap-1 py-2.5 rounded-lg border text-[11px] font-medium ${
                        appliesTo === key ? 'border-transparent text-white' : 'border-line hover:bg-canvas'}`}
                      style={appliesTo === key ? { background: 'var(--color-brand)' } : { color: 'var(--color-muted)' }}>
                      <Icon className="w-4 h-4" /> {APPLIES_TO_LABEL[key]}
                    </button>
                  );
                })}
              </div>
              {appliesTo === 'role' && (
                <div className="mt-2">
                  <SearchableSelect value={roleId} onChange={setRoleId} options={roles} placeholder="Select a role…" />
                </div>
              )}
              {appliesTo === 'team' && (
                <div className="mt-2">
                  <SearchableSelect value={teamId} onChange={setTeamId} options={teams} placeholder="Select a team…" />
                </div>
              )}
              {appliesTo === 'user' && (
                <div className="mt-2">
                  <SearchableSelect value={userId} onChange={setUserId} options={users} placeholder="Select a user…"
                    getLabel={(u) => u.full_name || u.username} />
                </div>
              )}
            </div>

            {/* IP restriction */}
            <div className="border border-line rounded-xl p-3">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm font-medium text-ink">IP Restriction</span>
                <input type="checkbox" checked={ipEnabled} onChange={(e) => setIpEnabled(e.target.checked)} className="w-4 h-4" />
              </label>
              {ipEnabled && (
                <div className="mt-2.5 space-y-2">
                  {ips.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input type="checkbox" checked={row.enabled} onChange={() => toggleIp(i)} className="w-3.5 h-3.5 shrink-0" />
                      <span className="text-xs font-mono text-ink flex-1 truncate">{row.ip_or_cidr}</span>
                      {row.description && <span className="text-[11px] truncate" style={{ color: 'var(--color-muted)' }}>{row.description}</span>}
                      <button type="button" onClick={() => removeIp(i)}><X className="w-3.5 h-3.5" style={{ color: 'var(--color-muted)' }} /></button>
                    </div>
                  ))}
                  <div className="flex gap-1.5">
                    <input value={ipDraft} onChange={(e) => setIpDraft(e.target.value)} placeholder="103.25.10.0/24 or 103.25.10.5"
                      className="flex-1 border border-line rounded-lg px-2.5 py-1.5 text-xs font-mono" />
                    <input value={ipDescDraft} onChange={(e) => setIpDescDraft(e.target.value)} placeholder="Label (optional)"
                      className="w-28 border border-line rounded-lg px-2.5 py-1.5 text-xs" />
                    <button type="button" onClick={addIp} className="px-2.5 rounded-lg border border-line text-xs font-medium hover:bg-canvas">Add</button>
                  </div>
                  {wouldLockOutMe && (
                    <p className="text-[11px] flex items-center gap-1" style={{ color: 'var(--color-warning-strong)' }}>
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      Your current IP ({myIp}) is not on this list — saving this could lock out anyone connecting from where you are right now.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Date restriction */}
            <div className="border border-line rounded-xl p-3">
              <span className="block text-sm font-medium text-ink mb-2">Date Restriction</span>
              <div className="flex gap-1.5 mb-2">
                {['permanent', 'range'].map((k) => (
                  <button key={k} type="button" onClick={() => setDateType(k)}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-medium border ${dateType === k ? 'border-transparent text-white' : 'border-line'}`}
                    style={dateType === k ? { background: 'var(--color-brand)' } : { color: 'var(--color-muted)' }}>
                    {k === 'permanent' ? 'Permanent' : 'Date Range'}
                  </button>
                ))}
              </div>
              {dateType === 'range' && (
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="block text-[11px] mb-1" style={{ color: 'var(--color-muted)' }}>Start</span>
                    <input type="date" value={dateStart} onChange={(e) => setDateStart(e.target.value)}
                      className="w-full border border-line rounded-lg px-2 py-1.5 text-xs" />
                  </label>
                  <label className="block">
                    <span className="block text-[11px] mb-1" style={{ color: 'var(--color-muted)' }}>End (optional)</span>
                    <input type="date" value={dateEnd} onChange={(e) => setDateEnd(e.target.value)}
                      className="w-full border border-line rounded-lg px-2 py-1.5 text-xs" />
                  </label>
                </div>
              )}
            </div>

            {/* Time restriction — multiple windows per day */}
            <div className="border border-line rounded-xl p-3">
              <span className="block text-sm font-medium text-ink mb-2">Time Restriction</span>
              <div className="flex gap-1.5 mb-2">
                {['always', 'custom'].map((k) => (
                  <button key={k} type="button" onClick={() => setTimeType(k)}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-medium border ${timeType === k ? 'border-transparent text-white' : 'border-line'}`}
                    style={timeType === k ? { background: 'var(--color-brand)' } : { color: 'var(--color-muted)' }}>
                    {k === 'always' ? 'Always Allowed' : 'Custom Schedule'}
                  </button>
                ))}
              </div>
              {timeType === 'custom' && (
                <div className="space-y-2.5">
                  <label className="block">
                    <span className="block text-[11px] mb-1" style={{ color: 'var(--color-muted)' }}>Timezone</span>
                    <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="e.g. Asia/Kolkata"
                      className="w-full border border-line rounded-lg px-2.5 py-1.5 text-xs font-mono" />
                  </label>
                  {DAYS.map((label, day) => (
                    <div key={day}>
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1.5 w-16 shrink-0">
                          <input type="checkbox" checked={!!dayWindows[day]?.length} onChange={() => toggleDay(day)} className="w-3.5 h-3.5" />
                          <span className="text-xs font-medium text-ink">{label}</span>
                        </label>
                        {dayWindows[day]?.length > 0 && (
                          <button type="button" onClick={() => addWindow(day)} className="text-[11px] font-medium" style={{ color: 'var(--color-brand)' }}>
                            + Add another window
                          </button>
                        )}
                      </div>
                      {(dayWindows[day] || []).map((w, idx) => (
                        <div key={idx} className="flex items-center gap-2 mt-1.5 ml-[72px]">
                          <input type="time" value={w.start} onChange={(e) => setWindowField(day, idx, 'start', e.target.value)}
                            className="border border-line rounded-lg px-2 py-1 text-xs" />
                          <span className="text-xs" style={{ color: 'var(--color-muted)' }}>to</span>
                          <input type="time" value={w.end} onChange={(e) => setWindowField(day, idx, 'end', e.target.value)}
                            className="border border-line rounded-lg px-2 py-1 text-xs" />
                          {dayWindows[day].length > 1 && (
                            <button type="button" onClick={() => removeWindow(day, idx)}><X className="w-3.5 h-3.5" style={{ color: 'var(--color-muted)' }} /></button>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <label className="flex items-center justify-between border border-line rounded-xl p-3 cursor-pointer">
              <span className="text-sm font-medium text-ink">Policy Active</span>
              <input type="checkbox" checked={status === 'active'} onChange={(e) => setStatus(e.target.checked ? 'active' : 'inactive')} className="w-4 h-4" />
            </label>

            {/* Review Effective Access — a plain-language preview before saving */}
            <div className="rounded-xl p-3 text-xs" style={{ background: 'var(--color-brand-faint)', color: 'var(--color-ink)' }}>
              <span className="block font-semibold mb-1">Review Effective Access</span>
              {reviewSummary({ appliesTo, roleId, teamId, userId, roles, teams, users, ipEnabled, ips, dateType, dateStart, dateEnd, timeType, dayWindows, timezone })}
            </div>

            {warnings.length > 0 && (
              <div className="text-xs px-3 py-2 rounded-lg space-y-1" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }}>
                {warnings.map((w, i) => <p key={i} className="flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{w}</p>)}
              </div>
            )}

            <button onClick={save} disabled={saving || !name.trim()} className="btn-primary w-full h-11 rounded-lg text-sm font-semibold disabled:opacity-60">
              {saving ? 'Saving…' : 'Save Policy'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// User Access Detail (spec sections 13/27) — clicking a row in the Access
// Matrix opens this, rather than the Matrix trying to show everything inline.
// ---------------------------------------------------------------------------
function UserAccessDetail({ userId, onClose, onEditPolicy }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.securityUserDetail(userId).then(setData).catch((e) => setError(friendlyError(e, 'Could not load this user.')));
  }, [userId]);

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <div className="relative bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-ink">{data ? (data.user.full_name || data.user.username) : 'Loading…'}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-canvas">
            <X className="w-4 h-4" style={{ color: 'var(--color-muted)' }} />
          </button>
        </div>

        {error && <p className="text-sm" style={{ color: 'var(--color-danger)' }}>{error}</p>}
        {!data && !error && <p className="text-sm text-center py-10" style={{ color: 'var(--color-muted)' }}>Loading…</p>}

        {data && (
          <div className="space-y-4">
            <p className="text-xs" style={{ color: 'var(--color-muted)' }}>Role: {data.user.role_name || '—'}</p>

            {!data.effective_policy ? (
              <div className="text-sm rounded-xl p-3" style={{ background: 'var(--color-brand-faint)' }}>
                No policy applies to this user — they can sign in from anywhere, at any time.
              </div>
            ) : (
              <div className="border border-line rounded-xl p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-ink">{data.effective_policy.name}</span>
                  <button onClick={() => onEditPolicy(data.effective_policy.id)} className="text-xs font-medium" style={{ color: 'var(--color-brand)' }}>Edit →</button>
                </div>
                <p className="text-xs" style={{ color: 'var(--color-muted)' }}>{appliesToText(data.effective_policy)}</p>

                {data.effective_policy.ip_restriction_enabled && (
                  <div>
                    <span className="text-xs font-medium text-ink block mb-1">Allowed IPs</span>
                    <div className="flex flex-wrap gap-1">
                      {data.effective_policy.ips.filter((i) => i.enabled).map((i) => (
                        <span key={i.id} className="text-[11px] font-mono px-2 py-0.5 rounded-full" style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand-hover)' }}>
                          {i.ip_or_cidr}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {data.effective_policy.date_restriction_type === 'range' && (
                  <p className="text-xs" style={{ color: 'var(--color-muted)' }}>
                    Date range: {data.effective_policy.date_start} to {data.effective_policy.date_end || 'no end date'}
                  </p>
                )}

                {data.effective_policy.time_restriction_type === 'custom' && (
                  <div>
                    <span className="text-xs font-medium text-ink block mb-1">Allowed hours ({data.effective_policy.timezone})</span>
                    {DAYS.map((label, day) => {
                      const windows = data.effective_policy.windows.filter((w) => w.day_of_week === day);
                      if (!windows.length) return null;
                      return (
                        <p key={day} className="text-xs" style={{ color: 'var(--color-muted)' }}>
                          {label}: {windows.map((w) => `${w.start_time}-${w.end_time}`).join(', ')}
                        </p>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div>
              <span className="text-xs font-medium text-ink block mb-1.5">Recent Activity</span>
              {data.recent_activity.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--color-muted)' }}>No recorded activity yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {data.recent_activity.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      {r.allowed === 1 ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-success)' }} />
                        : r.allowed === 0 ? <XCircle className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-danger)' }} /> : null}
                      <span className="font-mono" style={{ color: 'var(--color-muted)' }}>{r.client_ip}</span>
                      <span style={{ color: 'var(--color-muted)' }}>{REASON_LABEL[r.reason] || r.reason}</span>
                      <span className="ml-auto shrink-0" style={{ color: 'var(--color-faint)' }}>{fmtWhen(r.created_at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------
export default function SettingsSecurity() {
  const can = usePermissions();
  const [tab, setTab] = useState('dashboard');
  const [policies, setPolicies] = useState([]);
  const [roles, setRoles] = useState([]);
  const [teams, setTeams] = useState([]);
  const [users, setUsers] = useState([]);
  const [myIp, setMyIp] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [builderId, setBuilderId] = useState(undefined); // undefined = closed, null = new, number = edit
  const [deleting, setDeleting] = useState(null);
  const [detailUserId, setDetailUserId] = useState(null);

  const [dashboard, setDashboard] = useState(null);

  const [policyFilters, setPolicyFilters] = useState({ q: '', status: '', applies_to: '', sort: 'newest' });

  const [matrixRows, setMatrixRows] = useState([]);
  const [matrixTotal, setMatrixTotal] = useState(0);
  const [matrixOffset, setMatrixOffset] = useState(0);
  const [matrixFilters, setMatrixFilters] = useState({ q: '', restricted: '' });

  const [auditRows, setAuditRows] = useState([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditFilters, setAuditFilters] = useState({ allowed: '', event_type: '' });
  const [auditLoading, setAuditLoading] = useState(false);

  const loadPolicies = () => {
    api.securityPolicies(policyFilters).then(setPolicies).catch((e) => setError(friendlyError(e, "Couldn't load policies.")));
  };

  const load = () => {
    setLoading(true);
    Promise.all([api.securityPolicies(policyFilters), api.listRoles(), api.listTeams(), api.listUsers(), api.securityMyIp()])
      .then(([p, r, t, u, ip]) => { setPolicies(p); setRoles(r); setTeams(t); setUsers(u); setMyIp(ip.ip); setError(''); })
      .catch((e) => setError(friendlyError(e, "Couldn't load security settings.")))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
  useEffect(() => { if (tab === 'policies') loadPolicies(); }, [policyFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMatrix = (offset = 0) => {
    api.securityMatrix({ ...matrixFilters, limit: 50, offset })
      .then((res) => { setMatrixRows(res.rows); setMatrixTotal(res.total); setMatrixOffset(offset); })
      .catch(() => setMatrixRows([]));
  };

  useEffect(() => {
    if (tab === 'matrix') loadMatrix(0);
    if (tab === 'dashboard') api.securityDashboard().then(setDashboard).catch(() => setDashboard(null));
  }, [tab, matrixFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadAuditLog = (offset = 0) => {
    setAuditLoading(true);
    const params = { limit: 50, offset };
    if (auditFilters.allowed) params.allowed = auditFilters.allowed;
    if (auditFilters.event_type) params.event_type = auditFilters.event_type;
    api.securityAuditLog(params)
      .then((res) => { setAuditRows((prev) => (offset === 0 ? res.rows : [...prev, ...res.rows])); setAuditTotal(res.total); })
      .catch(() => { if (offset === 0) setAuditRows([]); })
      .finally(() => setAuditLoading(false));
  };
  useEffect(() => { if (tab === 'audit') loadAuditLog(0); }, [tab, auditFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  const extendPolicy = async (policy, days) => {
    const full = await api.securityPolicy(policy.id);
    const newEnd = new Date(`${full.date_end}T00:00:00Z`);
    newEnd.setUTCDate(newEnd.getUTCDate() + days);
    await api.updateSecurityPolicy(policy.id, { ...full, date_end: newEnd.toISOString().slice(0, 10) });
    api.securityDashboard().then(setDashboard);
    load();
  };
  const disablePolicy = async (policy) => {
    const full = await api.securityPolicy(policy.id);
    await api.updateSecurityPolicy(policy.id, { ...full, status: 'inactive' });
    api.securityDashboard().then(setDashboard);
    load();
  };

  const remove = async (id) => {
    try {
      await api.deleteSecurityPolicy(id);
      setDeleting(null);
      load();
    } catch (e) {
      setError(friendlyError(e, 'Could not delete this policy.'));
    }
  };

  if (!can('security', 'view')) {
    return <EmptyState icon={ShieldCheck} title="No access" description="You don't have permission to view security settings." />;
  }

  return (
    <div className="w-full">
      <PageHeader title="Security" subtitle="Restrict when and from where your team can sign in to iCRM." icon={ShieldCheck} accent="security">
        {tab === 'policies' && can('security', 'create') && (
          <button onClick={() => setBuilderId(null)} className="btn-primary flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg">
            <Plus className="w-4 h-4" /> New Policy
          </button>
        )}
      </PageHeader>

      <div className="flex gap-1 mt-4 mb-4 flex-wrap">
        {[['dashboard', 'Dashboard'], ['policies', 'Access Policies'], ['matrix', 'Access Matrix'], ['audit', 'Audit Log']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-3 h-9 rounded-lg text-sm font-medium ${tab === id ? 'text-white' : 'hover:bg-canvas'}`}
            style={tab === id ? { background: 'var(--color-brand)' } : { color: 'var(--color-muted)' }}>
            {label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm mb-3" style={{ color: 'var(--color-danger)' }}>{error}</p>}
      {loading ? <p className="text-sm text-center py-10" style={{ color: 'var(--color-muted)' }}>Loading…</p> : (
        <>
          {tab === 'dashboard' && (
            dashboard ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  <KpiCard icon={ShieldCheck} label="Active Policies" value={dashboard.active_policies} tone="brand" />
                  <KpiCard icon={Lock} label="IP-Restricted Policies" value={dashboard.ip_restricted_policies} tone={dashboard.ip_restricted_policies > 0 ? 'brand' : 'success'} />
                  <KpiCard icon={UserCheck} label="Protected Users" value={`${dashboard.protected_users} / ${dashboard.total_users}`} tone="brand" />
                  <KpiCard icon={Wifi} label="Allowed IPs" value={dashboard.allowed_ip_count} tone="success" />
                  <KpiCard icon={Lock} label="Blocked (24h)" value={dashboard.blocked_attempts_24h} tone={dashboard.blocked_attempts_24h > 0 ? 'danger' : 'success'} />
                </div>

                {dashboard.expiring_policies.length > 0 && (
                  <div className="bg-white border rounded-xl p-4" style={{ borderColor: 'var(--color-warning)' }}>
                    <div className="flex items-center gap-1.5 mb-3">
                      <Clock className="w-4 h-4" style={{ color: 'var(--color-warning-strong)' }} />
                      <span className="text-sm font-semibold text-ink">
                        {dashboard.expiring_policies.length} access polic{dashboard.expiring_policies.length === 1 ? 'y' : 'ies'} expire{dashboard.expiring_policies.length === 1 ? 's' : ''} within 7 days
                      </span>
                    </div>
                    <div className="space-y-2">
                      {dashboard.expiring_policies.map((p) => (
                        <div key={p.id} className="flex items-center gap-3 text-sm">
                          <span className="flex-1 min-w-0 truncate text-ink">{p.name}</span>
                          <span className="text-xs shrink-0" style={{ color: 'var(--color-muted)' }}>
                            {daysUntil(p.date_end) === 0 ? 'expires today' : `${daysUntil(p.date_end)}d left`}
                          </span>
                          <button onClick={() => extendPolicy(p, 30)} className="text-xs font-medium px-2 py-1 rounded-lg border border-line hover:bg-canvas shrink-0">+30 days</button>
                          <button onClick={() => setBuilderId(p.id)} className="text-xs font-medium px-2 py-1 rounded-lg border border-line hover:bg-canvas shrink-0">Edit</button>
                          <button onClick={() => disablePolicy(p)} className="text-xs font-medium px-2 py-1 rounded-lg border border-line hover:bg-canvas shrink-0">Disable</button>
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] mt-2" style={{ color: 'var(--color-muted)' }}>A policy is never auto-extended — it will simply stop applying on its end date unless you act.</p>
                  </div>
                )}

                <div className="bg-white border border-line rounded-xl p-4">
                  <span className="text-sm font-semibold text-ink block mb-3">Recent Successful Access</span>
                  {dashboard.recent_successful_access.length === 0 ? (
                    <p className="text-xs" style={{ color: 'var(--color-muted)' }}>No sign-ins recorded yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {dashboard.recent_successful_access.map((r, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-success)' }} />
                          <span className="text-ink font-medium">{r.full_name || r.username}</span>
                          <span className="font-mono" style={{ color: 'var(--color-muted)' }}>{r.client_ip}</span>
                          <span className="ml-auto shrink-0" style={{ color: 'var(--color-faint)' }}>{fmtWhen(r.created_at)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : <p className="text-sm text-center py-10" style={{ color: 'var(--color-muted)' }}>Loading…</p>
          )}

          {tab === 'policies' && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <div className="relative flex-1 min-w-[160px]">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-muted)' }} />
                  <input value={policyFilters.q} onChange={(e) => setPolicyFilters((f) => ({ ...f, q: e.target.value }))}
                    placeholder="Search policies…" className="w-full border border-line rounded-lg pl-8 pr-3 py-1.5 text-xs" />
                </div>
                <select value={policyFilters.status} onChange={(e) => setPolicyFilters((f) => ({ ...f, status: e.target.value }))}
                  className="border border-line rounded-lg px-2.5 py-1.5 text-xs">
                  <option value="">All statuses</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
                <select value={policyFilters.applies_to} onChange={(e) => setPolicyFilters((f) => ({ ...f, applies_to: e.target.value }))}
                  className="border border-line rounded-lg px-2.5 py-1.5 text-xs">
                  <option value="">All types</option>
                  <option value="all">All Users</option>
                  <option value="role">Role</option>
                  <option value="team">Team</option>
                  <option value="user">Specific User</option>
                </select>
                <select value={policyFilters.sort} onChange={(e) => setPolicyFilters((f) => ({ ...f, sort: e.target.value }))}
                  className="border border-line rounded-lg px-2.5 py-1.5 text-xs">
                  <option value="newest">Newest first</option>
                  <option value="name">Name (A-Z)</option>
                  <option value="status">Status</option>
                </select>
              </div>

              {policies.length === 0 ? (
                <EmptyState icon={ShieldCheck} title="No access policies found"
                  description={policyFilters.q || policyFilters.status || policyFilters.applies_to
                    ? 'No policy matches these filters.'
                    : 'Without a policy, everyone can sign in from anywhere, at any time. Create one to restrict access by IP, date, or time.'} />
              ) : (
                <div className="bg-white border border-line rounded-xl overflow-hidden">
                  {policies.map((p) => (
                    <div key={p.id} className="flex items-center gap-3 px-4 py-3 border-b border-line last:border-0">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.status === 'active' ? 'var(--color-success)' : 'var(--color-faint)' }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-ink truncate">{p.name}</div>
                        <div className="text-xs truncate" style={{ color: 'var(--color-muted)' }}>{appliesToText(p)} · {restrictionSummary(p)}</div>
                      </div>
                      {can('security', 'edit') && (
                        <button onClick={() => setBuilderId(p.id)} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-canvas">
                          <Pencil className="w-3.5 h-3.5" style={{ color: 'var(--color-muted)' }} />
                        </button>
                      )}
                      {can('security', 'delete') && (
                        <button onClick={() => setDeleting(p)} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-canvas">
                          <Trash2 className="w-3.5 h-3.5" style={{ color: 'var(--color-danger)' }} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'matrix' && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <div className="relative flex-1 min-w-[160px]">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-muted)' }} />
                  <input value={matrixFilters.q} onChange={(e) => setMatrixFilters((f) => ({ ...f, q: e.target.value }))}
                    placeholder="Search users…" className="w-full border border-line rounded-lg pl-8 pr-3 py-1.5 text-xs" />
                </div>
                <select value={matrixFilters.restricted} onChange={(e) => setMatrixFilters((f) => ({ ...f, restricted: e.target.value }))}
                  className="border border-line rounded-lg px-2.5 py-1.5 text-xs">
                  <option value="">Everyone</option>
                  <option value="true">Has a policy</option>
                  <option value="false">Unrestricted</option>
                </select>
              </div>

              <div className="bg-white border border-line rounded-xl overflow-hidden overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs" style={{ color: 'var(--color-muted)' }}>
                      <th className="px-4 py-2.5 font-medium">User</th>
                      <th className="px-4 py-2.5 font-medium">Role</th>
                      <th className="px-4 py-2.5 font-medium">Effective Policy</th>
                      <th className="px-4 py-2.5 font-medium">Restrictions</th>
                      <th className="px-4 py-2.5 font-medium w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {matrixRows.map((row) => (
                      <tr key={row.user_id} className="border-b border-line last:border-0 cursor-pointer hover:bg-canvas" onClick={() => setDetailUserId(row.user_id)}>
                        <td className="px-4 py-2.5 font-medium text-ink">{row.full_name || row.username}</td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--color-muted)' }}>{row.role_name || '—'}</td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--color-muted)' }}>{row.policy ? row.policy.name : 'None (unrestricted)'}</td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--color-muted)' }}>
                          {row.policy ? restrictionSummary({
                            ip_restriction_enabled: row.policy.ip_restriction_enabled,
                            allowed_ip_count: row.policy.ip_summary ? row.policy.ip_summary.split(',').filter(Boolean).length : 0,
                            date_restriction_type: row.policy.date_restriction_type,
                            time_restriction_type: row.policy.time_restriction_type,
                            allowed_day_count: row.policy.allowed_day_count,
                          }) : '—'}
                        </td>
                        <td className="px-4 py-2.5"><ChevronRight className="w-4 h-4" style={{ color: 'var(--color-faint)' }} /></td>
                      </tr>
                    ))}
                    {matrixRows.length === 0 && (
                      <tr><td colSpan={5} className="px-4 py-8 text-center text-sm" style={{ color: 'var(--color-muted)' }}>No matching users.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {matrixTotal > matrixRows.length + matrixOffset && (
                <button onClick={() => loadMatrix(matrixOffset + 50)}
                  className="w-full h-10 rounded-lg border border-line text-sm font-medium flex items-center justify-center gap-1.5 hover:bg-canvas">
                  <ChevronDown className="w-4 h-4" /> Load more ({matrixOffset + matrixRows.length} of {matrixTotal})
                </button>
              )}
            </div>
          )}

          {tab === 'audit' && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <select value={auditFilters.allowed} onChange={(e) => setAuditFilters((f) => ({ ...f, allowed: e.target.value }))}
                  className="border border-line rounded-lg px-2.5 py-1.5 text-xs">
                  <option value="">All results</option>
                  <option value="true">Allowed</option>
                  <option value="false">Denied</option>
                </select>
                <select value={auditFilters.event_type} onChange={(e) => setAuditFilters((f) => ({ ...f, event_type: e.target.value }))}
                  className="border border-line rounded-lg px-2.5 py-1.5 text-xs">
                  <option value="">All event types</option>
                  <option value="login_check">Login attempt</option>
                  <option value="request_check">Session check</option>
                  <option value="policy_created">Policy created</option>
                  <option value="policy_updated">Policy updated</option>
                  <option value="policy_deleted">Policy deleted</option>
                </select>
              </div>

              <div className="bg-white border border-line rounded-xl overflow-hidden overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs" style={{ color: 'var(--color-muted)' }}>
                      <th className="px-4 py-2.5 font-medium">When</th>
                      <th className="px-4 py-2.5 font-medium">User</th>
                      <th className="px-4 py-2.5 font-medium">IP</th>
                      <th className="px-4 py-2.5 font-medium">Device</th>
                      <th className="px-4 py-2.5 font-medium">Result</th>
                      <th className="px-4 py-2.5 font-medium">Reason</th>
                      <th className="px-4 py-2.5 font-medium">Policy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditRows.map((r) => (
                      <tr key={r.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: 'var(--color-muted)' }}>{fmtWhen(r.created_at)}</td>
                        <td className="px-4 py-2.5 text-ink font-medium">{r.user_name || r.user_username || (r.actor_name || '—')}</td>
                        <td className="px-4 py-2.5 font-mono text-xs" style={{ color: 'var(--color-muted)' }}>{r.client_ip || '—'}</td>
                        <td className="px-4 py-2.5 text-xs truncate max-w-[140px]" style={{ color: 'var(--color-faint)' }} title={r.user_agent || ''}>
                          {r.user_agent ? r.user_agent.split(') ')[0].replace('(', '') : '—'}
                        </td>
                        <td className="px-4 py-2.5">
                          {r.allowed === null ? (
                            <span className="text-xs" style={{ color: 'var(--color-muted)' }}>—</span>
                          ) : r.allowed ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--color-success)' }}>
                              <CheckCircle2 className="w-3.5 h-3.5" /> Allowed
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--color-danger)' }}>
                              <XCircle className="w-3.5 h-3.5" /> Denied
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--color-muted)' }}>{REASON_LABEL[r.reason] || r.reason || '—'}</td>
                        <td className="px-4 py-2.5 truncate max-w-[160px]" style={{ color: 'var(--color-muted)' }}>{r.policy_name || '—'}</td>
                      </tr>
                    ))}
                    {auditRows.length === 0 && !auditLoading && (
                      <tr><td colSpan={7} className="px-4 py-8 text-center text-sm" style={{ color: 'var(--color-muted)' }}>No matching events.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {auditRows.length < auditTotal && (
                <button onClick={() => loadAuditLog(auditRows.length)} disabled={auditLoading}
                  className="w-full h-10 rounded-lg border border-line text-sm font-medium flex items-center justify-center gap-1.5 hover:bg-canvas disabled:opacity-60">
                  <ChevronDown className="w-4 h-4" /> {auditLoading ? 'Loading…' : `Load more (${auditRows.length} of ${auditTotal})`}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {builderId !== undefined && (
        <PolicyBuilder policyId={builderId} roles={roles} teams={teams} users={users} myIp={myIp}
          onClose={() => setBuilderId(undefined)}
          onSaved={() => { setBuilderId(undefined); load(); if (tab === 'matrix') loadMatrix(matrixOffset); }} />
      )}

      {detailUserId && (
        <UserAccessDetail userId={detailUserId} onClose={() => setDetailUserId(null)}
          onEditPolicy={(id) => { setDetailUserId(null); setBuilderId(id); }} />
      )}

      {deleting && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-ink/30" onClick={() => setDeleting(null)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5">
            <h2 className="text-base font-semibold text-ink mb-1">Delete this policy?</h2>
            <p className="text-sm mb-4" style={{ color: 'var(--color-muted)' }}>
              "{deleting.name}" will stop applying immediately. This can't be undone.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setDeleting(null)} className="flex-1 h-10 rounded-lg border border-line text-sm font-medium">Cancel</button>
              <button onClick={() => remove(deleting.id)} className="flex-1 h-10 rounded-lg text-sm font-semibold text-white" style={{ background: 'var(--color-danger)' }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
