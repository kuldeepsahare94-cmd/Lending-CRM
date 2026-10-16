/*
 * Support panels shown on record detail pages:
 *   - TicketSupportPanel: SLA timers and policy, AMC coverage, approval, CSAT,
 *     conversation (agent / customer / internal), KB suggestions, service
 *     request answers, escalations and the full audit timeline, plus the
 *     support actions (override SLA with reason, reopen, escalate, auto-assign).
 *   - IncidentPanel: status updates timeline and linked tickets.
 *   - ProblemPanel: linked tickets.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Timer, ShieldCheck, ShieldAlert, ShieldOff, Siren, Wand2, RotateCcw, Star, BookOpen, Send, Lock, History, ClipboardList, CheckCircle2, XCircle, Link2, Unlink,
} from 'lucide-react';
import { api } from '../../api';
import { SlaBadge, Countdown, fmtDateTime, fmtDuration, relTime, ticketsHref } from './supportUi';

const box = 'sd-card p-4 min-w-0';
const h = 'text-[13px] font-semibold flex items-center gap-1.5 mb-2';

function Err({ msg }) {
  return msg ? <p className="text-[12px] mt-2" role="alert" style={{ color: 'var(--color-danger, #BE123C)' }}>{msg}</p> : null;
}

function useAction(onDone) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); onDone?.(); return true; } catch (e) { setErr(e.message || 'Failed'); return false; } finally { setBusy(false); }
  };
  return { busy, err, run, setErr };
}

// ---------------------------------------------------------------------------
export function TicketSupportPanel({ record, canEdit, onUpdated }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { api.supportTicket(record.id).then(setD).catch((e) => setError(e.message)); }, [record.id]);
  useEffect(() => { load(); }, [load, record.updated_at, record.status]);
  const refresh = () => { load(); onUpdated?.(); };

  if (error) return <div className={`${box} mb-5`}><p className="text-[12.5px]" style={{ color: 'var(--color-muted)' }}>Support details unavailable: {error}</p></div>;
  if (!d) return <div className="sd-card mb-5 animate-pulse" style={{ height: 140 }} aria-busy="true" />;
  const closed = ['Resolved', 'Closed'].includes(record.status);

  return (
    <div className="mb-5 space-y-4">
      <div className="sd-row grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <SlaCard d={d} record={record} canEdit={canEdit} onDone={refresh} />
        <CoverageCard coverage={d.coverage} record={record} />
        <ActionsCard d={d} record={record} canEdit={canEdit} closed={closed} onDone={refresh} />
      </div>
      {d.approval?.status === 'Pending' || record.status === 'Pending Approval' ? <ApprovalCard record={record} canEdit={canEdit} onDone={refresh} /> : null}
      {d.request && <RequestCard request={d.request} approval={d.approval} />}
      <div className="sd-row grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
        <Conversation record={record} canEdit={canEdit} onDone={refresh} />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-1 gap-4 items-start min-w-0">
          {closed && d.csat_enabled && <CsatCard d={d} record={record} canEdit={canEdit} onDone={refresh} />}
          {d.escalations.length > 0 && <EscalationList items={d.escalations} />}
          <KbSuggestions items={d.suggestions} />
          <Timeline events={d.events} />
        </div>
      </div>
    </div>
  );
}

function Meter({ label, part, due, paused }) {
  if (!part) return null;
  const pct = Math.min(100, part.pct ?? (['met'].includes(part.state) ? 100 : 0));
  const color = { breached: '#F43F5E', missed: '#F43F5E', at_risk: '#F59E0B', paused: '#94A3B8' }[part.state] || '#10B981';
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between text-[12px] mb-1">
        <span className="font-medium">{label}</span>
        <SlaBadge state={part.state} compact />
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-canvas)' }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="flex justify-between text-[11px] mt-1" style={{ color: 'var(--color-muted)' }}>
        <span>Due {fmtDateTime(due)}</span>
        {['met', 'missed'].includes(part.state) ? <span>{part.state === 'met' ? 'Achieved' : 'Missed'}</span> : <Countdown due={due} paused={paused} />}
      </div>
    </div>
  );
}

function SlaCard({ d, record, canEdit, onDone }) {
  const s = d.sla;
  const [mode, setMode] = useState(null); // 'override' | 'reset'
  const [form, setForm] = useState({ reason: '', first_response_due_at: '', resolution_due_at: '' });
  const a = useAction(() => { setMode(null); setForm({ reason: '', first_response_due_at: '', resolution_due_at: '' }); onDone(); });
  const toLocal = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  return (
    <section className={box} aria-label="SLA">
      <div className={h}><Timer className="w-4 h-4" /> SLA {s.state && <span className="ml-auto"><SlaBadge state={s.state} /></span>}</div>
      {!s.policy ? (
        <p className="text-[12.5px]" style={{ color: 'var(--color-muted)' }}>No SLA policy applies to this ticket.</p>
      ) : (
        <>
          <p className="text-[11.5px] mb-3" style={{ color: 'var(--color-muted)' }}>
            {s.policy.name} · {s.policy.calendar?.is247 ? '24×7' : s.policy.calendar?.name}
            {s.targets && <> · {fmtDuration(s.targets.response)} / {fmtDuration(s.targets.resolution)}</>}
            {record.sla_overridden ? <b style={{ color: '#B45309' }}> · Overridden</b> : null}
            {s.paused_since && <> · paused {relTime(s.paused_since)}</>}
          </p>
          <Meter label="First response" part={s.response} due={s.first_response_due_at} paused={!!s.paused_since} />
          <Meter label="Resolution" part={s.resolution} due={s.resolution_due_at} paused={!!s.paused_since} />
          {d.can_override && canEdit && !mode && (
            <div className="flex gap-3 text-[12px]">
              <button type="button" className="dash-link" onClick={() => { setMode('override'); setForm({ reason: '', first_response_due_at: toLocal(s.first_response_due_at), resolution_due_at: toLocal(s.resolution_due_at) }); }}>Override due times</button>
              {record.sla_overridden ? <button type="button" className="dash-link" onClick={() => setMode('reset')}>Remove override</button> : null}
            </div>
          )}
          {mode && (
            <div className="mt-2 space-y-2 text-[12px]">
              {mode === 'override' && (
                <>
                  <label className="block">First response due<input type="datetime-local" className="input !py-1 mt-0.5" value={form.first_response_due_at} onChange={(e) => setForm({ ...form, first_response_due_at: e.target.value })} /></label>
                  <label className="block">Resolution due<input type="datetime-local" className="input !py-1 mt-0.5" value={form.resolution_due_at} onChange={(e) => setForm({ ...form, resolution_due_at: e.target.value })} /></label>
                </>
              )}
              <label className="block">Reason (required, audited)<textarea className="input mt-0.5" rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
              <div className="flex gap-2">
                <button type="button" className="btn btn-primary !py-1" disabled={a.busy} onClick={() => a.run(() => (mode === 'override'
                  ? api.supportOverride(record.id, {
                    reason: form.reason,
                    first_response_due_at: form.first_response_due_at ? new Date(form.first_response_due_at).toISOString() : null,
                    resolution_due_at: form.resolution_due_at ? new Date(form.resolution_due_at).toISOString() : null,
                  })
                  : api.supportResetSla(record.id, { reason: form.reason })))}>{mode === 'override' ? 'Save override' : 'Remove override'}</button>
                <button type="button" className="btn btn-secondary !py-1" onClick={() => { setMode(null); a.setErr(''); }}>Cancel</button>
              </div>
              <Err msg={a.err} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

function CoverageCard({ coverage, record }) {
  const sub = coverage?.subscription;
  const Icon = coverage?.status === 'covered' ? ShieldCheck : coverage?.status === 'expired' ? ShieldAlert : ShieldOff;
  const color = coverage?.status === 'covered' ? '#047857' : coverage?.status === 'expired' ? '#BE123C' : 'var(--color-muted)';
  return (
    <section className={box} aria-label="Coverage">
      <div className={h}><Icon className="w-4 h-4" style={{ color }} /> AMC / Subscription coverage</div>
      {!sub ? (
        <p className="text-[12.5px]" style={{ color: 'var(--color-muted)' }}>{record.account_id ? 'This customer has no subscription or AMC on record.' : 'No customer linked to this ticket.'}</p>
      ) : (
        <div className="text-[12.5px] space-y-1">
          <div><Link className="dash-link font-semibold" to={`/records/subscriptions/${sub.id}`}>{sub.number || `Subscription #${sub.id}`}</Link>
            <span className="ml-2 text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ color, background: coverage.status === 'covered' ? '#ECFDF5' : '#FFF1F2' }}>{coverage.status === 'covered' ? 'Covered' : 'Expired'}</span></div>
          {sub.plan && <div>Plan: <b>{sub.plan}</b></div>}
          {sub.product_name && <div>Product: {sub.product_id ? <Link className="dash-link" to={`/records/products/${sub.product_id}`}>{sub.product_name}</Link> : sub.product_name}</div>}
          <div style={{ color: 'var(--color-muted)' }}>{sub.start_date || '—'} → {sub.end_date || 'open-ended'}{sub.renewal_date ? ` · renews ${sub.renewal_date}` : ''}</div>
          {record.coverage_status && record.coverage_status !== coverage.status && <div className="text-[11px]" style={{ color: 'var(--color-muted)' }}>At logging: {record.coverage_status}</div>}
        </div>
      )}
      {record.account_id && <div className="mt-3 text-[12px]"><Link className="dash-link" to={ticketsHref({ set: 'all', account: record.account_id })}>All tickets for this customer →</Link></div>}
    </section>
  );
}

function ActionsCard({ d, record, canEdit, closed, onDone }) {
  const [esc, setEsc] = useState(null);
  const [reopen, setReopen] = useState(null);
  const a = useAction(() => { setEsc(null); setReopen(null); onDone(); });
  if (!canEdit) {
    return <section className={`${box} md:col-span-2 xl:col-span-1`}><div className={h}><Wand2 className="w-4 h-4" /> Status &amp; actions</div><p className="text-[12.5px]" style={{ color: 'var(--color-muted)' }}>You can view this ticket but not change it.</p></section>;
  }
  return (
    <section className={`${box} md:col-span-2 xl:col-span-1`} aria-label="Support actions">
      <div className={h}><Wand2 className="w-4 h-4" /> Status &amp; actions</div>
      <div className="flex flex-wrap gap-2">
        {!closed && <button type="button" className="btn btn-secondary !py-1.5" disabled={a.busy} onClick={() => a.run(() => api.supportAutoAssign(record.id, { mode: 'least_loaded' }))}><Wand2 className="w-3.5 h-3.5" /> Auto-assign</button>}
        {!closed && <button type="button" className="btn btn-secondary !py-1.5" onClick={() => setEsc({ note: '' })}><Siren className="w-3.5 h-3.5" /> Escalate</button>}
        {closed && <button type="button" className="btn btn-secondary !py-1.5" onClick={() => setReopen({ reason: '' })}><RotateCcw className="w-3.5 h-3.5" /> Reopen</button>}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] mt-3">
        {[
          ['Type', record.ticket_type || 'Incident'], ['Source', record.source || '—'],
          ['Created', fmtDateTime(record.created_at)], ['First response', record.first_response_at ? fmtDateTime(record.first_response_at) : 'Pending'],
          ['Escalation', record.escalation_level ? `Level ${record.escalation_level}` : 'None'], ['Reopened', d.reopened_count ? `${d.reopened_count}×` : 'No'],
        ].map(([k, v]) => (
          <div key={k} className="min-w-0"><dt className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--color-faint)' }}>{k}</dt><dd className="font-medium truncate">{v}</dd></div>
        ))}
      </dl>
      {esc && (
        <div className="mt-2 space-y-2 text-[12px]">
          <label className="block">Note for the team lead / manager<textarea className="input mt-0.5" rows={2} value={esc.note} onChange={(e) => setEsc({ note: e.target.value })} /></label>
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary !py-1" disabled={a.busy} onClick={() => a.run(() => api.supportEscalate(record.id, { note: esc.note }))}>Escalate</button>
            <button type="button" className="btn btn-secondary !py-1" onClick={() => setEsc(null)}>Cancel</button>
          </div>
        </div>
      )}
      {reopen && (
        <div className="mt-2 space-y-2 text-[12px]">
          <label className="block">Why is it being reopened?<textarea className="input mt-0.5" rows={2} value={reopen.reason} onChange={(e) => setReopen({ reason: e.target.value })} /></label>
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary !py-1" disabled={a.busy} onClick={() => a.run(() => api.supportReopen(record.id, reopen))}>Reopen</button>
            <button type="button" className="btn btn-secondary !py-1" onClick={() => setReopen(null)}>Cancel</button>
          </div>
        </div>
      )}
      <Err msg={a.err} />
    </section>
  );
}

function ApprovalCard({ record, canEdit, onDone }) {
  const [reason, setReason] = useState('');
  const a = useAction(onDone);
  return (
    <section className={box} style={{ borderColor: '#F59E0B' }} aria-label="Approval">
      <div className={h}><ClipboardList className="w-4 h-4" style={{ color: '#B45309' }} /> Waiting for approval</div>
      <p className="text-[12.5px] mb-2" style={{ color: 'var(--color-muted)' }}>Work on this ticket starts once it is approved. The SLA clock is paused while it waits.</p>
      {canEdit && (
        <div className="flex flex-wrap gap-2 items-center">
          <button type="button" className="btn btn-primary !py-1.5" disabled={a.busy} onClick={() => a.run(() => api.supportApproval(record.id, { decision: 'approve' }))}><CheckCircle2 className="w-4 h-4" /> Approve</button>
          <input className="input !py-1 !w-64" placeholder="Reason for rejecting" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="btn btn-secondary !py-1.5" disabled={a.busy} onClick={() => a.run(() => api.supportApproval(record.id, { decision: 'reject', reason }))}><XCircle className="w-4 h-4" /> Reject</button>
        </div>
      )}
      <Err msg={a.err} />
    </section>
  );
}

function RequestCard({ request, approval }) {
  const shown = request.schema.filter((f) => !f.show_if || String(request.answers[f.show_if.key] ?? '') === String(f.show_if.equals ?? ''));
  return (
    <section className={box} aria-label="Service request">
      <div className={h}><ClipboardList className="w-4 h-4" /> Service request: <Link className="dash-link" to={`/records/service_catalog/${request.item.id}`}>{request.item.name}</Link>
        {approval && <span className="ml-auto text-[11px] font-semibold">{approval.status}{approval.by ? ` by ${approval.by}` : ''}{approval.at ? ` · ${fmtDateTime(approval.at)}` : ''}</span>}
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-[12.5px]">
        {shown.map((f) => (
          <div key={f.key} className="flex gap-2"><dt className="shrink-0" style={{ color: 'var(--color-muted)' }}>{f.label}:</dt><dd className="font-medium break-words min-w-0">{String(request.answers[f.key] ?? '—')}</dd></div>
        ))}
      </dl>
    </section>
  );
}

function Conversation({ record, canEdit, onDone }) {
  const [body, setBody] = useState('');
  const [kind, setKind] = useState('reply'); // reply | customer | internal
  const a = useAction(() => { setBody(''); onDone(); });
  const replies = record.replies || [];
  const send = () => a.run(() => api.ticketReply(record.id, {
    body, is_internal: kind === 'internal', author_type: kind === 'customer' ? 'customer' : 'agent', channel: kind === 'customer' ? 'Phone' : null,
  }));
  return (
    <section className={box} aria-label="Conversation">
      <div className={h}><Send className="w-4 h-4" /> Conversation <span className="text-[11px] font-normal" style={{ color: 'var(--color-muted)' }}>({replies.length})</span></div>
      {!replies.length ? <p className="text-[12.5px] mb-3" style={{ color: 'var(--color-muted)' }}>No replies yet.</p> : (
        <ol className="space-y-2 mb-3 max-h-[420px] overflow-y-auto thin-scroll pr-1">
          {replies.map((r) => {
            const customer = r.author_type === 'customer';
            const style = r.is_internal ? { background: '#FFFBEB', borderColor: '#FDE68A' } : customer ? { background: '#EFF6FF', borderColor: '#BFDBFE' } : { background: 'var(--color-surface-soft)', borderColor: 'var(--color-line)' };
            return (
              <li key={r.id} className="rounded-xl border p-2.5 text-[12.5px]" style={style}>
                <div className="flex items-center gap-2 text-[11px] mb-1" style={{ color: 'var(--color-muted)' }}>
                  <b style={{ color: 'var(--color-ink)' }}>{customer ? 'Customer' : 'Agent'}</b>
                  {r.is_internal ? <span className="flex items-center gap-0.5"><Lock className="w-3 h-3" /> Internal note</span> : null}
                  {r.channel && <span>via {r.channel}</span>}
                  <span className="ml-auto">{fmtDateTime(r.created_at)}</span>
                </div>
                <div className="whitespace-pre-wrap break-words">{r.body}</div>
              </li>
            );
          })}
        </ol>
      )}
      {canEdit && (
        <div>
          <div className="flex gap-1 mb-1.5" role="radiogroup" aria-label="Reply type">
            {[['reply', 'Reply to customer'], ['internal', 'Internal note'], ['customer', 'Log customer reply']].map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
                className="text-[11.5px] px-2.5 py-1 rounded-full border"
                style={kind === k ? { background: 'var(--color-ink)', color: '#fff', borderColor: 'var(--color-ink)' } : { borderColor: 'var(--color-line)', color: 'var(--color-muted)' }}>{l}</button>
            ))}
          </div>
          <textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)}
            placeholder={kind === 'internal' ? 'Visible to staff only' : kind === 'customer' ? 'What the customer said (resumes the SLA clock if waiting on them)' : 'Your reply — the first one records the first response'} />
          <div className="flex justify-end mt-2"><button type="button" className="btn btn-primary !py-1.5" disabled={a.busy || !body.trim()} onClick={send}><Send className="w-3.5 h-3.5" /> {kind === 'internal' ? 'Add note' : 'Send'}</button></div>
          <Err msg={a.err} />
        </div>
      )}
    </section>
  );
}

function CsatCard({ d, record, canEdit, onDone }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const a = useAction(onDone);
  return (
    <section className={box} aria-label="Customer satisfaction">
      <div className={h}><Star className="w-4 h-4" /> Customer satisfaction</div>
      {d.csat ? (
        <div className="text-[12.5px]">
          <div className="flex gap-0.5 mb-1">{[1, 2, 3, 4, 5].map((n) => <Star key={n} className="w-4 h-4" fill={n <= d.csat.rating ? '#F59E0B' : 'none'} style={{ color: '#F59E0B' }} />)}</div>
          {d.csat.comment && <p className="italic">“{d.csat.comment}”</p>}
          <p className="text-[11px] mt-1" style={{ color: 'var(--color-muted)' }}>{fmtDateTime(d.csat.at)}</p>
        </div>
      ) : canEdit ? (
        <div className="text-[12px]">
          <p className="mb-1" style={{ color: 'var(--color-muted)' }}>Record the customer&apos;s rating:</p>
          <div className="flex gap-0.5 mb-2">{[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => setRating(n)}><Star className="w-5 h-5" fill={n <= rating ? '#F59E0B' : 'none'} style={{ color: '#F59E0B' }} /></button>
          ))}</div>
          <input className="input !py-1 mb-2" placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
          <button type="button" className="btn btn-primary !py-1" disabled={!rating || a.busy} onClick={() => a.run(() => api.supportCsat(record.id, { rating, comment }))}>Save rating</button>
          <Err msg={a.err} />
        </div>
      ) : <p className="text-[12.5px]" style={{ color: 'var(--color-muted)' }}>Not rated.</p>}
    </section>
  );
}

function KbSuggestions({ items }) {
  return (
    <section className={box} aria-label="Suggested articles">
      <div className={h}><BookOpen className="w-4 h-4" /> Suggested articles</div>
      {!items?.length ? <p className="text-[12.5px]" style={{ color: 'var(--color-muted)' }}>No matching knowledge articles.</p> : (
        <ul className="space-y-1.5">
          {items.map((k) => (
            <li key={k.id} className="text-[12.5px]"><Link className="dash-link font-medium" to={`/records/kb_articles/${k.id}`}>{k.title}</Link>
              {k.summary && <div className="text-[11.5px] line-clamp-2" style={{ color: 'var(--color-muted)' }}>{k.summary}</div>}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EscalationList({ items }) {
  return (
    <section className={box} aria-label="Escalations">
      <div className={h}><Siren className="w-4 h-4" style={{ color: '#BE123C' }} /> Escalations</div>
      <ul className="space-y-1.5 text-[12px]">
        {items.map((e) => (
          <li key={e.id}>
            <b>L{e.level} {e.level_name}</b> · {e.metric}{e.pct ? ` @ ${e.pct}%` : ''}
            <div className="text-[11px]" style={{ color: 'var(--color-muted)' }}>
              {fmtDateTime(e.created_at)}{e.recipients?.length ? ` · notified ${e.recipients.join(', ')}` : ''}{e.acknowledged_at ? ' · acknowledged' : ''}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Timeline({ events }) {
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, 12);
  return (
    <section className={box} aria-label="Timeline">
      <div className={h}><History className="w-4 h-4" /> Timeline &amp; audit <span className="text-[11px] font-normal" style={{ color: 'var(--color-muted)' }}>({events.length})</span></div>
      {!events.length ? <p className="text-[12.5px]" style={{ color: 'var(--color-muted)' }}>No activity recorded yet.</p> : (
        <ol className="relative border-l ml-1.5 space-y-2.5 max-h-[420px] overflow-y-auto thin-scroll" style={{ borderColor: 'var(--color-line)' }}>
          {shown.map((e) => (
            <li key={e.id} className="pl-4 relative text-[12.5px]">
              <span className="absolute -left-[5px] top-1.5 w-2 h-2 rounded-full" style={{ background: /breach|escalat/.test(e.event_type) ? '#F43F5E' : /warning/.test(e.event_type) ? '#F59E0B' : '#94A3B8' }} />
              <div>{e.message || `${e.field}: ${e.old_label ?? '—'} → ${e.new_label ?? '—'}`}</div>
              <div className="text-[11px]" style={{ color: 'var(--color-muted)' }}>{e.user_name || 'System'} · {fmtDateTime(e.created_at)}</div>
            </li>
          ))}
        </ol>
      )}
      {events.length > 12 && <button type="button" className="dash-link text-[12px] mt-2" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${events.length}`}</button>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Linked tickets for incidents and problems.
function LinkedTickets({ kind, record, column, canEdit, onChanged }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const a = useAction();
  const reload = useCallback(() => {
    api.listTicketsBy({ [column]: record.id }).then(setRows).catch(() => setRows([]));
  }, [column, record.id]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return undefined; }
    const t = setTimeout(() => api.lookupSearch('tickets', q, 8).then((r) => setHits(r.results || [])).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  const link = (ids, unlink = false) => a.run(async () => { await api.supportLinkTickets(kind, record.id, { ticket_ids: ids, unlink }); reload(); onChanged?.(); setQ(''); });
  return (
    <section className={box} aria-label="Linked tickets">
      <div className={h}><Link2 className="w-4 h-4" /> Linked tickets <span className="text-[11px] font-normal" style={{ color: 'var(--color-muted)' }}>({rows?.length ?? '…'})</span></div>
      {canEdit && (
        <div className="relative mb-3">
          <input className="input !py-1" placeholder="Search a ticket to link (number or subject)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tickets to link" />
          {hits.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full rounded-xl border shadow-lg py-1" style={{ background: 'var(--color-surface, #fff)', borderColor: 'var(--color-line)' }}>
              {hits.map((t) => <li key={t.id}><button type="button" className="w-full text-left px-3 py-1.5 text-[12.5px] hover:bg-black/5" onClick={() => link([t.id])}>{t.label}{t.sub ? <span style={{ color: 'var(--color-muted)' }}> · {t.sub}</span> : null}</button></li>)}
            </ul>
          )}
        </div>
      )}
      {!rows ? <div className="h-10 animate-pulse rounded-lg" style={{ background: 'var(--color-canvas)' }} /> : !rows.length ? (
        <p className="text-[12.5px]" style={{ color: 'var(--color-muted)' }}>No tickets linked.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="sd-table w-full">
            <thead><tr><th>Ticket</th><th>Subject</th><th>Customer</th><th>Status</th><th>SLA</th>{canEdit && <th />}</tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="whitespace-nowrap"><Link className="dash-link font-medium" to={`/records/tickets/${t.id}`}>{t.ticket_number}</Link></td>
                  <td className="min-w-[180px]">{t.subject}</td>
                  <td>{t.account_name || '—'}</td>
                  <td>{t.status}</td>
                  <td><SlaBadge state={t.sla_state} compact /></td>
                  {canEdit && <td><button type="button" aria-label={`Unlink ${t.ticket_number}`} onClick={() => link([t.id], true)}><Unlink className="w-4 h-4" /></button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Err msg={a.err} />
    </section>
  );
}

export function IncidentPanel({ record, canEdit, onUpdated }) {
  const [updates, setUpdates] = useState(null);
  const [form, setForm] = useState({ body: '', status: '' });
  const load = useCallback(() => { api.supportIncidentUpdates(record.id).then(setUpdates).catch(() => setUpdates([])); }, [record.id]);
  useEffect(() => { load(); }, [load]);
  const a = useAction(() => { setForm({ body: '', status: '' }); load(); onUpdated?.(); });
  return (
    <div className="mb-5 grid lg:grid-cols-2 gap-4">
      <section className={box} aria-label="Incident updates">
        <div className={h}><History className="w-4 h-4" /> Status updates</div>
        {canEdit && (
          <div className="mb-3 space-y-2">
            <textarea className="input" rows={2} placeholder="Post an update — it is added to every linked ticket's timeline" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
            <div className="flex gap-2 items-center">
              <select className="input !py-1 !w-auto" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} aria-label="Change status">
                <option value="">Status unchanged ({record.status})</option>
                {['Investigating', 'Identified', 'Monitoring', 'Resolved', 'Closed'].map((s) => <option key={s}>{s}</option>)}
              </select>
              <button type="button" className="btn btn-primary !py-1.5 ml-auto" disabled={!form.body.trim() || a.busy} onClick={() => a.run(() => api.supportAddIncidentUpdate(record.id, form))}>Post update</button>
            </div>
            <Err msg={a.err} />
          </div>
        )}
        {!updates ? <div className="h-10 animate-pulse rounded-lg" style={{ background: 'var(--color-canvas)' }} /> : !updates.length ? <p className="text-[12.5px]" style={{ color: 'var(--color-muted)' }}>No updates yet.</p> : (
          <ol className="space-y-2">
            {updates.map((u) => (
              <li key={u.id} className="text-[12.5px] rounded-xl p-2.5" style={{ background: 'var(--color-surface-soft)' }}>
                {u.status && <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded mr-1.5" style={{ background: '#EEF2FF', color: '#4338CA' }}>{u.status}</span>}
                <span className="whitespace-pre-wrap">{u.body}</span>
                <div className="text-[11px] mt-1" style={{ color: 'var(--color-muted)' }}>{u.user_name || 'System'} · {fmtDateTime(u.created_at)}</div>
              </li>
            ))}
          </ol>
        )}
      </section>
      <LinkedTickets kind="incidents" column="major_incident_id" record={record} canEdit={canEdit} onChanged={onUpdated} />
    </div>
  );
}

export function ProblemPanel({ record, canEdit, onUpdated }) {
  return <div className="mb-5"><LinkedTickets kind="problems" column="problem_id" record={record} canEdit={canEdit} onChanged={onUpdated} /></div>;
}
