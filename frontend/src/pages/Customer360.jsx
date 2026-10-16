import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, TrendingUp, Wallet, Repeat, LifeBuoy, FileText, Users as UsersIcon,
  AlertTriangle, Activity, Info, Phone, Mail, Calendar, StickyNote, CheckSquare, Paperclip,
  Sparkles, Target, MessageCircle, Globe, Network, History, Plus, Trophy,
} from 'lucide-react';
import { api } from '../api';
import {
  Badge, Avatar, SkeletonCards, ErrorState, EmptyState, friendlyError,
} from '../components/ui';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const dt = (v) => (v ? String(v).slice(0, 10) : '—');

const scoreTone = (s) => (s >= 80 ? 'success' : s >= 60 ? 'info' : s >= 40 ? 'warning' : 'danger');
const TONE_HEX = {
  success: 'var(--color-success)', info: 'var(--color-info)',
  warning: 'var(--color-warning)', danger: 'var(--color-danger)',
};

// Big score dial with the band underneath. Deliberately shows the raw
// number — an unexplained letter grade is worse than a number you can
// click into.
function ScoreRing({ score, band, label, tone }) {
  const colour = TONE_HEX[tone] || TONE_HEX.info;
  return (
    <div className="flex items-center gap-3">
      <div className="relative w-16 h-16 shrink-0">
        <svg viewBox="0 0 36 36" className="w-16 h-16 -rotate-90" aria-hidden="true">
          <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--color-line)" strokeWidth="3" />
          <circle cx="18" cy="18" r="15.9" fill="none" stroke={colour} strokeWidth="3"
            strokeDasharray={`${score}, 100`} strokeLinecap="round" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-lg font-bold" style={{ color: colour }}>{score}</span>
        </div>
      </div>
      <div>
        <div className="t-meta">{label}</div>
        <div className="text-sm font-semibold" style={{ color: colour }}>{band}</div>
      </div>
    </div>
  );
}


// Score ring sized and coloured for the gradient hero. The page's other
// ring assumes a white background, so its greys disappear here.
function HeroScore({ score, band, label }) {
  const r = 22, c = 2 * Math.PI * r, pct = Math.max(0, Math.min(100, score || 0));
  const colour = /excellent|healthy/i.test(band) ? '#6EE7B7'
    : /needs attention/i.test(band) ? '#FDE68A' : '#FCA5A5';
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative" style={{ width: 52, height: 52 }}>
        <svg width={52} height={52} className="-rotate-90">
          <circle cx={26} cy={26} r={r} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth={5} />
          <circle cx={26} cy={26} r={r} fill="none" stroke={colour} strokeWidth={5}
            strokeDasharray={c} strokeDashoffset={c - (pct / 100) * c} strokeLinecap="round" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-sm font-bold text-white">{score}</div>
      </div>
      <div className="leading-tight">
        <div className="text-[10px] text-white/65 whitespace-nowrap">{label}</div>
        <div className="text-xs font-semibold whitespace-nowrap" style={{ color: colour }}>{band}</div>
      </div>
    </div>
  );
}


// Commercial tile with real weight: a gradient icon chip and a
// colour-matched top accent, matching the dashboard KPIs. The shared
// KpiCard renders a flat pale chip, which is what made this row read as
// six grey boxes.
function CommercialTile({ label, value, icon: Icon, from, to }) {
  return (
    <div className="relative bg-white border border-line rounded-2xl p-4 pt-5 overflow-hidden hover:shadow-lg hover:-translate-y-0.5 transition-all">
      <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ background: `linear-gradient(90deg, ${from}, ${to})` }} />
      <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white shadow-sm mb-3"
        style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}>
        <Icon className="w-[18px] h-[18px]" />
      </div>
      <div className="text-[22px] font-bold text-ink leading-none tabular-nums tracking-tight">{value}</div>
      <div className="text-[11px] text-slate-500 mt-2 uppercase tracking-wide font-medium">{label}</div>
    </div>
  );
}


// Empty state for a section. Compact by design: an empty section should
// occupy the space its emptiness deserves, not the same height as a full
// one. The tinted disc ties it to the section's own colour so the page
// keeps its rhythm instead of going grey wherever there's no data.
function SectionEmpty({ icon: Icon, text, tint = '#6D28D9' }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: `${tint}12`, color: tint }}>
        {Icon ? <Icon className="w-4 h-4" /> : null}
      </span>
      <span className="text-sm text-slate-400">{text}</span>
    </div>
  );
}

