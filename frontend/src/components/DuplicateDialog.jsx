/* ------------------------------------------------------------------
   "This is already in the CRM" — everything the screens share.

   default  DuplicateHost    mounted once in the page layout. Shows the
                             pop-up when a create is answered "this already
                             exists", and a short confirmation after a merge.
            DuplicateHint    under a form's mobile / email boxes: says, while
                             the person is still typing, that the record is
                             already there.
            EnquiryHistory   every time a lead came in — first created, came
                             in again, a duplicate merged into it.
            SimilarBanner    on a record's page: other records with the same
                             mobile or email, with a link to merge them.
            RepeatBadge      the small "3×" chip in lists.

   The rule itself (merge / do not create / allow) is set in
   Settings → Duplicate Check & Merge and enforced by the server; this file
   only shows what the server found.
   ------------------------------------------------------------------ */

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, X, GitMerge, ExternalLink, Repeat, Phone, Mail, Building2, UserRound, Check, CopyPlus, History, Lock,
} from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

// ---- small helpers --------------------------------------------------------

// The server stores "2026-10-03 04:38:07" in UTC. Shown in the viewer's time.
function toDate(value) {
  if (!value) return null;
  const s = String(value);
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}
export function localWhen(value, { time = true } = {}) {
  const d = toDate(value);
  if (!d) return value ? String(value) : '';
  const day = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  if (!time) return day;
  return `${day}, ${d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`;
}
// "today" / "yesterday" / "" — for the line that matters most.
export function dayWord(value) {
  const d = toDate(value);
  if (!d) return '';
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(d)) / 86400000);
  return diff === 0 ? 'today' : diff === 1 ? 'yesterday' : '';
}

const MATCH_WORD = { mobile: 'Same mobile', email: 'Same email', name: 'Same name' };
const nice = (field) => String(field || '').replace(/_/g, ' ').replace(/^student name$/, 'name');
const timesText = (n) => (n === 2 ? 'twice' : `${n} times`);
export const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

