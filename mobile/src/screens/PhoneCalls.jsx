/*
 * The phone's recent calls, with the CRM's names: who it was (lead, contact,
 * customer), saved in the CRM or not, "Log" for one that is not, "Create lead"
 * for a number the CRM does not know.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, UserPlus, CheckCircle2, RefreshCw, Phone, Play } from 'lucide-react';
import { App as CapApp } from '@capacitor/app';
import { useApp, listen } from '../lib/app';
import { set } from '../lib/store';
import { recentWithMatches, autoLogMissing, phoneStatus, askCallLog, canReadPhone, callAsks } from '../lib/calls';
import AfterCalls from '../components/AfterCalls';
import { niceDate, niceTime, talk } from '../lib/format';
import { TopBar, Loading, Empty, StatusBars } from '../components/ui';

const ICON = { out: PhoneOutgoing, in: PhoneIncoming, missed: PhoneMissed, rejected: PhoneMissed };
const WORD = { out: 'Outgoing', in: 'Incoming', missed: 'Missed', rejected: 'Rejected', blocked: 'Blocked', voicemail: 'Voicemail', other: 'Call' };

export default function PhoneCalls() {
  const { boot, module: mod, sync } = useApp();
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [days, setDays] = useState(2);
  const [allowed, setAllowed] = useState(true);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState('');
  const rules = (boot && boot.calls) || {};

  const load = useCallback(async () => {
    setError('');
    const s = await phoneStatus();
    if (!s.callLog) { setAllowed(false); setRows([]); return; }
    setAllowed(true);
    try {
      const r = await recentWithMatches({ since: Date.now() - days * 86400000 });
      if (await autoLogMissing(r.calls)) sync();
      setRows(r.calls);
    } catch (e) { setError(e.offline ? 'No internet: the names cannot be looked up now.' : e.message); setRows((x) => x || []); }
  }, [days, sync]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => listen(CapApp.addListener('resume', () => load())), [load]);

  const logIt = (c) => { set('log_call', c); nav(`/call/${c.match.module}/${c.match.id}?from=phone`); };
  const canLead = mod('leads') && mod('leads').can.create;

  if (!canReadPhone()) {
    return (
      <div className="screen no-nav"><TopBar title="Phone calls" />
        <div className="body"><Empty icon={Phone} title="Only in the app on the phone">Open iCRM on your Android phone to see its calls here.</Empty></div>
      </div>
    );
  }
  return (
    <div className="screen no-nav">
      <TopBar title="Phone calls" sub={`Last ${days} days`} right={<button type="button" className="icon-btn" aria-label="Refresh" onClick={() => { setRows(null); load(); }}><RefreshCw size={20} /></button>} />
      <StatusBars />
      <div className="body">
        {!allowed && (
          <div className="card col center" data-testid="allow-calls">
            <div className="strong">Allow iCRM to read the call history</div>
            <div className="small muted">So calls with your customers are found and saved, with the real time and length. Only calls with numbers in the CRM are saved.</div>
            <button type="button" className="btn primary" onClick={async () => { if (await askCallLog()) load(); }}>Allow</button>
          </div>
        )}
        {error && <div className="note bad">{error}</div>}
        {rows && rows.length > 0 && callAsks(rows, { since: 0 }).length > 0 && <div className="card"><AfterCalls asks={callAsks(rows, { since: 0 })} onChange={load} max={10} /></div>}
        {allowed && !rows && <Loading />}
        {allowed && rows && !rows.length && !error && <Empty icon={Phone} title="No calls" />}
        {rows && rows.length > 0 && (
          <div className="list" data-testid="phone-calls">
            {rows.map((c) => {
              const Icon = ICON[c.type] || Phone;
              const color = c.missed ? 'var(--bad)' : c.type === 'out' ? 'var(--info)' : 'var(--ok)';
              return (
                <div key={c.ref} className="row" data-testid="phone-call" style={{ flexWrap: 'wrap' }}>
                  <Icon size={20} color={color} />
                  <div className="main" onClick={() => c.match && nav(`/m/${c.match.module}/${c.match.id}`)} role={c.match ? 'link' : undefined}>
                    <div className="title">{c.match ? c.match.name : (c.name || c.number || 'Private number')}</div>
                    <div className="line">
                      {c.match ? `${c.number} · ` : (c.name ? `${c.number} · ` : '')}{WORD[c.type] || 'Call'} · {niceDate(new Date(c.date).toISOString())} {niceTime(new Date(c.date).toISOString())}{c.duration ? ` · ${talk(c.duration)}` : ''}
                    </div>
                  </div>
                  {c.recording_url && <button type="button" className="icon-btn" aria-label="Play the recording" onClick={() => setPlaying(playing === c.ref ? '' : c.ref)} data-testid="call-play"><Play size={18} /></button>}
                  {c.match ? (
                    c.logged ? <span className="tag ok" data-testid="logged"><CheckCircle2 size={12} /> Saved</span>
                      : <button type="button" className="btn small primary" onClick={() => logIt(c)} data-testid="log-it">Log</button>
                  ) : (c.digits && canLead ? (
                    <button type="button" className="btn small ghost" onClick={() => nav(`/m/leads/new?mobile=${encodeURIComponent(c.number)}${c.name ? `&student_name=${encodeURIComponent(c.name)}` : ''}`)} data-testid="create-lead"><UserPlus size={15} /> Lead</button>
                  ) : null)}
                  {playing === c.ref && c.recording_url && <audio controls autoPlay preload="none" src={c.recording_url} className="rec-audio" style={{ flexBasis: '100%' }} data-testid="call-audio" />}
                </div>
              );
            })}
          </div>
        )}
        {allowed && rows && days < 7 && <button type="button" className="btn ghost block" onClick={() => { setDays(7); setRows(null); }} data-testid="more-days">Show 7 days</button>}
        {allowed && <p className="tiny faint center">{rules.auto_log ? 'Calls with your leads and customers are saved by themselves.' : 'Tap “Log” to save a call with its outcome.'} A call with a number the CRM does not know is saved only when you choose the customer for it.</p>}
      </div>
    </div>
  );
}
