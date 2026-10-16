/* My leave (v1.3): ask for leave, see what was approved, cancel. */
import { useCallback, useEffect, useState } from 'react';
import { CalendarOff, Plus, Loader2, Send } from 'lucide-react';
import { useApp } from '../lib/app';
import { GET, POST } from '../lib/api';
import { newRef } from '../lib/outbox';
import { niceDate, today, addDays } from '../lib/format';
import { TopBar, BottomNav, Loading, Empty, Field, Sheet, StatusBars, VoiceArea } from '../components/ui';

export const LEAVE_STATUS = { pending: ['Waiting', 'info'], approved: ['Approved', 'ok'], rejected: ['Not approved', 'bad'], cancelled: ['Cancelled', ''] };
export const leaveSpan = (l) => (l.from_day === l.to_day ? `${niceDate(l.from_day)}${l.half_day ? ' · half day' : ''}` : `${niceDate(l.from_day)} – ${niceDate(l.to_day)} · ${l.days} days`);

export default function Leave() {
  const { boot, say } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const [form, setForm] = useState({ leave_type: '', from_day: addDays(today(), 1), to_day: addDays(today(), 1), half_day: false, reason: '' });
  const [busy, setBusy] = useState('');
  const [ref, setRef] = useState(() => newRef('lv'));
  const load = useCallback(() => { GET('/sfa/leaves/mine').then((x) => { setData(x); setForm((f) => ({ ...f, leave_type: f.leave_type || x.types[0] })); }).catch((e) => setError(e.offline ? 'No internet: leave needs the internet.' : e.message)); }, []);
  useEffect(() => { load(); }, [load]);
  if (!boot.sfa.enabled || !boot.sfa.leave_on) return <div className="screen"><TopBar title="Leave" /><Empty title="Leave requests are not switched on." /><BottomNav /></div>;
  const send = async () => {
    setError(''); setBusy('send');
    try {
      await POST('/sfa/leaves', { ...form, to_day: form.half_day ? form.from_day : form.to_day, client_ref: ref });
      say(data && data.has_manager ? 'Sent to your manager.' : 'Leave asked.', 'ok');
      setAsking(false); setRef(newRef('lv')); setForm((f) => ({ ...f, reason: '' }));
      load();
    } catch (e) { setError(e.offline ? 'No internet: try again when online.' : e.message); } finally { setBusy(''); }
  };
  const cancel = async (l) => {
    if (!window.confirm('Cancel this leave?')) return;
    setBusy(`c${l.id}`);
    try { await POST(`/sfa/leaves/${l.id}/cancel`); say('Leave cancelled.', 'ok'); load(); } catch (e) { say(e.message, 'error'); } finally { setBusy(''); }
  };
  const used = data ? Object.entries(data.used || {}) : [];
  return (
    <div className="screen">
      <TopBar title="My leave" />
      <StatusBars />
      <div className="body" data-testid="leave-screen">
        {error && !asking && <div className="note bad">{error}</div>}
        <button type="button" className="btn primary block big" onClick={() => setAsking(true)} disabled={!data} data-testid="leave-ask"><Plus size={18} /> Ask for leave</button>
        {used.length > 0 && <div className="chips" data-testid="leave-used">{used.map(([k, n]) => <span key={k} className="chip">{k}: {n} day{n === 1 ? '' : 's'}</span>)}</div>}
        {!data && !error ? <Loading /> : data && (!data.leaves.length ? <Empty icon={CalendarOff} title="No leave asked yet" /> : (
          <div className="list" data-testid="leave-list">
            {data.leaves.map((l) => (
              <div key={l.id} className="row" data-testid="leave-row">
                <div className="main">
                  <div className="title">{l.leave_type}</div>
                  <div className="line">{leaveSpan(l)}</div>
                  {l.reason && <div className="line">{l.reason}</div>}
                  {l.decision_note && <div className="line" style={{ color: l.status === 'rejected' ? 'var(--bad)' : 'inherit' }}>“{l.decision_note}”{l.decided_by_name ? ` — ${l.decided_by_name}` : ''}</div>}
                </div>
                <div className="end col" style={{ alignItems: 'flex-end', gap: 6 }}>
                  <span className={`tag ${LEAVE_STATUS[l.status][1]}`}>{LEAVE_STATUS[l.status][0]}</span>
                  {l.can_cancel && <button type="button" className="btn small ghost" onClick={() => cancel(l)} disabled={!!busy} data-testid="leave-cancel">Cancel</button>}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {asking && data && (
        <Sheet title="Ask for leave" onClose={() => setAsking(false)}>
          <div className="col" style={{ gap: 12 }} data-testid="leave-form">
            <Field label="Kind of leave">
              <select className="input" value={form.leave_type} onChange={(e) => setForm({ ...form, leave_type: e.target.value })} data-testid="leave-type">{data.types.map((t) => <option key={t} value={t}>{t}</option>)}</select>
            </Field>
            <label className="toggle"><input type="checkbox" checked={form.half_day} onChange={(e) => setForm({ ...form, half_day: e.target.checked })} data-testid="leave-half" /> Half a day</label>
            <div className="grid2">
              <Field label={form.half_day ? 'Day' : 'From'}><input className="input" type="date" value={form.from_day} onChange={(e) => setForm({ ...form, from_day: e.target.value, to_day: form.to_day < e.target.value ? e.target.value : form.to_day })} data-testid="leave-from" /></Field>
              {!form.half_day && <Field label="To"><input className="input" type="date" min={form.from_day} value={form.to_day} onChange={(e) => setForm({ ...form, to_day: e.target.value })} data-testid="leave-to" /></Field>}
            </div>
            <Field label="Reason"><VoiceArea value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} placeholder="Why" testid="leave-reason" /></Field>
            {error && <div className="note bad" data-testid="leave-error">{error}</div>}
            <button type="button" className="btn primary block big" onClick={send} disabled={!!busy || !form.reason.trim()} data-testid="leave-send">{busy === 'send' ? <Loader2 className="spin" /> : <Send size={18} />} {data.has_manager ? 'Send to manager' : 'Ask'}</button>
          </div>
        </Sheet>
      )}
      <BottomNav />
    </div>
  );
}
