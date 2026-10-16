import { GeoInput } from '../components/geo/GeoField';
import AddressInput from '../components/geo/AddressInput';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  UserPlus, List, Columns3, Search, Mail, Phone, PhoneCall, Clock, Download, X,
  Users as UsersIcon, Sparkles, MoreVertical, Plus, Pencil, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
} from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { downloadCSV } from '../utils/csv';
import LeadEditModal from '../components/LeadEditModal';
import { useModuleOptions, allOptions, selectableOptions, labelFor, toOptionsJson } from '../components/fieldOptions';
import { localToIso, browserTimeZone } from '../components/followup/time';
import DrillBanner, { useDrill } from '../components/DrillBanner';
import AssignPicker from '../components/AssignPicker';
import { remember, recall } from '../screenMemory';
import StatusCards, { breakdownFromServer, BLANK } from '../components/StatusCards';
import { DuplicateHint, RepeatBadge } from '../components/DuplicateDialog';
import DialListModal from '../components/telephony/DialListModal';
import { useTelephony } from '../components/telephony/telephony';
import {
  FilterButton, FilterPanel, ActiveFilterChips, SavedFiltersMenu, isComplete, kindOf,
  useSelection, RowCheckbox, BulkBar, BulkUpdateModal, BulkAssignModal, BulkDeleteModal, runBulk,
} from '../components/ListTools';
import {
  PageHeader, KpiCard, Badge, Avatar, SkeletonRows, SkeletonCards, ErrorState, EmptyState, toneFor,
  friendlyError,
} from '../components/ui';

// Lead statuses, sources, qualifications, ratings and genders come from
// Settings → Dropdown Options (Leads module). These are only the fallback if
// that cannot be read — the application's original values, so nothing
// incompatible is ever written to the database.
const FALLBACK_STATUSES = ['New', 'Contacted', 'Interested', 'Follow-up', 'Converted', 'Dropped', 'Not Interested'];

// Lead columns described as fields, so the shared filter, bulk update and
// assignment tools work on Leads exactly as on every other module.
const optsOf = (list) => toOptionsJson(list);
function leadFields(statuses, sources, qualifications = [], extra = {}) {
  const f = (api_name, label, field_type, extra = {}) => ({ api_name, label, field_type, is_system: 1, show_in_edit: 1, ...extra });
  return [
    f('student_name', 'Lead name', 'text', { required: 1, show_in_edit: 0 }),
    f('account_name', 'Company', 'text'),
    f('status', 'Status', 'dropdown', { options_json: optsOf(statuses) }),
    f('source', 'Source', 'dropdown', { options_json: optsOf(sources) }),
    f('assigned_counselor', 'Owner', 'user_name'),
    f('lead_rating', 'Rating', 'dropdown', { options_json: optsOf(extra.ratings || ['Hot', 'Warm', 'Cold']) }),
    f('follow_up_date', 'Next follow-up', 'date'),
    f('created_at', 'Created', 'date', { show_in_edit: 0 }),
    f('city', 'City', 'text'),
    f('state', 'State', 'text'),
    f('country', 'Country', 'text'),
    f('email', 'Email', 'email', { show_in_edit: 0 }),
    f('mobile', 'Mobile', 'phone', { show_in_edit: 0 }),
    f('campaign', 'Campaign', 'text'),
    f('product_interest', 'Product interest', 'text'),
    f('service_interest', 'Service interest', 'text'),
    f('lead_score', 'Lead score', 'number', { show_in_edit: 0 }),
    f('qualification', 'Qualification', qualifications.length ? 'dropdown' : 'text', qualifications.length ? { options_json: optsOf(qualifications) } : {}),
    f('gender', 'Gender', 'dropdown', { options_json: optsOf(extra.genders || ['Male', 'Female', 'Other']) }),
    f('date_of_birth', 'Date of birth', 'date'),
    f('address', 'Address', 'text'),
    f('alternate_mobile', 'Alternate mobile', 'phone'),
    f('remarks', 'Remarks', 'textarea'),
    f('converted_at', 'Converted on', 'date', { show_in_edit: 0 }),
  ];
}
const leadValue = (row, field) => row[field.api_name];

// Each column gets a short description, matching the reference's
// approach of explaining what a stage means.
const STATUS_HINT = {
  New: 'Initial inquiry received',
  Contacted: 'First contact made',
  Interested: 'Showing interest',
  'Follow-up': 'Needs further discussion',
  Converted: 'Successfully converted',
  Dropped: 'No longer proceeding',
  'Not Interested': 'Declined',
};

const TONE_VARS = {
  info: ['var(--color-info-soft)', 'var(--color-info)'],
  success: ['var(--color-success-soft)', 'var(--color-success)'],
  warning: ['var(--color-warning-soft)', 'var(--color-warning)'],
  attention: ['var(--color-attention-soft)', 'var(--color-attention)'],
  danger: ['var(--color-danger-soft)', 'var(--color-danger)'],
  special: ['var(--color-special-soft)', 'var(--color-special)'],
  neutral: ['var(--color-neutral-soft)', 'var(--color-neutral)'],
};
const toneVars = (status) => TONE_VARS[toneFor(status)] || TONE_VARS.neutral;

const relative = (iso) => {
  if (!iso) return null;
  // The server stores "2026-10-05 04:30:00" in UTC; read as local time it was
  // hours off ("5h ago" for a lead added a minute ago).
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(String(iso)) ? `${String(iso).replace(' ', 'T')}Z` : iso);
  if (Number.isNaN(d.getTime())) return null;
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toISOString().slice(0, 10);
};

const empty = {
  student_name: '', account_name: '', mobile: '', alternate_mobile: '', email: '', gender: '', date_of_birth: '',
  address: '', country: 'India', state: '', city: '', qualification: '', source: '', status: 'New', follow_up_date: '',
  assigned_counselor: '', remarks: '', lead_rating: '', product_interest: '',
};


function LeadCard({ lead, statuses, sourceLabel, onMoved, canEdit, onDragStart, onDragEnd, dragging }) {
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState('');

  const move = async (e, next) => {
    e.preventDefault();
    e.stopPropagation();
    if (!next || next === lead.status) return;
    setMoving(true); setMoveError('');
    try {
      await api.updateLead(lead.id, { ...lead, status: next });
      onMoved?.();
    } catch (err) {
      setMoveError(friendlyError(err, 'Could not move this lead.').message);
    } finally { setMoving(false); }
  };
  return (
    <LeadCardBody lead={lead} statuses={statuses} sourceLabel={sourceLabel} canEdit={canEdit} moving={moving} moveError={moveError} onMove={move}
      onDragStart={onDragStart} onDragEnd={onDragEnd} dragging={dragging} />
  );
}

