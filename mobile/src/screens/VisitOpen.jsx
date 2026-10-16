/* At a customer: photos and files, notes, the outcome, the next step — and check out. */
import { useState } from 'react';
import { get, set } from '../lib/store';
import { Link, useNavigate } from 'react-router-dom';
import { Camera, Paperclip, LogOut, Loader2, MapPin, ShoppingCart, FileText } from 'lucide-react';
import { useApp } from '../lib/app';
import { checkOut, addVisitFiles } from '../lib/fieldwork';
import { takePhoto, pickFiles } from '../lib/media';
import { since, niceTime } from '../lib/format';
import { TopBar, Empty, Field, StatusBars, VoiceArea } from '../components/ui';
import MeetingRecorder from '../components/MeetingRecorder';

const OUTCOMES = ['Interested', 'Order taken', 'Follow-up needed', 'Not interested', 'Customer not there'];

export default function VisitOpen() {
  const { day, setDay, say, module: m } = useApp();
  const nav = useNavigate();
  const v = day && day.open_visit;
  // what was typed is kept while the visit is open (going to take an order and back)
  const key = v && v.in_at ? String(v.in_at).slice(0, 19) : '';
  const draft = (key && (get('drafts') || {})[key]) || {};
  const [notes, setNotesState] = useState(draft.notes || '');
  const [outcome, setOutcomeState] = useState(draft.outcome || '');
  const [next, setNextState] = useState(draft.next || '');
  const keep = (patch) => { if (key) set('drafts', { [key]: { notes, outcome, next, ...patch } }); };
  const setNotes = (x) => { setNotesState(x); keep({ notes: x }); };
  const setOutcome = (x) => { setOutcomeState(x); keep({ outcome: x }); };
  const setNext = (x) => { setNextState(x); keep({ next: x }); };
  const [added, setAdded] = useState([]);
  const [busy, setBusy] = useState('');
  if (!v) {
    return <div className="screen no-nav"><TopBar title="Visit" /><div className="body"><Empty icon={MapPin} title="You are not checked in anywhere"><Link to="/visit/new" className="btn primary" style={{ marginTop: 8 }}>Check in</Link></Empty></div></div>;
  }
  const add = async (how) => {
    setBusy(how);
    try {
      const files = how === 'camera' ? [await takePhoto()].filter(Boolean) : await pickFiles(5);
      if (!files.length) return;
      if (added.length + files.length > 10) { say('A visit can have 10 photos or files.', 'error'); return; }
      addVisitFiles({ visit: v, files });
      setAdded([...added, ...files]);
      say(`${files.length === 1 ? 'Added' : `${files.length} added`}. It is sent with the visit.`, 'ok');
    } catch (e) { say(e.message, 'error'); } finally { setBusy(''); }
  };
  const out = async () => {
    setBusy('out');
    try {
      setDay(await checkOut({ day, visit: v, notes: notes.trim(), outcome, next_action: next.trim() }));
      set('drafts', null);
      say('Checked out.', 'ok');
      nav('/', { replace: true });
    } catch (e) { say(e.message, 'error'); } finally { setBusy(''); }
  };
  const orderAccount = v.related_module === 'accounts' ? v.related_record_id : null;
  return (
    <div className="screen no-nav">
      <TopBar title={v.related_name || 'Visit'} sub={`Since ${v.in_time || niceTime(v.in_at)} · ${since(v.in_at)}`} />
      <StatusBars />
      <div className="body">
        {v.pending && <div className="note info small">Checked in on the phone. It is sent to the CRM when there is internet.</div>}
        <div className="card col">
          <div className="card-title">Photos and files</div>
          <div className="btns">
            <button type="button" className="btn outline" onClick={() => add('camera')} disabled={!!busy} data-testid="visit-photo">{busy === 'camera' ? <Loader2 className="spin" size={18} /> : <Camera size={18} />} Photo</button>
            <button type="button" className="btn outline" onClick={() => add('files')} disabled={!!busy} data-testid="visit-file">{busy === 'files' ? <Loader2 className="spin" size={18} /> : <Paperclip size={18} />} File</button>
          </div>
          {added.length > 0 && (
            <div className="photos" data-testid="visit-added">
              {added.map((f, i) => (f.preview ? <img key={i} src={f.preview} alt="" /> : <span key={i} className="tag"><FileText size={12} /> {f.file_name}</span>))}
            </div>
          )}
        </div>
        <MeetingRecorder visit={v} />
        <div className="card col" style={{ gap: 12 }}>
          <div className="card-title">How did it go?</div>
          <div className="chips" data-testid="outcomes">
            {OUTCOMES.map((o) => <button key={o} type="button" className={`chip${outcome === o ? ' on' : ''}`} onClick={() => setOutcome(outcome === o ? '' : o)}>{o}</button>)}
          </div>
          <Field label="Notes"><VoiceArea value={notes} onChange={setNotes} placeholder="What was discussed" testid="visit-notes" /></Field>
          <Field label="Next step"><input className="input" value={next} onChange={(e) => setNext(e.target.value)} placeholder="Send the quote, demo on Monday…" /></Field>
        </div>
        {orderAccount && m('quotations') && m('quotations').can.create && (
          <Link to={`/order/new?account=${orderAccount}`} className="btn outline block"><ShoppingCart size={18} /> Take an order</Link>
        )}
        <button type="button" className="btn danger block big" onClick={out} disabled={!!busy} data-testid="visit-out">{busy === 'out' ? <Loader2 className="spin" /> : <LogOut />} Check out</button>
      </div>
    </div>
  );
}