// ---- one existing record ---------------------------------------------------
export function MatchCard({ match, selected, selectable, onSelect, compact = false }) {
  const Wrapper = selectable ? 'button' : 'div';
  return (
    <Wrapper type={selectable ? 'button' : undefined} onClick={selectable ? onSelect : undefined}
      className={`w-full text-left rounded-xl border p-3 flex gap-3 items-start transition-colors ${selectable ? 'cursor-pointer' : ''}`}
      style={{
        borderColor: selected ? 'var(--color-brand)' : 'var(--color-line)',
        background: selected ? 'var(--color-brand-faint, var(--color-canvas))' : 'var(--color-surface)',
      }}>
      {!compact && (
        <span className="w-10 h-10 rounded-xl shrink-0 flex items-center justify-center text-sm font-bold text-white"
          style={{ background: 'linear-gradient(135deg, #E879F9, #A21CAF)' }}>{initials(match.title)}</span>
      )}
      <span className="min-w-0 flex-1 block">
        <span className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-ink truncate">{match.title}</span>
          {match.status && (
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full"
              style={{ background: 'var(--color-neutral-soft, var(--color-canvas))', color: 'var(--color-muted)' }}>{match.status}</span>
          )}
          {match.converted && (
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full"
              style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-strong, var(--color-success))' }}>Converted</span>
          )}
          {match.times > 1 && <RepeatBadge count={match.times} lastAt={match.last_at} />}
        </span>
        <span className="flex items-center gap-x-3 gap-y-0.5 flex-wrap mt-1 text-xs text-slate-500">
          {match.mobile && <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" />{match.mobile}</span>}
          {match.email && <span className="inline-flex items-center gap-1 min-w-0"><Mail className="w-3 h-3 shrink-0" /><span className="truncate">{match.email}</span></span>}
          {match.company && <span className="inline-flex items-center gap-1"><Building2 className="w-3 h-3" />{match.company}</span>}
          {match.owner && <span className="inline-flex items-center gap-1"><UserRound className="w-3 h-3" />{match.owner}</span>}
        </span>
        <span className="flex items-center gap-1.5 flex-wrap mt-1.5">
          {(match.matched_on || []).map((k) => (
            <span key={k} className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
              style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong, var(--color-warning))' }}>
              {MATCH_WORD[k] || k}
            </span>
          ))}
          <span className="text-[11px] text-slate-400">
            Created {localWhen(match.created_at, { time: false })}{match.source ? ` · ${match.source}` : ''}
          </span>
        </span>
      </span>
      {/* A record this person's role does not show them: it is named (so they
          know it exists, and with whom) but cannot be opened. */}
      {match.hidden || !match.link ? (
        <span className="shrink-0 text-[11px] font-medium inline-flex items-center gap-1 px-2 py-1 rounded-lg" data-match-hidden
          style={{ background: 'var(--color-canvas)', color: 'var(--color-muted)' }} title="This record belongs to someone else">
          <Lock className="w-3 h-3" /> Not yours
        </span>
      ) : (
        <a href={match.link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
          className="shrink-0 text-xs font-medium inline-flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-[var(--color-canvas)]"
          style={{ color: 'var(--color-brand)' }} title="Open in a new tab">
          View <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </Wrapper>
  );
}

export function RepeatBadge({ count, lastAt }) {
  const n = Number(count) || 1;
  if (n < 2) return null;
  return (
    <span data-repeat-badge
      title={`Came in ${timesText(n)}${lastAt ? ` · last on ${localWhen(lastAt)}` : ''}`}
      className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0 align-middle"
      style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong, var(--color-warning))' }}>
      <Repeat className="w-2.5 h-2.5" />{n}×
    </span>
  );
}

// ---- the pop-up, mounted once ---------------------------------------------
export default function DuplicateHost() {
  const [ask, setAsk] = useState(null);         // { info, resolve }
  const [pick, setPick] = useState(null);
  const [merged, setMerged] = useState(null);   // the "merged" confirmation
  const navigate = useNavigate();
  const askRef = useRef(null);
  askRef.current = ask;

  useEffect(() => {
    const onAsk = (e) => {
      const d = e.detail;
      if (!d?.info) return;
      d.claimed = true;
      // Two forms cannot ask at once; a second question cancels the first.
      if (askRef.current) askRef.current.resolve({ choice: 'cancel' });
      setAsk({ info: d.info, resolve: d.resolve });
      // the first one this person may open, when there is one
      setPick((d.info.matches?.find((m) => !m.hidden) || d.info.matches?.[0])?.id ?? null);
    };
    const onMerged = (e) => setMerged(e.detail || null);
    window.addEventListener('icrm:duplicate', onAsk);
    window.addEventListener('icrm:duplicate-merged', onMerged);
    return () => {
      window.removeEventListener('icrm:duplicate', onAsk);
      window.removeEventListener('icrm:duplicate-merged', onMerged);
    };
  }, []);

  useEffect(() => {
    if (!merged) return undefined;
    const t = setTimeout(() => setMerged(null), 9000);
    return () => clearTimeout(t);
  }, [merged]);

  const answer = (choice) => {
    if (!ask) return;
    ask.resolve({ choice, id: pick });
    setAsk(null);
  };

  useEffect(() => {
    if (!ask) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') answer('cancel'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const info = ask?.info;
  const what = (info?.singular || 'record').toLowerCase();
  const chosen = info?.matches?.find((m) => m.id === pick) || info?.matches?.[0];
  const many = (info?.matches?.length || 0) > 1;

  return (
    <>
      {info && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" role="dialog" aria-modal="true"
          aria-label={`This ${what} already exists`} data-duplicate-dialog>
          <div className="absolute inset-0 bg-black/50" onClick={() => answer('cancel')} />
          <div className="card relative w-full max-w-xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="h-1 shrink-0" style={{ background: 'linear-gradient(90deg, #F59E0B, #D97706)' }} />
            <div className="flex items-start gap-3 px-5 pt-4 pb-3 shrink-0">
              <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong, var(--color-warning))' }}>
                <AlertTriangle className="w-5 h-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="t-section">This {what} is already in the CRM</h2>
                <p className="t-meta mt-0.5">
                  {many
                    ? `${info.matches.length} ${what}s have the same details. Choose the one to merge into.`
                    : `A ${what} with the same ${(chosen?.matched_on || []).map((k) => (k === 'mobile' ? 'mobile number' : k)).join(' and ') || 'details'} was found.`}
                </p>
              </div>
              <button type="button" onClick={() => answer('cancel')} aria-label="Close"
                className="text-[var(--color-faint)] hover:text-ink p-1 rounded-lg hover:bg-[var(--color-canvas)]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-5 pb-3 overflow-y-auto space-y-2">
              {info.matches.map((m) => (
                <MatchCard key={m.id} match={m} selectable={many} selected={many && m.id === pick} onSelect={() => setPick(m.id)} />
              ))}

              {chosen?.hidden ? (
                <div className="rounded-xl px-3 py-2.5 text-xs leading-relaxed mt-1" data-duplicate-not-yours
                  style={{ background: 'var(--color-canvas)', color: 'var(--color-muted)' }}>
                  <strong className="text-ink">{chosen.title}</strong> belongs to{' '}
                  <strong className="text-ink">{chosen.owner || 'someone else'}</strong>, so you cannot open it or merge into it.
                  {' '}Ask {chosen.owner || 'its owner'} or your manager.
                </div>
              ) : (
                <div className="rounded-xl px-3 py-2.5 text-xs leading-relaxed mt-1"
                  style={{ background: 'var(--color-canvas)', color: 'var(--color-muted)' }}>
                  <strong className="text-ink">Merge</strong> makes no second {what}.{' '}
                  {info.module === 'leads'
                    ? <><strong className="text-ink">{chosen?.title}</strong> will show that it came in again today, and its empty fields are filled from what you entered.</>
                    : <>The empty fields of <strong className="text-ink">{chosen?.title}</strong> are filled from what you entered.</>}
                  {' '}Nothing already on it is changed.
                </div>
              )}
              {info.blocked && (
                <div className="rounded-xl px-3 py-2 text-xs" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>
                  Creating a duplicate is switched off for {what}s.{chosen?.hidden ? '' : ' You can merge instead.'}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 flex-wrap px-5 py-3.5 border-t border-line shrink-0">
              {chosen?.link && !chosen.hidden ? (
                <button type="button" onClick={() => { const link = chosen?.link; answer('cancel'); if (link) navigate(link); }}
                  className="btn btn-ghost mr-auto" data-duplicate-open>
                  <ExternalLink className="w-4 h-4" /> Open existing
                </button>
              ) : (
                <button type="button" onClick={() => answer('cancel')} className="btn btn-ghost mr-auto" data-duplicate-cancel>Cancel</button>
              )}
              {info.can_create && (
                <button type="button" onClick={() => answer('create')} className="btn btn-secondary" data-duplicate-create>
                  <CopyPlus className="w-4 h-4" /> Create anyway
                </button>
              )}
              {info.can_merge && !chosen?.hidden && (
                <button type="button" onClick={() => answer('merge')} className="btn btn-primary" data-duplicate-merge autoFocus>
                  <GitMerge className="w-4 h-4" /> Merge into existing
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {merged && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[80] card shadow-2xl px-4 py-3 flex items-center gap-3 max-w-[92vw]"
          role="status" data-duplicate-merged>
          <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
            style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-strong, var(--color-success))' }}>
            <Check className="w-4 h-4" />
          </span>
          <div className="min-w-0 text-sm">
            <span className="text-ink font-medium">Merged into {merged.title}.</span>{' '}
            <span className="text-slate-500">
              No new {(merged.singular || 'record').toLowerCase()} was made
              {merged.filled?.length ? ` · filled in ${merged.filled.map(nice).join(', ')}` : ''}.
            </span>
          </div>
          {merged.link && (
            <button type="button" onClick={() => { const l = merged.link; setMerged(null); navigate(l); }}
              className="text-sm font-semibold shrink-0" style={{ color: 'var(--color-brand)' }}>Open</button>
          )}
          <button type="button" onClick={() => setMerged(null)} aria-label="Dismiss" className="text-slate-400 hover:text-ink shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </>
  );
}

// ---- while typing ----------------------------------------------------------
// values: { mobile, alternate_mobile, email, name }
export function DuplicateHint({ module, values, excludeId, what = 'lead' }) {
  const [matches, setMatches] = useState([]);
  const seq = useRef(0);
  const mobile = String(values?.mobile || '').trim();
  const alt = String(values?.alternate_mobile || '').trim();
  const email = String(values?.email || '').trim();
  const name = String(values?.name || '').trim();

  useEffect(() => {
    const digits = (v) => v.replace(/\D/g, '').length;
    const worth = digits(mobile) >= 8 || digits(alt) >= 8 || /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email) || name.length >= 3;
    const mine = ++seq.current;
    if (!worth) { setMatches([]); return undefined; }
    const t = setTimeout(() => {
      api.checkDuplicate(module, {
        mobile: digits(mobile) >= 8 ? mobile : undefined,
        alternate_mobile: digits(alt) >= 8 ? alt : undefined,
        email: email || undefined, name: name || undefined, exclude_id: excludeId,
      }).then((r) => { if (mine === seq.current) setMatches(r?.matches || []); })
        .catch(() => { if (mine === seq.current) setMatches([]); });
    }, 450);
    return () => clearTimeout(t);
  }, [module, mobile, alt, email, name, excludeId]);

  if (!matches.length) return null;
  return (
    <div className="rounded-xl border px-3 py-2.5 mt-3" data-duplicate-hint
      style={{ borderColor: 'var(--color-warning)', background: 'var(--color-warning-soft)' }}>
      <div className="flex items-center gap-1.5 text-xs font-semibold mb-2"
        style={{ color: 'var(--color-warning-strong, var(--color-warning))' }}>
        <AlertTriangle className="w-3.5 h-3.5" />
        {matches.length === 1 ? `This ${what} is already in the CRM` : `${matches.length} ${what}s like this are already in the CRM`}
      </div>
      <div className="space-y-1.5">
        {matches.slice(0, 3).map((m) => <MatchCard key={m.id} match={m} compact />)}
      </div>
      <p className="text-[11px] mt-2" style={{ color: 'var(--color-warning-strong, var(--color-warning))' }}>
        When you save, you will be asked whether to merge into it.
      </p>
    </div>
  );
}

// ---- a record's page -------------------------------------------------------
export function SimilarBanner({ module, recordId, items, what = 'lead' }) {
  // Leads already carry this on the record; other modules ask for it.
  const [list, setList] = useState(items || []);
  useEffect(() => {
    if (items) { setList(items); return undefined; }
    let live = true;
    api.duplicateHistory(module, recordId).then((r) => { if (live) setList(r?.similar || []); }).catch(() => {});
    return () => { live = false; };
  }, [module, recordId, items]);

  const { user } = useAuth();
  const limited = ['team', 'own'].includes(user?.permissions?.[module]?.scope);
  if (!list.length) return null;
  const on = [...new Set(list.flatMap((m) => m.matched_on || []))].map((k) => (k === 'mobile' ? 'mobile number' : k)).join(' or ');
  return (
    <div className="rounded-xl border px-4 py-2.5 mb-3 flex items-center gap-3 flex-wrap" data-similar-banner
      style={{ borderColor: 'var(--color-warning)', background: 'var(--color-warning-soft)' }}>
      <AlertTriangle className="w-4 h-4 shrink-0" style={{ color: 'var(--color-warning-strong, var(--color-warning))' }} />
      <div className="text-sm min-w-0 flex-1" style={{ color: 'var(--color-ink)' }}>
        <strong>Possible duplicate.</strong>{' '}
        {list.length === 1 ? `Another ${what} has` : `${list.length} other ${what}s have`} the same {on || 'details'}:{' '}
        {list.slice(0, 3).map((m, i) => (
          <span key={m.id}>
            {i > 0 && ', '}
            {m.hidden || !m.link
              ? <span className="font-medium" data-similar-hidden>{m.title}{m.owner ? ` (with ${m.owner})` : ''}</span>
              : <Link to={m.link} className="font-medium underline" style={{ color: 'var(--color-brand)' }}>{m.title}</Link>}
          </span>
        ))}
        {list.length > 3 && ` and ${list.length - 3} more`}.
      </div>
      {/* Reviewing duplicates goes through every record of the module, so it
          is for people whose role shows them all of it. */}
      {!limited && (
        <Link to={`/duplicates?module=${module}&focus=${recordId}`} className="btn btn-secondary shrink-0 !py-1.5 !text-xs">
          <GitMerge className="w-3.5 h-3.5" /> Review &amp; merge
        </Link>
      )}
    </div>
  );
}

// ---- every time a lead came in ----------------------------------------------
export function EnquiryHistory({ enquiries, sourceLabel = (v) => v, idPrefix = 'L-' }) {
  const list = [...(enquiries || [])].reverse();          // newest first
  if (!list.length) return null;
  const total = list.length;

  const title = (e) => {
    if (e.kind === 'again') return 'Came in again';
    if (e.kind === 'merged_record') return 'Also came in as a separate lead';
    return 'Lead created';
  };

  return (
    <div className="card p-4" data-enquiry-history>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-wide flex items-center gap-1.5">
          <History className="w-3.5 h-3.5" /> Enquiry history
        </h3>
        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
          style={total > 1
            ? { background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong, var(--color-warning))' }
            : { background: 'var(--color-canvas)', color: 'var(--color-muted)' }}>
          {total > 1 ? `Came in ${timesText(total)}` : 'Came in once'}
        </span>
      </div>

      <ol className="space-y-0">
        {list.map((e, i) => {
          const again = e.kind !== 'created' || !e.first;
          const word = dayWord(e.at);
          return (
            <li key={e.key} className="flex gap-3" data-enquiry={e.kind}>
              <div className="flex flex-col items-center shrink-0">
                <span className="w-6 h-6 rounded-full flex items-center justify-center mt-0.5"
                  style={e.first
                    ? { background: 'var(--color-brand-soft, var(--color-canvas))', color: 'var(--color-brand)' }
                    : { background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong, var(--color-warning))' }}>
                  {e.kind === 'merged_record' ? <GitMerge className="w-3 h-3" /> : again ? <Repeat className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                </span>
                {i < list.length - 1 && <span className="w-px flex-1 bg-line my-1" />}
              </div>
              <div className="min-w-0 pb-3.5 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm font-medium text-ink">{title(e)}</span>
                  {e.first && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--color-brand-soft, var(--color-canvas))', color: 'var(--color-brand)' }}>First time</span>
                  )}
                  {word && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-strong, var(--color-success))' }}>{word}</span>
                  )}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {localWhen(e.at)}
                  {e.source ? ` · ${sourceLabel(e.source)}` : ''}
                  {e.channel_label && !sameText(e.channel_label, e.source) && e.kind !== 'merged_record' ? ` · ${e.channel_label}` : ''}
                  {e.by && e.kind !== 'merged_record' ? ` · by ${e.by}` : ''}
                </div>
                {e.kind === 'merged_record' && e.was && (
                  <div className="text-xs text-slate-500 mt-0.5">
                    Was {idPrefix}{String(e.was.id).padStart(4, '0')} “{e.was.title}”
                    {e.was.mobile ? ` · ${e.was.mobile}` : ''}{e.was.email ? ` · ${e.was.email}` : ''}
                    {' — '}merged {localWhen(e.merged_at, { time: false })}{e.by ? ` by ${e.by}` : ''}
                  </div>
                )}
                {(e.matched_on?.length > 0 || e.filled?.length > 0) && e.kind === 'again' && (
                  <div className="text-xs text-slate-500 mt-0.5">
                    {e.matched_on?.length > 0 && `Matched on ${e.matched_on.map((k) => (k === 'mobile' ? 'mobile number' : k)).join(' and ')}`}
                    {e.matched_on?.length > 0 && e.filled?.length > 0 && ' · '}
                    {e.filled?.length > 0 && `filled in ${e.filled.map(nice).join(', ')}`}
                  </div>
                )}
                {e.note && (
                  <div className="text-xs mt-1 px-2 py-1 rounded-lg inline-block max-w-full break-words"
                    style={{ background: 'var(--color-canvas)', color: 'var(--color-ink)' }}>“{e.note}”</div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