function LeadCardBody({ lead, statuses, sourceLabel, canEdit, moving, moveError, onMove, onDragStart, onDragEnd, dragging }) {
  const followUp = lead.follow_up_date ? String(lead.follow_up_date).slice(0, 10) : null;
  const isToday = followUp === new Date().toISOString().slice(0, 10);
  return (
    <Link to={`/leads/${lead.id}`} state={{ preview: { id: lead.id, title: lead.student_name } }}
      draggable={canEdit}
      onDragStart={(e) => {
        // dataTransfer must be set for the drop to register in Firefox.
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(lead.id));
        onDragStart?.(lead);
      }}
      onDragEnd={() => onDragEnd?.()}
      className={`card card-hover p-3 block transition-opacity ${canEdit ? 'cursor-grab active:cursor-grabbing' : ''} ${dragging ? 'opacity-40' : ''}`}>
      <div className="flex items-start gap-2.5">
        <Avatar name={lead.student_name} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm font-semibold text-ink truncate leading-tight">{lead.student_name}</span>
            {/* this lead came in more than once */}
            <RepeatBadge count={lead.enquiry_count} lastAt={lead.last_enquiry_at} />
          </div>
          {lead.lead_rating && <div className="mt-1"><Badge size="xs" status={lead.lead_rating}>{lead.lead_rating}</Badge></div>}
        </div>
      </div>
      <div className="mt-2.5 space-y-1">
        {lead.email && (
          <div className="flex items-center gap-1.5 t-meta min-w-0">
            <Mail className="w-3 h-3 shrink-0" /><span className="truncate">{lead.email}</span>
          </div>
        )}
        {lead.mobile && (
          <div className="flex items-center gap-1.5 t-meta"><Phone className="w-3 h-3 shrink-0" />{lead.mobile}</div>
        )}
        {lead.product_interest && (
          <div className="flex items-center gap-1.5 t-meta min-w-0">
            <Sparkles className="w-3 h-3 shrink-0" /><span className="truncate">{lead.product_interest}</span>
          </div>
        )}
      </div>
      {canEdit && (
        <div className="mt-2" onClick={(e) => e.preventDefault()}>
          <select value={lead.status || ''} disabled={moving}
            onChange={(e) => onMove(e, e.target.value)}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
            aria-label={`Move ${lead.student_name} to another status`}
            className="w-full text-[11px] border border-line rounded-md px-1.5 py-1 bg-white text-[var(--color-muted)] disabled:opacity-50">
            {selectableOptions(statuses, lead.status).map((st) => (
              <option key={st.value} value={st.value}>{moving ? 'Moving…' : `Move to ${st.label}`}</option>
            ))}
          </select>
          {moveError && <p className="text-[10px] mt-1" style={{ color: 'var(--color-danger)' }}>{moveError}</p>}
        </div>
      )}
      <div className="mt-2 pt-2 border-t border-line flex items-center justify-between gap-2">
        <span className="t-meta truncate">{(sourceLabel ? sourceLabel(lead.source) : lead.source) || '—'}</span>
        {followUp ? (
          <span className="text-[11px] font-medium shrink-0"
            style={{ color: isToday ? 'var(--color-attention)' : 'var(--color-muted)' }}>
            {isToday ? 'Today' : followUp}
          </span>
        ) : (
          <span className="t-meta shrink-0">{relative(lead.created_at)}</span>
        )}
      </div>
    </Link>
  );
}