// The explainability table from the brief: component, weight, contribution,
// and the concrete positives/negatives behind each one.
function ScoreBreakdown({ scoring }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: '#6D28D91A', color: '#6D28D9' }}>
            <Info className="w-4 h-4" />
          </span>
          <div>
            <h2 className="t-section">How this score is calculated</h2>
            <p className="t-meta">{scoring.score}/100 · {scoring.band} — weighted across {scoring.components?.length || 0} factors</p>
          </div>
        </div>
        <button onClick={() => setOpen((o) => !o)} className="btn btn-secondary">
          <Info className="w-4 h-4" /> {open ? 'Hide' : 'Why this score?'}
        </button>
      </div>

      {open && (
        <div className="mt-4 pt-4 border-t border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-line">
                <th className="py-2 t-meta font-semibold">Component</th>
                <th className="py-2 t-meta font-semibold text-right">Score</th>
                <th className="py-2 t-meta font-semibold text-right">Weight</th>
                <th className="py-2 t-meta font-semibold text-right">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {scoring.components.map((c) => (
                <tr key={c.component} className="border-b border-line/60 align-top">
                  <td className="py-2.5">
                    <div className="text-ink font-medium">{c.component}</div>
                    <div className="mt-1 space-y-0.5">
                      {c.positives.map((p, i) => (
                        <div key={`p${i}`} className="text-xs" style={{ color: 'var(--color-success)' }}>+ {p}</div>
                      ))}
                      {c.negatives.map((n, i) => (
                        <div key={`n${i}`} className="text-xs" style={{ color: 'var(--color-danger)' }}>− {n}</div>
                      ))}
                    </div>
                  </td>
                  <td className="py-2.5 text-right tabular-nums">{c.score}</td>
                  <td className="py-2.5 text-right tabular-nums text-[var(--color-muted)]">{c.weight}%</td>
                  <td className="py-2.5 text-right tabular-nums font-medium">{c.contribution}</td>
                </tr>
              ))}
              <tr>
                <td className="py-2.5 font-semibold text-ink" colSpan={3}>Final score</td>
                <td className="py-2.5 text-right font-bold text-ink tabular-nums">{scoring.score}</td>
              </tr>
            </tbody>
          </table>
          <p className="t-meta mt-3">
            Calculated from this account's real records. Components with no data score low rather than being estimated.
          </p>
        </div>
      )}
    </div>
  );
}

const SECTION_TINTS = {
  'Next best action': '#6D28D9',
  'AI Customer Summary': '#7C3AED',
  'Relationship map': '#0D9488',
  Contacts: '#0D9488',
  Opportunities: '#D97706',
  Quotations: '#0891B2',
  Subscriptions: '#059669',
  Tickets: '#E11D48',
  'Open tasks': '#4F46E5',
  Documents: '#475569',
  Notes: '#CA8A04',
  'Audit history': '#64748B',
  'Activity timeline': '#2563EB',
};

const PRIMARY_SECTIONS = new Set(['Next best action', 'AI Customer Summary']);

function Section({ title, icon: Icon, count, children, action }) {
  const tint = SECTION_TINTS[title] || '#6D28D9';
  const primary = PRIMARY_SECTIONS.has(title);
  return (
    <div className="card p-4 relative overflow-hidden transition-shadow hover:shadow-md"
      style={primary ? { boxShadow: '0 8px 28px rgba(109,40,217,0.10)' } : undefined}>
      {primary && (
        <div aria-hidden="true" className="absolute top-0 left-0 right-0 h-[3px]"
          style={{ background: `linear-gradient(90deg, ${tint}, #A78BFA)` }} />
      )}
      <div className="flex items-center justify-between mb-3 pb-2.5 border-b border-line">
        <h2 className="t-section flex items-center gap-2">
          {Icon && (
            <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: `${tint}1A`, color: tint }}>
              <Icon className="w-4 h-4" />
            </span>
          )}
          {title}
          {count !== undefined && <span className="t-meta">({count})</span>}
        </h2>
        {action}
      </div>
      {children}
    </div>
  );
}

const TIMELINE_ICON = { call: Phone, meeting: Calendar, note: StickyNote, email: Mail };


