/*
 * After a call (v1.3.1): what the app could not do by itself is asked here.
 *   - A number the CRM does not know: save the call to a lead / contact / customer
 *     (or a new lead), or "Not for CRM".
 *   - A saved call whose recording was not found: choose the recording, or "No recording".
 * Used on Home (the newest few) and on "Phone calls".
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PhoneForwarded, FileAudio, UserPlus, Search, X, ChevronRight, ChevronDown } from 'lucide-react';
import { useApp } from '../lib/app';
import { get, set } from '../lib/store';
import { linkCall, skipCall, skipRecording, queueRecordingFile } from '../lib/calls';
import { niceDate, niceTime, talk } from '../lib/format';
import { Sheet, RecordPicker } from './ui';
import RecordingPicker from './RecordingPicker';

const LINKABLE = ['leads', 'contacts', 'accounts', 'opportunities'];
const WORD = { out: 'Outgoing', in: 'Incoming' };
const iso = (ms) => new Date(ms).toISOString();
const facts = (c) => `${WORD[c.type] || 'Call'} · ${niceDate(iso(c.date))} ${niceTime(iso(c.date))}${c.duration ? ` · ${talk(c.duration)}` : ''}`;

/**
 * @param asks     from callAsks(): [{ kind: 'link' | 'recording', call }]
 * @param onChange something was answered (the list is worked out again)
 * @param max      how many are shown (the rest: "N more")
 */
export default function AfterCalls({ asks, onChange, max = 3, onMore, foldable = false }) {
  const { module: modOf, say, sync, boot } = useApp();
  // (Home: folded until opened; remembered on the phone)
  const [open, setOpen] = useState(() => !foldable || !!get('fold_asks_open'));
  const toggle = () => { set('fold_asks_open', !open); setOpen(!open); };
  const nav = useNavigate();
  const [linking, setLinking] = useState(null);       // the call being saved to a customer
  const [module, setModule] = useState('');
  const [recFor, setRecFor] = useState(null);         // the call whose recording is chosen
  const canCalls = !!(modOf('calls') && modOf('calls').can.create);
  const list = (asks || []).filter((a) => a.kind === 'recording' || canCalls);
  if (!list.length) return null;
  const mods = LINKABLE.filter((m) => modOf(m) && modOf(m).can.view);
  const leads = modOf('leads');
  const canLead = !!(leads && leads.can.create);
  const shown = list.slice(0, max);
  const done = (text) => { if (text) say(text, 'ok'); onChange && onChange(); };

  const newLead = (c) => {
    set('after_call', c);
    nav(`/m/leads/new?mobile=${encodeURIComponent(c.number)}${c.name ? `&student_name=${encodeURIComponent(c.name)}` : ''}&after_call=${encodeURIComponent(c.ref)}`);
  };

  return (
    <div className="col after-calls" style={{ gap: 10 }} data-testid="after-calls">
      {foldable ? (
        <button type="button" className="fold-head" onClick={toggle} aria-expanded={open} data-testid="after-calls-toggle">
          <PhoneForwarded size={15} /> <span className="grow">After your calls</span><span className="seg-n">{list.length}</span>
          {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </button>
      ) : <div className="card-title"><PhoneForwarded size={15} /> After your calls</div>}
      {open && shown.map(({ kind, call: c }) => (
        <div key={`${kind}-${c.ref}`} className="ask" data-testid={`ask-${kind}`}>
          <div className="flex between" style={{ alignItems: 'flex-start' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="strong small">{kind === 'recording' ? c.match.name : (c.name || c.number)}</div>
              <div className="tiny muted">{kind === 'link' && c.name ? `${c.number} · ` : ''}{facts(c)}</div>
            </div>
            <button type="button" className="icon-btn" aria-label="Not now"
              onClick={() => { if (kind === 'link') skipCall(c); else skipRecording(c); done(); }} data-testid="ask-close"><X size={16} /></button>
          </div>
          {kind === 'link' ? (
            <>
              <div className="small">This number is not in the CRM. Save the call to a customer?</div>
              <div className="ask-btns">
                {mods.length > 0 && <button type="button" className="btn small primary" onClick={() => { setLinking(c); setModule(''); }} data-testid="ask-choose"><Search size={15} /> Choose customer</button>}
                {canLead && <button type="button" className="btn small outline" onClick={() => newLead(c)} data-testid="ask-lead"><UserPlus size={15} /> New lead</button>}
                <button type="button" className="btn small ghost" onClick={() => { skipCall(c); done('Not saved in the CRM.'); }} data-testid="ask-skip">Not for CRM</button>
              </div>
              <button type="button" className="tiny faint link-btn" onClick={() => { skipCall(c, { always: true }); done(`Calls with ${c.number} will not be asked about.`); }} data-testid="ask-never">Never ask for this number</button>
            </>
          ) : (
            <>
              <div className="small">The recording of this call was not found by itself.</div>
              <div className="ask-btns">
                <button type="button" className="btn small primary" onClick={() => setRecFor(c)} data-testid="ask-choose-rec"><FileAudio size={15} /> Choose recording</button>
                <button type="button" className="btn small ghost" onClick={() => { skipRecording(c); done(); }} data-testid="ask-no-rec">No recording</button>
              </div>
            </>
          )}
        </div>
      ))}
      {open && list.length > shown.length && onMore && (
        <button type="button" className="btn ghost small" onClick={onMore} data-testid="ask-more">{list.length - shown.length} more <ChevronRight size={15} /></button>
      )}

      {linking && !module && (
        <Sheet title="Save the call to…" onClose={() => setLinking(null)}>
          <div className="col" style={{ gap: 8 }}>
            <div className="small muted">{linking.name || linking.number} · {facts(linking)}</div>
            {mods.map((m) => (
              <button key={m} type="button" className="row" onClick={() => setModule(m)} data-testid={`ask-mod-${m}`}>
                <div className="main"><div className="title">{modOf(m).singular}</div></div><ChevronRight size={18} className="faint" />
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {linking && module && (
        <RecordPicker module={module} title={`Choose: ${modOf(module).singular.toLowerCase()}`} onClose={() => setModule('')}
          onPick={(r) => {
            linkCall(linking, { module, id: r.id, name: r.title });
            sync();
            setLinking(null); setModule('');
            done(`Call saved on ${r.title}.${boot && boot.calls && boot.calls.recordings ? ' Its recording follows.' : ''}`);
          }} />
      )}
      {recFor && (
        <RecordingPicker call={recFor} onClose={() => setRecFor(null)}
          onPick={(f) => {
            queueRecordingFile({ ref: recFor.ref, file: f, duration: recFor.duration, label: `Call recording: ${recFor.match ? recFor.match.name : recFor.number}` });
            sync();
            setRecFor(null);
            done('The recording is being sent.');
          }} />
      )}
    </div>
  );
}