// `leads` holds the newest cards of every status, not every lead: `totals`
// says how many each status really has, and `onMore` fetches the next cards
// of one column.
function KanbanBoard({ leads, statuses, sourceLabel, onAdd, canCreate, canEdit, onMoved, only = '', order = [], totals = {}, onMore, moreBusy = '' }) {
  // Drag-and-drop, implemented with the native HTML5 drag events rather
  // than pulling in a drag library for one board.
  //
  // `optimistic` holds a pending {id -> status} override so the card jumps
  // to the new column the instant you drop it, instead of sitting still
  // until the server replies. If the save fails the override is discarded,
  // the card snaps back to where it really is, and the error is surfaced —
  // a card that silently stays moved while the database disagrees is worse
  // than no drag at all.
  const [dragLead, setDragLead] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [optimistic, setOptimistic] = useState({});
  const [dropError, setDropError] = useState('');

  // One column per ACTIVE status, in the configured order — plus a column for
  // any deactivated status that leads still hold, so no lead disappears.
  const columns = useMemo(() => {
    const cols = statuses.filter((s) => s.active);
    const held = new Set(leads.map((l) => optimistic[l.id] || l.status).filter(Boolean));
    statuses.filter((s) => !s.active && held.has(s.value)).forEach((s) => cols.push(s));
    // A status the data holds but the list does not (older data, an import).
    held.forEach((v) => { if (!cols.some((c) => c.value === v)) cols.push({ value: v, label: v, active: true, unlisted: true }); });
    // Leads with no status get their own column, so the board's numbers are
    // the same as the cards above it.
    if (only === BLANK || leads.some((l) => !(optimistic[l.id] || l.status))) {
      cols.push({ value: BLANK, label: 'No status', active: true, unlisted: true, blank: true });
    }
    // A status card is chosen: show that status alone, using the full width.
    if (only) {
      const one = cols.filter((c) => c.value === only);
      return one.length ? one : [{ value: only, label: only, active: true, unlisted: true }];
    }
    // Same left-to-right order as the status cards above the board.
    const at = (v) => { const i = order.indexOf(v); return i < 0 ? order.length : i; };
    return cols.map((c, i) => [c, i]).sort((a, b) => at(a[0].value) - at(b[0].value) || a[1] - b[1]).map(([c]) => c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses, leads, optimistic, only, order.join('\u0001')]);

  const byStatus = useMemo(() => {
    const map = Object.fromEntries(columns.map((s) => [s.value, []]));
    const first = columns[0]?.value;
    leads.forEach((l) => {
      const effective = optimistic[l.id] || l.status || BLANK;
      // One status is chosen: cards of any other status (still on the board
      // from before, until the new answer arrives) are not shown under it.
      const key = map[effective] ? effective : (only ? null : first);
      if (key) map[key].push(l);
    });
    return map;
  }, [leads, optimistic, columns, only]);
  // Cards on their way to another column (the save is still running).
  const moving = useMemo(() => {
    const out = {};
    leads.forEach((l) => {
      const to = optimistic[l.id];
      const from = l.status || BLANK;
      if (!to || to === from) return;
      out[from] = (out[from] || 0) - 1;
      out[to] = (out[to] || 0) + 1;
    });
    return out;
  }, [leads, optimistic]);

  const handleDrop = async (status) => {
    setDragOver(null);
    const lead = dragLead;
    setDragLead(null);
    if (!lead || lead.status === status || status === BLANK) return;

    setOptimistic((o) => ({ ...o, [lead.id]: status }));
    setDropError('');
    try {
      await api.updateLead(lead.id, { ...lead, status });
      await onMoved?.();
    } catch (err) {
      setDropError(friendlyError(err, `Could not move ${lead.student_name}.`).message);
    } finally {
      // Cleared either way: on success the reloaded data already reflects
      // the change, on failure the card must snap back to the truth.
      setOptimistic((o) => {
        const next = { ...o };
        delete next[lead.id];
        return next;
      });
    }
  };

  return (
    <>
      {dropError && (
        <div className="text-sm rounded-lg px-3 py-2 mb-3"
          style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{dropError}</div>
      )}
      {canEdit && !only && (
        <p className="t-meta mb-2">Drag a card to another column to change its status.</p>
      )}
    <div className="flex gap-4 overflow-x-auto thin-scroll pb-4 -mx-1 px-1">
      {columns.map(({ value: status, label: statusName, active, unlisted, blank }) => {
        const [soft, solid] = toneVars(status);
        const items = byStatus[status] || [];
        const total = Math.max((Number(totals[status]) || 0) + (moving[status] || 0), items.length);
        const isTarget = dragOver === status && dragLead && dragLead.status !== status;
        return (
          <section key={status} className={`${only ? 'w-full' : 'w-[280px]'} shrink-0 rounded-xl flex flex-col transition-all`}
            onDragOver={(e) => { if (canEdit && dragLead && !blank) { e.preventDefault(); setDragOver(status); } }}
            onDragLeave={() => setDragOver((d) => (d === status ? null : d))}
            onDrop={(e) => { e.preventDefault(); if (canEdit) handleDrop(status); }}
            style={{
              background: soft,
              maxHeight: 'calc(100vh - 340px)',
              outline: isTarget ? `2px dashed ${solid}` : 'none',
              outlineOffset: '2px',
              transform: isTarget ? 'translateY(-2px)' : 'none',
            }}>
            <header className="px-3 pt-3 pb-2 shrink-0">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: solid }} />
                  <h3 className="text-sm font-semibold truncate" style={{ color: solid }}>{statusName}{active ? '' : ' (inactive)'}</h3>
                  <span className="text-xs font-medium px-1.5 rounded-full shrink-0"
                    style={{ background: 'rgba(255,255,255,.7)', color: solid }}>{total}</span>
                </div>
                <button className="p-0.5 rounded opacity-50 hover:opacity-100 shrink-0"
                  style={{ color: solid }} aria-label={`${statusName} column options`}>
                  <MoreVertical className="w-4 h-4" />
                </button>
              </div>
              <p className="text-[11px] mt-0.5 opacity-70" style={{ color: solid }}>{STATUS_HINT[status]}</p>
            </header>

            <div className={`px-2 pb-2 overflow-y-auto thin-scroll flex-1 ${only ? 'grid gap-2 content-start' : 'space-y-2'}`}
              style={only ? { gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' } : undefined}>
              {items.map((l) => (
                <LeadCard key={l.id} lead={l} statuses={statuses} sourceLabel={sourceLabel} canEdit={canEdit} onMoved={onMoved}
                  onDragStart={setDragLead} onDragEnd={() => { setDragLead(null); setDragOver(null); }}
                  dragging={dragLead?.id === l.id} />
              ))}
              {items.length === 0 && (
                <p className="text-[11px] text-center py-6 opacity-60 col-span-full" style={{ color: solid }}>No leads</p>
              )}
              {total > items.length && onMore && (
                <button type="button" onClick={() => onMore(status)} disabled={moreBusy === status} data-show-more={status}
                  className="w-full py-2 rounded-lg text-xs font-medium bg-white/60 hover:bg-white transition-colors col-span-full disabled:opacity-60"
                  style={{ color: solid }}>
                  {moreBusy === status ? 'Loading…' : `Show more (${(total - items.length).toLocaleString('en-IN')} more)`}
                </button>
              )}
            </div>

            {canCreate && active && !unlisted && (
              <button onClick={() => onAdd(status)}
                className="m-2 mt-0 py-2 rounded-lg text-xs font-medium flex items-center justify-center gap-1 shrink-0
                           bg-white/60 hover:bg-white transition-colors"
                style={{ color: solid }}>
                <Plus className="w-3.5 h-3.5" /> Add Lead
              </button>
            )}
          </section>
        );
      })}
    </div>
    </>
  );
}

function AddLeadModal({ initialStatus, statuses, sources, ratings, onClose, onSaved }) {
  const [form, setForm] = useState({ ...empty, status: initialStatus || 'New' });
  // The first follow-up: a date AND a time, so its reminder fires at an
  // exact moment. Both or neither.
  const [followUp, setFollowUp] = useState({ date: '', time: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!form.student_name.trim()) return setError('Name is required.');
    let dueAt = null;
    if (followUp.date || followUp.time) {
      if (!followUp.date || !followUp.time) return setError('Pick both the follow-up date and time, or leave both empty.');
      dueAt = localToIso(followUp.date, followUp.time);
      if (!dueAt || Date.parse(dueAt) < Date.now() - 60000) return setError('Pick a follow-up time in the future.');
    }
    setSaving(true); setError('');
    try {
      const { follow_up_date: _unused, ...body } = form;
      const created = await api.createLead(body);
      if (dueAt && created?.id) {
        await api.scheduleFollowUp({ module: 'leads', record_id: created.id, due_at: dueAt, has_time: true, time_zone: browserTimeZone() });
      }
      onSaved();
    } catch (err) {
      // "Open existing" / closing the duplicate pop-up: nothing was saved and
      // the form stays as it is.
      setError(err.cancelled ? '' : err.message);
    } finally { setSaving(false); }
  };

  const setKey = (k, v) => setForm((p) => ({ ...p, [k]: v }));
  const geoField = (label, kind) => (
    <div>
      <label className="t-meta font-medium block mb-1">{label}</label>
      <GeoInput kind={kind} value={form[kind] || ''} onChange={(v) => setKey(kind, v)} values={form} onSet={setKey} testid={`lead-${kind}`} />
    </div>
  );
  const field = (label, key, props = {}) => (
    <div>
      <label className="t-meta font-medium block mb-1">{label}{props.required && ' *'}</label>
      <input className="input" value={form[key] || ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} {...props} />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Add lead">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <form onSubmit={submit} className="card relative w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <h2 className="t-section">Add Lead</h2>
          <button type="button" onClick={onClose} aria-label="Close"
            className="text-[var(--color-faint)] hover:text-ink p-1 rounded-lg hover:bg-[var(--color-canvas)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-5">
          {error && (
            <div className="text-xs rounded-lg px-3 py-2"
              style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>
          )}

          <section>
            <h3 className="t-meta font-semibold uppercase tracking-wide mb-2">Personal</h3>
            <div className="grid sm:grid-cols-2 gap-3">
              {field('Name', 'student_name', { required: true, placeholder: 'Full name' })}
              {/* Converting a lead creates an Account, and an Account is the
                  ORGANISATION. Without this the conversion had nothing to
                  name it after and used the person's name instead. */}
              {field('Company / Account Name', 'account_name', { placeholder: 'e.g. Smart Business Solution' })}
            </div>
            <div className="mt-3">
              <label className="t-meta font-medium block mb-1">Address</label>
              <AddressInput value={form.address || ''} onChange={(v) => setKey('address', v)} values={form} onSet={setKey} testid="lead-address" />
            </div>
            <div className="grid sm:grid-cols-3 gap-3 mt-3">
              {geoField('Country', 'country')}
              {geoField('State', 'state')}
              {geoField('City', 'city')}
            </div>
          </section>

          <section>
            <h3 className="t-meta font-semibold uppercase tracking-wide mb-2">Contact</h3>
            <div className="grid sm:grid-cols-2 gap-3">
              {field('Mobile', 'mobile', { type: 'tel' })}
              {field('Email', 'email', { type: 'email' })}
            </div>
            {/* Same mobile or email as a lead that is already here: shown
                straight away, before the rest of the form is filled in. */}
            <DuplicateHint module="leads" what="lead" values={{ mobile: form.mobile, email: form.email }} />
          </section>

          <section>
            <h3 className="t-meta font-semibold uppercase tracking-wide mb-2">Lead details</h3>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="t-meta font-medium block mb-1">Status</label>
                <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  {selectableOptions(statuses, form.status).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label className="t-meta font-medium block mb-1">Source</label>
                <select className="input" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
                  <option value="">Select…</option>
                  {selectableOptions(sources, form.source).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label className="t-meta font-medium block mb-1">Rating</label>
                <select className="input" value={form.lead_rating} onChange={(e) => setForm({ ...form, lead_rating: e.target.value })}>
                  <option value="">Select…</option>
                  {selectableOptions(ratings, form.lead_rating, ['Hot', 'Warm', 'Cold']).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              {field('Product interest', 'product_interest')}
            </div>
          </section>

          <section>
            <h3 className="t-meta font-semibold uppercase tracking-wide mb-2">Assignment &amp; follow-up</h3>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="t-meta font-medium block mb-1">Assigned to</label>
                <AssignPicker asInput mode="name" label="Assigned to" placeholder="Select a user…"
                  value={form.assigned_counselor || null} onChange={(v) => setForm({ ...form, assigned_counselor: v || '' })} />
              </div>
              <div>
                <label className="t-meta font-medium block mb-1">First follow-up (date &amp; time)</label>
                <div className="grid grid-cols-2 gap-2">
                  <input type="date" className="input" value={followUp.date} aria-label="Follow-up date"
                    onChange={(e) => setFollowUp((f) => ({ ...f, date: e.target.value }))} />
                  <input type="time" className="input" value={followUp.time} aria-label="Follow-up time"
                    onChange={(e) => setFollowUp((f) => ({ ...f, time: e.target.value }))} />
                </div>
              </div>
            </div>
          </section>

          <section>
            <label className="t-meta font-medium block mb-1">Notes</label>
            <textarea className="input" rows={3} value={form.remarks}
              onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
          </section>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-line shrink-0">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn btn-primary disabled:opacity-50">
            {saving ? 'Saving…' : 'Add Lead'}
          </button>
        </div>
      </form>
    </div>
  );
}

// How many leads a page of the list holds, and how many cards a board column
// starts with.
const PAGE_SIZES = [25, 50, 100, 200];
const BOARD_STEP = 30;
const localToday = () => new Date().toLocaleDateString('en-CA');
const num = (n) => Number(n || 0).toLocaleString('en-IN');

function Pager({ page, pages, total, from, to, pageSize, onPage, onPageSize, busy }) {
  const btn = 'inline-flex items-center justify-center w-8 h-8 rounded-lg border border-line bg-white text-[var(--color-muted)] hover:text-ink hover:border-[var(--color-brand-border)] disabled:opacity-40 disabled:hover:text-[var(--color-muted)]';
  return (
    // (room on the right: the round assistant button floats over that corner)
    <div className="pl-4 py-2.5 border-t border-line flex items-center justify-between gap-3 flex-wrap" data-pager style={{ paddingRight: 72 }}>
      <div className="t-meta" data-pager-summary>
        {total === 0 ? 'No leads' : <>Showing <b className="text-ink">{num(from)}–{num(to)}</b> of <b className="text-ink">{num(total)}</b> lead{total === 1 ? '' : 's'}</>}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <label className="t-meta flex items-center gap-1.5">
          Rows per page
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} aria-label="Rows per page"
            className="border border-line rounded-lg px-1.5 py-1 text-xs bg-white text-ink">
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-1">
          <button type="button" className={btn} onClick={() => onPage(1)} disabled={busy || page <= 1} aria-label="First page"><ChevronsLeft className="w-4 h-4" /></button>
          <button type="button" className={btn} onClick={() => onPage(page - 1)} disabled={busy || page <= 1} aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
          <span className="t-meta px-1.5 whitespace-nowrap" data-pager-page>Page <b className="text-ink">{num(page)}</b> of {num(pages)}</span>
          <button type="button" className={btn} onClick={() => onPage(page + 1)} disabled={busy || page >= pages} aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
          <button type="button" className={btn} onClick={() => onPage(pages)} disabled={busy || page >= pages} aria-label="Last page"><ChevronsRight className="w-4 h-4" /></button>
        </div>
      </div>
    </div>
  );
}

export default function Leads() {
  const can = usePermissions();
  const leadOpts = useModuleOptions('leads');
  const statuses = useMemo(() => allOptions(leadOpts?.status, FALLBACK_STATUSES), [leadOpts]);
  const sources = useMemo(() => allOptions(leadOpts?.source), [leadOpts]);
  const qualifications = useMemo(() => allOptions(leadOpts?.qualification), [leadOpts]);
  const sourceLabel = (v) => labelFor(leadOpts?.source, v);
  const [view, setView] = useState(() => localStorage.getItem('leads_view') || 'list');
  const [statusFilter, setStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');           // q, once typing has paused
  const [addFor, setAddFor] = useState(null);
  const [editingId, setEditingId] = useState(null);   // lead being edited in the popup
  // Opened from a dashboard figure: narrow to exactly the leads behind it.
  const drill = useDrill();
  const [urlParams] = useSearchParams();
  const drillParams = useMemo(() => {
    const out = {};
    urlParams.forEach((v, k) => { if (k !== 'drill') out[k] = v; });
    return out;
  }, [urlParams]);
  const drillKey = JSON.stringify(drillParams);
  // Field filters, saved filters, row selection and bulk actions.
  const [showFilters, setShowFilters] = useState(false);
  const [conditions, setConditions] = useState([]);
  const [match, setMatch] = useState('all');
  const [activeSaved, setActiveSaved] = useState(null);
  const [savedRefresh, setSavedRefresh] = useState(0);
  const [bulk, setBulk] = useState(null);
  const tel = useTelephony();        // is this person an agent who can call (MCube IVR)?
  const selection = useSelection('leads');

  // ---- What is on screen ----------------------------------------------------
  // The server searches, filters and counts; only one page of leads (or the
  // first cards of each board column) is fetched. So the list opens as fast
  // with fifty thousand leads as with fifty.
  const [pageSize, setPageSize] = useState(() => {
    const n = Number(localStorage.getItem('leads_page_size'));
    return PAGE_SIZES.includes(n) ? n : 50;
  });
  // Coming back to Leads shows the last first page at once; fresh rows follow.
  const kept = useMemo(() => { const k = drill.active ? null : recall('leads:first'); return k && k.pageSize === pageSize ? k : null; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [data, setData] = useState(() => kept?.data || null);       // the list: { rows, total, page, pages, … }
  const [board, setBoard] = useState(null);                          // the board: { board: [...], … }
  const [more, setMore] = useState({});                              // board: cards fetched with "Show more", by status
  const [moreBusy, setMoreBusy] = useState('');
  const [summary, setSummary] = useState(() => kept?.data || null);  // totals for the cards (same for list and board)
  const [meta, setMeta] = useState(() => kept?.meta || { owners: [], facets: {} });
  const [loading, setLoading] = useState(!kept);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');           // a small problem that does not hide the list
  // Which dashboard figure the answers on screen belong to ('' = none).
  const [answeredDrill, setAnsweredDrill] = useState('');

  useEffect(() => { const t = setTimeout(() => setSearch(q), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { localStorage.setItem('leads_view', view); }, [view]);
  useEffect(() => { localStorage.setItem('leads_page_size', String(pageSize)); }, [pageSize]);

  const owners = meta.owners || [];
  // Rows that only carry the values a free-text field holds across ALL leads
  // (cities, campaigns…), for the filter panel's and the mass update's choices.
  const facetRows = useMemo(
    () => Object.entries(meta.facets || {}).flatMap(([field, values]) => (values || []).map((v) => ({ [field]: v }))),
    [meta],
  );

  // Every configured option (inactive ones too — existing leads can hold
  // them) plus any value the data holds that is not configured at all.
  const held = useMemo(() => ({
    status: [...new Set([...(meta.facets?.status || []), ...(summary?.status_counts || []).map((c) => c.value)])],
    source: meta.facets?.source || [],
    qualification: meta.facets?.qualification || [],
  }), [summary, meta]);
  const withData = (opts, key) => {
    const known = new Set(opts.map((o) => o.value));
    const extra = [...new Set((held[key] || []).filter((v) => v && !known.has(String(v))))];
    return [...opts, ...extra.map((v) => ({ value: String(v), label: String(v), active: false }))];
  };
  const fields = useMemo(() => leadFields(
    withData(statuses, 'status'),
    withData(sources, 'source'),
    withData(qualifications, 'qualification'),
    { ratings: leadOpts?.lead_rating, genders: leadOpts?.gender },
  ), [held, statuses, sources, qualifications, leadOpts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Everything except the status choice: search, source, owner, the filter
  // panel and a dashboard drill-down. The cards are counted on this, so a
  // card's number is always the number of leads it shows when clicked.
  const question = useMemo(() => {
    const out = {
      q: search.trim(), source: sourceFilter, owner: ownerFilter, match, today: localToday(),
      conditions: conditions.filter(isComplete).map((c) => {
        const f = fields.find((x) => x.api_name === c.field);
        return f ? { field: c.field, op: c.op, value: c.value, value2: c.value2, quick: !!c.quick, kind: kindOf(f) } : null;
      }).filter(Boolean),
    };
    // Opened from a dashboard figure: the server narrows the list with the
    // figure's own query (its leads are not sent there and back as ids).
    if (drill.active) out.drill = { metric: drill.metric, ...drillParams };
    return out;
  }, [search, sourceFilter, ownerFilter, conditions, match, fields, drill.active, drill.metric, drillKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const questionKey = JSON.stringify(question);
  const plain = !search.trim() && !sourceFilter && !ownerFilter && !statusFilter && !question.conditions.length && !drill.active;

  // The page belongs to one question: a new search or filter starts at page 1.
  const pageKey = `${questionKey}|${statusFilter}|${pageSize}`;
  const [pageAt, setPageAt] = useState({ key: pageKey, n: 1 });
  const page = pageAt.key === pageKey ? pageAt.n : 1;
  const setPage = (n) => setPageAt({ key: pageKey, n: Math.max(1, n) });

  // Opened from a dashboard figure: waiting for it, ready, failed — or not at all.
  const drillState = !drill.active ? 'off' : drill.data ? 'ready' : drill.error ? 'error' : 'wait';
  const drillNow = drill.active ? JSON.stringify(question.drill || {}) : '';
  const sigOf = (p) => [questionKey, statusFilter, p, pageSize, view, drillState].join('|');
  const answeredSig = useRef('');            // the answer on screen already covers this (see load)

  const seq = useRef(0);
  const metaStale = useRef(true);            // owners and filter choices: asked for with the next load
  const boardPer = useRef(BOARD_STEP);       // cards per column the board is loaded with
  const load = async () => {
    // Opened from a dashboard figure: wait for its list of leads (if that
    // fails, the banner says so and nothing is listed).
    if (drill.active && !drill.data) { if (drill.error) setLoading(false); return; }
    const mine = ++seq.current;
    const forDrill = drillNow;
    const wantMeta = metaStale.current;
    setBusy(true); setError(null);
    try {
      const body = { ...question, status: statusFilter, ...(wantMeta ? { with_owners: true, with_facets: true } : {}) };
      const res = view === 'kanban'
        ? await api.queryLeads({ ...body, board: { per_status: boardPer.current } })
        : await api.queryLeads({ ...body, page, page_size: pageSize });
      if (mine !== seq.current) return;              // a newer question was asked meanwhile
      let nextMeta = meta;
      if (wantMeta && res.owners) {
        nextMeta = { owners: res.owners, facets: res.facets || {} };
        setMeta(nextMeta);
        metaStale.current = false;
      }
      setSummary(res);
      setAnsweredDrill(forDrill);
      if (view === 'kanban') { setBoard(res); setMore({}); } else {
        setData(res);
        // Asked for a page past the end (the last rows of the last page were
        // deleted): the server answered with the last page there is — shown
        // as it is, not asked for a second time.
        if (res.page && res.page !== page) { answeredSig.current = sigOf(res.page); setPage(res.page); }
        if (plain && res.page === 1) remember('leads:first', { data: res, meta: nextMeta, pageSize });
      }
    } catch (e) {
      if (mine === seq.current) setError(e.message || 'Could not load the leads.');
    } finally {
      if (mine === seq.current) { setLoading(false); setBusy(false); }
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  // After something was saved: the same view again, with fresh totals,
  // owners and filter choices — and nothing left ticked that the change took
  // out of the list.
  const keepRef = useRef(() => {});
  const refresh = () => { metaStale.current = true; keepRef.current(); return loadRef.current(); };
  // …the same, back on the first page (a lead that was just added is there).
  const refreshFromTop = () => { if (page === 1) return refresh(); metaStale.current = true; setPage(1); return undefined; };

  const sig = sigOf(page);
  useEffect(() => {
    if (answeredSig.current === sig) { answeredSig.current = ''; return; }
    answeredSig.current = '';
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // A different question: what was ticked may no longer be in it.
  const selectionKey = `${questionKey}|${statusFilter}`;
  const firstSelectionKey = useRef(selectionKey);
  useEffect(() => {
    if (firstSelectionKey.current === selectionKey) return;
    firstSelectionKey.current = selectionKey;
    selection.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  // One card per real status: the configured ones in their order, plus any
  // other status the leads actually hold. Nothing is grouped or renamed.
  // (While a dashboard figure's leads are still being worked out — or could
  // not be — the cards count nothing, rather than the list that was on screen
  // before.)
  const counted = (drill.active && !drill.data) || answeredDrill !== drillNow ? null : summary;
  const statusCards = useMemo(
    () => breakdownFromServer(counted?.status_counts || [], statuses, { selected: statusFilter, blankLabel: 'No status' }),
    [counted, statuses, statusFilter],
  );
  const baseTotal = counted?.base_total || 0;
  const total = counted?.total || 0;                 // matching everything, the status included

  const stale = answeredDrill !== drillNow;         // what is held was asked for another dashboard figure (or none)
  const rows = stale ? [] : (data?.rows || []);
  const from = total === 0 ? 0 : ((data?.page || 1) - 1) * (data?.page_size || pageSize) + 1;
  const to = from === 0 ? 0 : from + rows.length - 1;

  // The board: the first cards of every column, then what "Show more" added.
  const boardLeads = useMemo(() => {
    if (stale) return [];
    const first = board?.board || [];
    const seen = new Set(first.map((l) => l.id));
    const extra = Object.values(more).flat().filter((l) => !seen.has(l.id) && seen.add(l.id));
    return [...first, ...extra];
  }, [board, more, stale]);
  const boardTotals = useMemo(() => {
    const out = {};
    (summary?.status_counts || []).forEach((c) => { const k = c.value === null || String(c.value).trim() === '' ? BLANK : String(c.value); out[k] = (out[k] || 0) + (Number(c.n) || 0); });
    return out;
  }, [summary]);
  const showMore = async (status) => {
    const have = boardLeads.filter((l) => (l.status || BLANK) === status || (status === BLANK && String(l.status || '').trim() === '')).length;
    const asked = seq.current;
    setMoreBusy(status);
    try {
      const res = await api.queryLeads({ ...question, status, offset: have, page_size: BOARD_STEP });
      if (asked !== seq.current) return;             // the board was reloaded meanwhile (new search, a save)
      setMore((m) => ({ ...m, [status]: [...(m[status] || []), ...(res.rows || [])] }));
      boardPer.current = Math.min(200, Math.max(boardPer.current, have + (res.rows || []).length));
    } catch (e) { setNotice(`Could not load more leads: ${e.message || 'please try again.'}`); } finally { setMoreBusy(''); }
  };

  const shown = view === 'kanban' ? boardLeads : rows;
  const selectedIds = [...selection.ids];
  const allSelected = rows.length > 0 && rows.every((l) => selection.has(l.id));
  const someSelected = rows.some((l) => selection.has(l.id));
  const runUpdate = async (field, value, onProgress) => {
    const result = await runBulk(selectedIds, (id) => api.updateLead(id, { [field.api_name]: value }), onProgress);
    refresh();
    return result;
  };
  const runUpdateMany = async (changes, onProgress) => {
    const body = Object.fromEntries(changes.map((c) => [c.field.api_name, c.value]));
    const result = await runBulk(selectedIds, (id) => api.updateLead(id, body), onProgress);
    refresh();
    return result;
  };
  const runDelete = async (onProgress) => {
    const result = await runBulk(selectedIds, (id) => api.deleteLead(id), onProgress, 2);
    selection.clear();
    refresh();
    return result;
  };
  const reassign = (l) => async (value) => {
    await api.updateLead(l.id, { assigned_counselor: value || null });
    setData((d) => (d ? { ...d, rows: d.rows.map((x) => (x.id === l.id ? { ...x, assigned_counselor: value } : x)) } : d));
    if (value) setMeta((m) => (m.owners?.includes(value) ? m : { ...m, owners: [...(m.owners || []), value].sort((a, b) => a.localeCompare(b)) }));
    refresh();                                        // the row may no longer belong in this list; the choices may have changed
  };

  // Every lead that matches, not just the page on screen.
  const [capped, setCapped] = useState(0);          // "select all" stopped at this many
  const selectionKeyRef = useRef('');
  selectionKeyRef.current = selectionKey;
  const selectAllMatching = async () => {
    const asked = selectionKey;
    try {
      const res = await api.queryLeads({ ...question, status: statusFilter, ids_only: true });
      if (asked !== selectionKeyRef.current) return;  // the search or a filter changed meanwhile
      selection.replace(res.ids || []);
      setCapped(res.capped ? (res.ids || []).length : 0);
    } catch (e) { setNotice(`Could not select all the leads: ${e.message || 'please try again.'}`); }
  };
  useEffect(() => { if (selection.ids.size !== capped) setCapped(0); }, [selection.ids]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!notice) return undefined; const t = setTimeout(() => setNotice(''), 8000); return () => clearTimeout(t); }, [notice]);
  // After a change to the ticked leads some may no longer match the search
  // and filters on screen: they are unticked, so the next action cannot touch
  // leads that are out of sight.
  const keepMatchingSelected = async (ids) => {
    if (!ids.length) return;
    const asked = selectionKeyRef.current;
    try {
      const res = await api.queryLeads({ ...question, status: statusFilter, ids_only: true });
      if (res.capped || asked !== selectionKeyRef.current) return;
      const still = new Set((res.ids || []).map(Number));
      selection.replace(ids.filter((id) => still.has(Number(id))));
    } catch { /* the selection stays as it is */ }
  };
  keepRef.current = () => { if (selection.ids.size) keepMatchingSelected([...selection.ids]); };
  const exportAll = async () => {
    setExporting(true);
    try {
      const all = [];
      let p = 1; let pages = 1;
      do {
        const res = await api.queryLeads({ ...question, status: statusFilter, page: p, page_size: 1000 });
        all.push(...(res.rows || []));
        pages = res.pages || 1;
        p += 1;
      } while (p <= pages);
      downloadCSV('leads.csv', all);
    } catch (e) { alert(`Could not export: ${e.message}`); } finally { setExporting(false); }
  };
  const exportSelected = async () => {
    try {
      const all = [];
      for (let i = 0; i < selectedIds.length; i += 1000) {
        const res = await api.queryLeads({ ids: selectedIds.slice(i, i + 1000), page_size: 1000 });
        all.push(...(res.rows || []));
      }
      downloadCSV('leads-selected.csv', all);
    } catch (e) { alert(`Could not export: ${e.message}`); }
  };

  const viewBtn = (id, Icon, label) => (
    <button onClick={() => setView(id)} aria-pressed={view === id}
      className={`btn ${view === id ? 'btn-primary' : 'btn-secondary'}`}>
      <Icon className="w-4 h-4" /> {label}
    </button>
  );
  const waitingForDrill = drill.active && drill.loading;
  const ready = !loading && !error && !(drill.active && (drill.loading || drill.error));
  const have = stale ? null : (view === 'kanban' ? board : data);      // the answer for the view on screen

  return (
    <div className="w-full">
      <PageHeader title="Leads" subtitle="Manage your leads and track their journey from first enquiry to close">
        {viewBtn('list', List, 'List View')}
        {viewBtn('kanban', Columns3, 'Kanban View')}
        {can('leads', 'export') && (
          <button onClick={exportAll} disabled={exporting} className="btn btn-secondary disabled:opacity-60"
            title={`Download ${num(total)} lead${total === 1 ? '' : 's'}`}>
            <Download className="w-4 h-4" /><span className="hidden sm:inline">{exporting ? 'Exporting…' : 'Export'}</span>
          </button>
        )}
        {can('leads', 'create') && (
          <button onClick={() => setAddFor('New')} className="btn btn-primary">
            <UserPlus className="w-4 h-4" /> Add Lead
          </button>
        )}
      </PageHeader>

      {/* Total + one card per real status, each with its real count, in one
          row: Total Leads stays put and the statuses beyond the first four
          slide in from the right. Click a card to see only those leads (list
          and board); click it again, or click Total Leads, to see all. */}
      {loading ? <SkeletonCards count={5} /> : (
        <StatusCards
          total={{ label: 'Total Leads', value: baseTotal, icon: UsersIcon, from: '#E879F9', to: '#A21CAF' }}
          items={statusCards} selected={statusFilter} onSelect={setStatusFilter} />
      )}

      {/* One compact toolbar. These were four full-width blocks stacked
          vertically, pushing the actual leads far below the fold — caused
          by `.input { width:100% }` outranking the `w-auto` already in the
          markup (fixed in index.css). */}
      <div className="flex flex-wrap items-center gap-2 mt-5 mb-4">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-faint)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 36 }} className="input w-full pl-9"
            placeholder="Search by name, email or phone…" aria-label="Search leads" />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="input w-auto min-w-[130px]" aria-label="Filter by status">
          <option value="">All Statuses</option>
          {statusCards.map((s) => <option key={s.value} value={s.value}>{s.inactive ? `${s.label} (inactive)` : s.label}</option>)}
        </select>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}
          className="input w-auto min-w-[130px]" aria-label="Filter by source">
          <option value="">All Sources</option>
          {sources.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        {(owners.length > 0 || ownerFilter) && (
          <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}
            className="input w-auto min-w-[130px]" aria-label="Filter by owner">
            <option value="">All Owners</option>
            {[...new Set([...owners, ...(ownerFilter ? [ownerFilter] : [])])].map((o) => <option key={o}>{o}</option>)}
          </select>
        )}
        <FilterButton count={conditions.filter(isComplete).length} open={showFilters} onClick={() => setShowFilters((v) => !v)} />
        <SavedFiltersMenu module="leads" refreshKey={savedRefresh} activeId={activeSaved?.id}
          onSelect={(f) => { setActiveSaved(f); setConditions(f ? f.filters : []); setMatch(f ? f.match : 'all'); setShowFilters(false); }} />
        {(q || statusFilter || sourceFilter || ownerFilter) && (
          <button onClick={() => { setQ(''); setSearch(''); setStatusFilter(''); setSourceFilter(''); setOwnerFilter(''); }}
            className="text-xs font-medium px-3 py-2 rounded-lg border border-line text-slate-500 hover:text-ink hover:bg-[var(--color-canvas)]">
            Clear
          </button>
        )}
      </div>

      {showFilters && (
        <div className="mb-3">
          <FilterPanel key={activeSaved?.id || 'adhoc'} module="leads" fields={fields} initial={conditions} initialMatch={match} rows={facetRows} getValue={leadValue}
            onClose={() => setShowFilters(false)} onSaved={() => setSavedRefresh((n) => n + 1)}
            onApply={(conds, m, saved) => { setConditions(conds); setMatch(m); setActiveSaved(saved || null); setShowFilters(false); }} />
        </div>
      )}
      <div className="mb-3">
        <ActiveFilterChips conditions={conditions} match={match} fields={fields} savedName={activeSaved?.name}
          onRemove={(c) => { setConditions((cs) => cs.filter((x) => x !== c)); setActiveSaved(null); }}
          onClear={() => { setConditions([]); setActiveSaved(null); }} />
        <BulkBar count={selection.ids.size} pageCount={rows.length} matchingCount={capped ? selection.ids.size : total} allPageSelected={allSelected}
          onSelectAllMatching={selectAllMatching} onClear={selection.clear}
          canEdit={can('leads', 'edit')} canDelete={can('leads', 'delete')} canExport={can('leads', 'export')} hasUserField
          onUpdate={() => setBulk('update')} onAssign={() => setBulk('assign')} onDelete={() => setBulk('delete')}
          onExport={exportSelected}
          extra={(tel.status?.can_call || tel.status?.dial_manage) ? (
            <button type="button" onClick={() => setBulk('dial')} data-bulk-dial
              className="inline-flex items-center gap-1.5 text-[13px] font-semibold px-3 py-1.5 rounded-lg transition-colors bg-white/15 hover:bg-white/25">
              <PhoneCall className="w-4 h-4" /> Auto-dial
            </button>
          ) : null} />
        {capped > 0 && selection.ids.size > 0 && (
          <p className="t-meta mt-1.5" data-selection-capped>
            {num(capped)} is the most that can be selected at once, so the newest {num(capped)} of the {num(total)} matching leads are selected.
          </p>
        )}
      </div>

      {notice && (
        <div className="text-xs rounded-lg px-3 py-2 mb-3 flex items-center justify-between gap-3" role="status" data-leads-notice
          style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong, var(--color-warning))' }}>
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice('')} aria-label="Dismiss" className="shrink-0"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      <DrillBanner drill={drill} shown={drill.data && !stale ? total : undefined} noun="leads" />
      {drill.active && drill.data && <div className="mb-4" />}

      {(loading || waitingForDrill || (ready && !have)) && <SkeletonRows rows={6} cols={6} />}

      {!loading && error && (
        <ErrorState message="Unable to load leads." detail={error} onRetry={() => { setLoading(true); refresh(); }} />
      )}

      {ready && have && shown.length === 0 && (
        <EmptyState icon={UsersIcon} title={drill.data ? 'No leads match these dashboard filters' : 'No leads found'}
          description={drill.data
            ? 'Nothing currently meets the criteria above — the dashboard figure is genuinely zero.'
            : q || statusFilter || sourceFilter || ownerFilter || question.conditions.length
              ? 'No leads match your current filters. Try clearing them.'
              : 'Leads you add or capture will appear here.'}>
          {can('leads', 'create') && (
            <button onClick={() => setAddFor('New')} className="btn btn-primary mx-auto">
              <UserPlus className="w-4 h-4" /> Add Lead
            </button>
          )}
        </EmptyState>
      )}

      {ready && have && shown.length > 0 && view === 'kanban' && (
        <div style={{ opacity: busy ? 0.6 : 1, transition: 'opacity .15s' }} aria-busy={busy}>
          <KanbanBoard leads={boardLeads} statuses={statuses} sourceLabel={sourceLabel} onAdd={setAddFor} canCreate={can('leads', 'create')}
            canEdit={can('leads', 'edit')} onMoved={refresh} only={statusFilter} order={statusCards.map((c) => c.value)}
            totals={boardTotals} onMore={showMore} moreBusy={moreBusy} />
        </div>
      )}

      {ready && have && shown.length > 0 && view === 'list' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto thin-scroll" style={{ opacity: busy ? 0.6 : 1, transition: 'opacity .15s' }} aria-busy={busy}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left bg-[var(--color-canvas)] border-b border-line">
                  <th className="py-2.5 pl-4 pr-1 w-8">
                    <RowCheckbox checked={allSelected} indeterminate={!allSelected && someSelected} label="Select all leads shown"
                      onChange={() => selection.setMany(rows.map((l) => l.id), !allSelected)} />
                  </th>
                  {['Lead', 'Contact', 'Source', 'Status', 'Rating', 'Assigned To', 'Next Follow-up', 'Created'].map((h) => (
                    <th key={h} className="py-2.5 px-4 t-meta font-semibold whitespace-nowrap">{h}</th>
                  ))}
                  {can('leads', 'edit') && <th className="py-2.5 px-4 t-meta font-semibold text-right whitespace-nowrap">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} className="border-b border-line/60 hover:bg-[var(--color-canvas)] transition-colors"
                    style={selection.has(l.id) ? { background: 'var(--color-brand-faint)' } : undefined}>
                    <td className="py-3 pl-4 pr-1 w-8">
                      <RowCheckbox checked={selection.has(l.id)} label={`Select ${l.student_name}`} onChange={() => selection.toggle(l.id)} />
                    </td>
                    <td className="py-3 px-4">
                      <Link to={`/leads/${l.id}`} state={{ preview: { id: l.id, title: l.student_name } }} className="flex items-center gap-2.5 group">
                        <Avatar name={l.student_name} size="sm" />
                        <span className="font-medium text-ink group-hover:text-[var(--color-brand)] truncate">
                          {l.student_name}
                        </span>
                        {/* this lead came in more than once */}
                        <RepeatBadge count={l.enquiry_count} lastAt={l.last_enquiry_at} />
                      </Link>
                    </td>
                    <td className="py-3 px-4">
                      <div className="text-[var(--color-muted)] text-xs space-y-0.5">
                        {l.email && (
                          <div className="truncate max-w-[180px]">
                            {/* opens the CRM's compose pop-up */}
                            <a href={`mailto:${l.email}`} data-name={l.student_name} data-module="leads" data-record-id={l.id}
                              title={`Write an email to ${l.email}`} className="hover:text-[var(--color-brand)] hover:underline">{l.email}</a>
                          </div>
                        )}
                        {l.mobile && <div>{l.mobile}</div>}
                        {!l.email && !l.mobile && '—'}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-[var(--color-muted)] whitespace-nowrap">{sourceLabel(l.source) || '—'}</td>
                    <td className="py-3 px-4">{l.status ? <Badge status={l.status}>{labelFor(statuses, l.status)}</Badge> : <span className="text-[var(--color-faint)]">—</span>}</td>
                    <td className="py-3 px-4">{l.lead_rating ? <Badge status={l.lead_rating}>{l.lead_rating}</Badge> : <span className="text-[var(--color-faint)]">—</span>}</td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <AssignPicker mode="name" label="Owner" value={l.assigned_counselor || null}
                        disabled={!can('leads', 'edit')} onChange={reassign(l)} />
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      {l.follow_up_date ? (
                        <span className="inline-flex items-center gap-1 text-xs text-[var(--color-muted)]">
                          <Clock className="w-3 h-3" />{String(l.follow_up_date).slice(0, 10)}
                        </span>
                      ) : <span className="text-[var(--color-faint)]">—</span>}
                    </td>
                    <td className="py-3 px-4 t-meta whitespace-nowrap">{relative(l.created_at) || '—'}</td>
                    {/* Same popup as the lead's own page, opened in place.
                        Only for roles with edit on Leads. */}
                    {can('leads', 'edit') && (
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <button onClick={() => setEditingId(l.id)} aria-label={`Edit ${l.student_name}`} title="Edit lead"
                          className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-line bg-white transition-colors hover:border-[var(--color-brand-border)] hover:bg-[var(--color-brand-faint)]"
                          style={{ color: 'var(--color-ink)' }}>
                          <Pencil className="w-3.5 h-3.5" style={{ color: 'var(--color-brand)' }} /> Edit
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={data?.page || 1} pages={data?.pages || 1} total={total} from={from} to={to} pageSize={pageSize}
            onPage={setPage} onPageSize={setPageSize} busy={busy} />
        </div>
      )}

      {bulk === 'update' && (
        <BulkUpdateModal fields={fields} count={selection.ids.size} noun="lead" rows={facetRows} getValue={leadValue} onRun={runUpdateMany} onClose={() => setBulk(null)} />
      )}
      {bulk === 'assign' && (
        <BulkAssignModal userFields={fields.filter((f) => f.field_type === 'user_name')} count={selection.ids.size} noun="lead"
          onRun={runUpdate} onClose={() => setBulk(null)} />
      )}
      {bulk === 'delete' && <BulkDeleteModal count={selection.ids.size} noun="lead" onRun={runDelete} onClose={() => setBulk(null)} />}
      {/* Call the ticked leads one after the other (MCube IVR). */}
      {bulk === 'dial' && <DialListModal module="leads" ids={selectedIds} noun="lead" onClose={() => setBulk(null)} />}

      {editingId && (
        <LeadEditModal leadId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => { setEditingId(null); refresh(); }} />
      )}

      {addFor && (
        <AddLeadModal initialStatus={addFor} statuses={statuses} sources={sources} ratings={leadOpts?.lead_rating}
          onClose={() => setAddFor(null)}
          onSaved={() => { setAddFor(null); refreshFromTop(); }} />
      )}
    </div>
  );
}