// AI customer summary (§20). Grounded server-side in this account's records.
// When the AI service is unavailable this shows a professional error state
// rather than any fabricated output.
function AiSummaryPanel({ accountId }) {
  const [summary, setSummary] = useState('');
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const run = async (q) => {
    setLoading(true); setError(null); setSummary('');
    try {
      const r = await api.aiCustomerSummary(accountId, q);
      setSummary(r.summary);
    } catch (e) {
      setError(friendlyError(e, 'The AI summary is unavailable right now.'));
    } finally { setLoading(false); }
  };

  const SUGGESTED = ['Summarize this customer', 'What happened recently?',
                     'What should I do next?', 'Which opportunities are at risk?'];

  return (
    <div className="card p-4 relative overflow-hidden transition-shadow hover:shadow-md"
      style={{ boxShadow: '0 8px 28px rgba(109,40,217,0.10)' }}>
      <div aria-hidden="true" className="absolute top-0 left-0 right-0 h-[3px]"
        style={{ background: 'linear-gradient(90deg, #7C3AED, #A78BFA)' }} />
      <h2 className="t-section flex items-center gap-2">
        <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: '#7C3AED1A', color: '#7C3AED' }}>
          <Sparkles className="w-4 h-4" />
        </span>
        AI Customer Summary
      </h2>
      <p className="t-meta mb-3 mt-1.5 pb-2.5 border-b border-line">Grounded in this account's own records.</p>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {SUGGESTED.map((q) => (
          <button key={q} onClick={() => { setQuestion(q); run(q); }} disabled={loading}
            className="text-xs px-2.5 py-1 rounded-full border border-line text-[var(--color-muted)] hover:bg-[var(--color-canvas)] disabled:opacity-50">
            {q}
          </button>
        ))}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); run(question); }} className="flex gap-2">
        <input className="input" value={question} onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask something about this customer…" aria-label="Ask about this customer" />
        <button type="submit" disabled={loading} className="btn btn-primary disabled:opacity-50">
          {loading ? 'Thinking…' : 'Ask'}
        </button>
      </form>

      {error && (
        <div className="mt-3 rounded-lg px-3 py-2.5" style={{ background: 'var(--color-warning-soft)' }}>
          <p className="text-sm font-medium" style={{ color: 'var(--color-warning)' }}>{error.message}</p>
          <p className="t-meta mt-1">Everything else on this page is unaffected — it comes from your CRM data, not the AI service.</p>
        </div>
      )}

      {summary && (
        <div className="mt-3 text-sm text-ink whitespace-pre-wrap leading-relaxed">{summary}</div>
      )}
    </div>
  );
}


// §23 — add a note directly from Customer 360, using the existing notes
// API rather than a new endpoint.
function NoteComposer({ accountId, onAdded }) {
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!body.trim()) return;
    setSaving(true); setError('');
    try {
      await api.addNote('accounts', accountId, body.trim());
      setBody('');
      onAdded?.();
    } catch (err) {
      setError(friendlyError(err, 'Could not save the note.').message);
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={submit}>
      <textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)}
        placeholder="Add a note about this customer…" aria-label="Add a note" />
      {error && <p className="text-xs mt-1" style={{ color: 'var(--color-danger)' }}>{error}</p>}
      <button type="submit" disabled={saving || !body.trim()} className="btn btn-primary mt-2 disabled:opacity-50">
        <Plus className="w-4 h-4" /> {saving ? 'Saving…' : 'Add note'}
      </button>
    </form>
  );
}

export default function Customer360() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = () => {
    setError(null);
    return api.customer360(id)
      .then(setData)
      .catch((e) => setError(friendlyError(e, 'Unable to load this account.')))
      .finally(() => setLoading(false));
  };
  useEffect(() => { setLoading(true); load(); }, [id]);

  if (loading) return <div className="w-full"><SkeletonCards count={4} /></div>;
  if (error) return (
    <div className="w-full">
      <ErrorState message={error.message} detail={error.detail} onRetry={() => { setLoading(true); load(); }} />
    </div>
  );

  const { account, scoring, commercial, contacts, opportunities, quotations,
          subscriptions, tickets, documents, tasks, timeline, attention,
          relationship_map: relationshipMap = {}, next_best_actions: nextBest = [],
          audit = [] } = data;
  const primary = contacts[0];
  const contactsPrimary = primary ? `${primary.first_name} ${primary.last_name || ''}`.trim() : null;

  const C360 = { from: '#6366F1', to: '#7C3AED', solid: '#6D28D9' };

  return (
    <div className="relative rounded-3xl -m-4 sm:-m-6 p-4 sm:p-6">
      <div aria-hidden="true" className="absolute inset-0 z-0 overflow-hidden rounded-3xl pointer-events-none">
        <div className="absolute inset-0" style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, ${C360.solid}33 1px, transparent 0)`,
          backgroundSize: '22px 22px',
        }} />
        <div className="absolute -top-32 -right-28 w-[560px] h-[560px] rounded-full" style={{
          background: `radial-gradient(circle, ${C360.solid}42, transparent 70%)`,
        }} />
        <div className="absolute -bottom-40 -left-28 w-[500px] h-[500px] rounded-full" style={{
          background: `radial-gradient(circle, ${C360.from}38, transparent 70%)`,
        }} />
      </div>

      <div className="relative z-10">
      <button onClick={() => navigate('/records/accounts')} className="btn btn-ghost mb-3 -ml-2">
        <ArrowLeft className="w-4 h-4" /> Accounts
      </button>

      {/* Gradient hero — the one place in the product that uses a solid
          colour block, marking Customer 360 as a distinct surface from the
          white record pages. */}
      <div className="rounded-2xl p-6 mb-4 relative overflow-hidden"
        style={{ background: `linear-gradient(135deg, ${C360.from}, ${C360.to})` }}>
        <div aria-hidden="true" className="absolute inset-0 opacity-[0.09]" style={{
          backgroundImage: 'radial-gradient(circle at 2px 2px, white 1px, transparent 0)', backgroundSize: '22px 22px',
        }} />
        {/* Depth: a soft light source top-left and a darker pool bottom-right
            turn a flat colour block into a lit surface. */}
        <div aria-hidden="true" className="absolute inset-0" style={{
          background: 'radial-gradient(ellipse 700px 300px at 10% -10%, rgba(255,255,255,0.22), transparent 60%), radial-gradient(ellipse 600px 400px at 100% 120%, rgba(0,0,0,0.28), transparent 60%)',
        }} />

        <div className="relative flex items-start justify-between flex-wrap gap-6">
          <div className="flex items-start gap-4 min-w-0">
            <div className="w-16 h-16 rounded-2xl bg-white/15 backdrop-blur border border-white/25 flex items-center justify-center text-white font-bold text-xl shrink-0 shadow-lg">
              {String(account.account_name || '?').split(' ').filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold text-white/70 uppercase tracking-wider mb-1">Customer 360</div>
              <h1 className="text-2xl font-bold text-white leading-tight">{account.account_name}</h1>
              <p className="text-sm text-white/80 mt-1">
                {[account.account_type, account.industry, account.city].filter(Boolean).join(' · ')}
              </p>
              <div className="flex items-center flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-white/75">
                {contactsPrimary && <span>Primary contact · <span className="text-white font-medium">{contactsPrimary}</span></span>}
                {account.phone && <span>{account.phone}</span>}
                {account.email && <span className="truncate">{account.email}</span>}
              </div>
            </div>
          </div>

          {/* The two scores belong IN the hero — they are the reason this
              page exists. Previously they sat in a separate white card with
              a wide empty gap between the rings and the button. */}
          {scoring && (
            <div className="relative flex items-center gap-5 shrink-0 rounded-2xl px-5 py-3 bg-white/12 backdrop-blur border border-white/20">
              <HeroScore score={scoring.score} band={scoring.band} label="Account Score" />
              {scoring.health && <div className="w-px h-12 bg-white/20" />}
              {scoring.health && <HeroScore score={scoring.health.score} band={scoring.health.band} label="Customer Health" />}
            </div>
          )}

          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
            {account.phone && (
              <a href={`tel:${account.phone}`} className="bg-white/15 hover:bg-white/25 border border-white/25 text-white text-sm font-medium px-3 py-2 rounded-xl inline-flex items-center gap-1.5">
                <Phone className="w-4 h-4" /> Call
              </a>
            )}
            {account.email && (
              <a href={`mailto:${account.email}`} className="bg-white/15 hover:bg-white/25 border border-white/25 text-white text-sm font-medium px-3 py-2 rounded-xl inline-flex items-center gap-1.5">
                <Mail className="w-4 h-4" /> Email
              </a>
            )}
            {(account.whatsapp || account.phone) && (
              <a href={`https://wa.me/${String(account.whatsapp || account.phone).replace(/\D/g, '')}`}
                target="_blank" rel="noreferrer"
                className="bg-white/15 hover:bg-white/25 border border-white/25 text-white text-sm font-medium px-3 py-2 rounded-xl inline-flex items-center gap-1.5">
                <MessageCircle className="w-4 h-4" /> WhatsApp
              </a>
            )}
            {account.website && (
              <a href={/^https?:/.test(account.website) ? account.website : `https://${account.website}`}
                target="_blank" rel="noreferrer"
                className="bg-white/15 hover:bg-white/25 border border-white/25 text-white text-sm font-medium px-3 py-2 rounded-xl inline-flex items-center gap-1.5">
                <Globe className="w-4 h-4" /> Website
              </a>
            )}
            <Link to={`/records/accounts/${account.id}`}
              className="bg-white text-sm font-semibold px-4 py-2 rounded-xl inline-flex items-center gap-1.5"
              style={{ color: C360.to }}>
              Open record
            </Link>
          </div>
        </div>
      </div>


      {attention.length > 0 && (
        <div className="rounded-2xl p-4 mb-4 relative overflow-hidden border border-line"
          style={{ background: 'linear-gradient(100deg, #FFFBEB, #FFFFFF 55%)', boxShadow: '0 6px 20px rgba(217,119,6,0.10)' }}>
          <div aria-hidden="true" className="absolute inset-y-0 left-0 w-1"
            style={{ background: 'linear-gradient(180deg, #FBBF24, #D97706)' }} />
          <div className="flex items-start gap-3 pl-2">
            <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-white shadow-sm"
              style={{ background: 'linear-gradient(135deg, #FBBF24, #D97706)' }}>
              <AlertTriangle className="w-4 h-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="t-section">Attention required</h2>
              <ul className="mt-2 space-y-1.5">
                {attention.map((a, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm">
                    <Badge tone={a.severity === 'high' ? 'danger' : a.severity === 'medium' ? 'warning' : 'neutral'} size="xs">
                      {a.severity}
                    </Badge>
                    <span className="text-ink">{a.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <div className="mb-4"><ScoreBreakdown scoring={scoring} /></div>

      <h2 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-3">Commercial snapshot</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <CommercialTile label="Won business" value={inr(commercial.won_value)} icon={Trophy} from="#6EE7B7" to="#047857" />
        <CommercialTile label="Open pipeline" value={inr(commercial.open_pipeline)} icon={TrendingUp} from="#93C5FD" to="#1D4ED8" />
        <CommercialTile label="Weighted" value={inr(commercial.weighted_pipeline)} icon={Target} from="#C4B5FD" to="#6D28D9" />
        <CommercialTile label="MRR" value={inr(commercial.mrr)} icon={Repeat} from="#5EEAD4" to="#0F766E" />
        <CommercialTile label="Collected" value={inr(commercial.paid_total)} icon={Wallet} from="#A3E635" to="#4D7C0F" />
        <CommercialTile label="Open quotes" value={commercial.open_quotes} icon={FileText} from="#FCD34D" to="#B45309" />
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4 items-start">
        <Section title="Next best action" icon={Target}>
          {nextBest.length === 0 ? (
            <p className="t-meta">Nothing needs attention right now.</p>
          ) : (
            <ol className="space-y-2">
              {nextBest.map((a, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5"
                    style={{ background: a.priority <= 2 ? 'var(--color-danger-soft)' : 'var(--color-neutral-soft)',
                             color: a.priority <= 2 ? 'var(--color-danger)' : 'var(--color-neutral)' }}>{i + 1}</span>
                  <div className="min-w-0">
                    {a.link
                      ? <Link to={a.link} className="text-sm text-ink font-medium hover:text-[var(--color-brand)]">{a.action}</Link>
                      : <span className="text-sm text-ink font-medium">{a.action}</span>}
                    <div className="t-meta">{a.reason}</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Section>

        <AiSummaryPanel accountId={id} />
      </div>

      {Object.keys(relationshipMap).length > 0 && (
        <div className="mb-4">
          <Section title="Relationship map" icon={Network} count={contacts.length}>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {Object.entries(relationshipMap).map(([role, people]) => (
                <div key={role}>
                  <div className="t-meta font-semibold uppercase tracking-wide mb-1.5">{role}</div>
                  <div className="space-y-1.5">
                    {people.map((c) => (
                      <Link key={c.id} to={`/records/contacts/${c.id}`} className="flex items-center gap-2 group">
                        <Avatar name={`${c.first_name} ${c.last_name || ''}`} size="sm" />
                        <div className="min-w-0">
                          <div className="text-sm text-ink truncate group-hover:text-[var(--color-brand)]">
                            {c.first_name} {c.last_name}
                          </div>
                          <div className="t-meta truncate">{c.job_title || '—'}</div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <Section title="Contacts" icon={UsersIcon} count={contacts.length}>
          {contacts.length === 0 ? <p className="t-meta">No contacts yet.</p> : (
            <div className="space-y-2">
              {contacts.map((c) => (
                <Link key={c.id} to={`/records/contacts/${c.id}`}
                  className="flex items-center gap-3 p-2 -mx-2 rounded-lg hover:bg-[var(--color-canvas)]">
                  <Avatar name={`${c.first_name} ${c.last_name || ''}`} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-ink font-medium truncate">{c.first_name} {c.last_name}</div>
                    <div className="t-meta truncate">{c.job_title || c.email || c.mobile || '—'}</div>
                  </div>
                  {c.contact_status && <Badge status={c.contact_status} size="xs">{c.contact_status}</Badge>}
                </Link>
              ))}
            </div>
          )}
        </Section>

        <Section title="Opportunities" icon={TrendingUp} count={opportunities.length}>
          {opportunities.length === 0 ? <p className="t-meta">No opportunities yet.</p> : (
            <div className="space-y-2">
              {opportunities.map((o) => (
                <Link key={o.id} to={`/records/opportunities/${o.id}`}
                  className="flex items-center justify-between gap-3 p-2 -mx-2 rounded-lg hover:bg-[var(--color-canvas)]">
                  <div className="min-w-0">
                    <div className="text-sm text-ink font-medium truncate">{o.opportunity_name}</div>
                    <div className="t-meta">{o.stage || '—'} · close {dt(o.expected_close_date)}</div>
                  </div>
                  <span className="text-sm font-medium tabular-nums shrink-0">{inr(o.amount)}</span>
                </Link>
              ))}
            </div>
          )}
        </Section>

        <Section title="Quotations" icon={FileText} count={quotations.length}>
          {quotations.length === 0 ? <p className="t-meta">No quotations yet.</p> : (
            <div className="space-y-2">
              {quotations.map((q) => (
                <Link key={q.id} to={`/records/quotations/${q.id}`}
                  className="flex items-center justify-between gap-3 p-2 -mx-2 rounded-lg hover:bg-[var(--color-canvas)]">
                  <div className="min-w-0">
                    <div className="text-sm text-ink font-medium">{q.quote_number}</div>
                    <div className="t-meta">{dt(q.quote_date)}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-sm tabular-nums">{inr(q.grand_total)}</span>
                    <Badge status={q.status} size="xs">{q.status}</Badge>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Section>

        <Section title="Subscriptions" icon={Repeat} count={subscriptions.length}>
          {subscriptions.length === 0 ? <SectionEmpty icon={Repeat} tint="#059669" text="No active subscriptions." /> : (
            <div className="space-y-2">
              {subscriptions.map((s) => (
                <Link key={s.id} to={`/records/subscriptions/${s.id}`}
                  className="flex items-center justify-between gap-3 p-2 -mx-2 rounded-lg hover:bg-[var(--color-canvas)]">
                  <div className="min-w-0">
                    <div className="text-sm text-ink font-medium truncate">{s.plan || s.subscription_number}</div>
                    <div className="t-meta">Renews {dt(s.renewal_date)}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-sm tabular-nums">{inr(s.recurring_amount)}</span>
                    <Badge status={s.status} size="xs">{s.status}</Badge>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Section>

        <Section title="Tickets" icon={LifeBuoy} count={tickets.length}>
          {tickets.length === 0 ? <p className="t-meta">No tickets.</p> : (
            <div className="space-y-2">
              {tickets.slice(0, 8).map((t) => (
                <Link key={t.id} to={`/records/tickets/${t.id}`}
                  className="flex items-center justify-between gap-3 p-2 -mx-2 rounded-lg hover:bg-[var(--color-canvas)]">
                  <div className="min-w-0">
                    <div className="text-sm text-ink font-medium truncate">{t.subject}</div>
                    <div className="t-meta">{t.ticket_number} · {dt(t.created_at)}</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge status={t.priority} size="xs">{t.priority}</Badge>
                    <Badge status={t.status} size="xs">{t.status}</Badge>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Section>

        <Section title="Open tasks" icon={CheckSquare} count={tasks.length}>
          {tasks.length === 0 ? <SectionEmpty icon={CheckSquare} tint="#4F46E5" text="Nothing outstanding." /> : (
            <div className="space-y-2">
              {tasks.map((t) => (
                <Link key={t.id} to={`/records/tasks/${t.id}`} className="flex items-center justify-between gap-3 p-2 -mx-2 rounded-lg hover:bg-[var(--color-canvas)]" data-testid="c360-task">
                  <div className="min-w-0">
                    <div className="text-sm text-ink truncate">{t.task_title}</div>
                    <div className="t-meta">Due {dt(t.due_date)}</div>
                  </div>
                  <Badge status={t.priority} size="xs">{t.priority}</Badge>
                </Link>
              ))}
            </div>
          )}
        </Section>

        <Section title="Documents" icon={Paperclip} count={documents.length}>
          {documents.length === 0 ? <SectionEmpty icon={Paperclip} tint="#475569" text="No documents attached." /> : (
            <div className="space-y-2">
              {documents.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-3 p-2 -mx-2">
                  <span className="text-sm text-ink truncate">{d.title}</span>
                  {d.external_url
                    ? <a href={d.external_url} target="_blank" rel="noreferrer" className="text-xs text-[var(--color-brand)] shrink-0">Open</a>
                    : <button onClick={() => api.downloadDocument(d.id, d.file_name).catch((e) => alert(e.message))}
                        className="text-xs text-[var(--color-brand)] shrink-0">Download</button>}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Notes" icon={StickyNote}>
          <NoteComposer accountId={id} onAdded={load} />
        </Section>

        <Section title="Audit history" icon={History} count={audit.length}>
          {audit.length === 0 ? <SectionEmpty icon={History} tint="#64748B" text="No changes recorded yet." /> : (
            <div className="space-y-2 max-h-[300px] overflow-y-auto thin-scroll">
              {audit.map((a, i) => (
                <div key={i} className="text-sm">
                  <span className="text-ink">
                    {a.user_name || 'Someone'}{' '}
                    {a.action === 'created' ? 'created this account'
                      : a.action === 'field_changed' ? <>changed <span className="font-medium">{a.field_api_name}</span></>
                      : a.action}
                  </span>
                  {a.action === 'field_changed' && (
                    <span className="t-meta"> — <span className="line-through opacity-60">{a.old_value || 'empty'}</span> → {a.new_value || 'empty'}</span>
                  )}
                  <div className="t-meta">{a.created_at}</div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Activity timeline" icon={Activity} count={timeline.length}>
          {timeline.length === 0 ? (
            <EmptyState icon={Activity} title="Nothing logged yet"
              description="Calls, meetings, notes and emails against this account appear here." />
          ) : (
            <div className="space-y-3 max-h-[420px] overflow-y-auto thin-scroll">
              {timeline.map((t) => {
                const Icon = TIMELINE_ICON[t.type] || Activity;
                // each item opens its own record (v1.3.1)
                const to = { call: 'calls', meeting: 'meetings', note: 'notes', email: 'emails' }[t.type];
                const Row = to ? Link : 'div';
                return (
                  <Row key={`${t.type}-${t.id}`} {...(to ? { to: `/records/${to}/${t.id}` } : {})} className="flex gap-3 rounded-lg p-1 -m-1 hover:bg-[var(--color-canvas)]" data-testid="c360-timeline-item">
                    <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
                      style={{ background: 'var(--color-neutral-soft)', color: 'var(--color-neutral)' }}>
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-ink">{t.title}</div>
                      <div className="t-meta">
                        {t.type}{t.detail ? ` · ${t.detail}` : ''}
                        {t.duration_seconds ? ` · ${Math.round(t.duration_seconds / 60)}m` : ''} · {dt(t.at)}
                      </div>
                    </div>
                  </Row>
                );
              })}
            </div>
          )}
        </Section>
      </div>
      </div>
    </div>
  );
}
