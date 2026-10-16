/*
 * Recordings check: what the app can see on this phone — the permissions, the
 * company's setting, the last calls and the sound files around each of them
 * (with how sure the app is that a file is the call's recording).
 * A recording can be chosen by hand here too.
 */
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, FileAudio, RefreshCw } from 'lucide-react';
import { useApp } from '../lib/app';
import { phoneStatus, askCallLog, askAudio, recentWithMatches, phoneCalls, audioAround, scoreRecording, RECORDING_SURE, queueRecordingFile, canReadPhone, recordingStates } from '../lib/calls';
import { niceDate, niceTime, talk } from '../lib/format';
import { TopBar, Loading, Empty, StatusBars } from '../components/ui';

const iso = (ms) => new Date(ms).toISOString();
const Yes = ({ ok, children }) => (
  <div className="flex small" style={{ alignItems: 'center', gap: 8 }}>
    {ok ? <CheckCircle2 size={18} color="var(--ok)" /> : <XCircle size={18} color="var(--bad)" />}<span className="grow">{children}</span>
  </div>
);

export default function RecordingsCheck() {
  const { boot, say, sync } = useApp();
  const [st, setSt] = useState(null);
  const [calls, setCalls] = useState(null);
  const [error, setError] = useState('');
  const rules = (boot && boot.calls) || {};

  const load = useCallback(async () => {
    setError(''); setCalls(null);
    const s = await phoneStatus();
    setSt(s);
    if (!s.callLog) { setCalls([]); return; }
    let list = [];
    try { list = (await recentWithMatches({ since: Date.now() - 2 * 86400000 })).calls; }
    catch (e) { setError(e.offline ? 'No internet: the CRM names cannot be looked up. The phone part is still shown.' : e.message); list = await phoneCalls({ since: Date.now() - 2 * 86400000 }).catch(() => []); }
    // (what the CRM really has — "saved" — and what is still on its way or could not be sent)
    const states = recordingStates(list.filter((c) => c.recorded).map((c) => c.ref));
    const last = list.filter((c) => c.connected && c.duration > 0).slice(0, 5);
    const out = [];
    for (const c of last) {
      const files = s.audio ? await audioAround(c.date - 120000, c.end + 15 * 60000) : [];
      out.push({ ...c, rec: states[c.ref] || '', files: files.map((f) => ({ ...f, score: scoreRecording(c, f) })).sort((a, b) => b.score - a.score).slice(0, 6) });
    }
    setCalls(out);
  }, []);
  useEffect(() => { load(); }, [load]);

  const use = (c, f) => {
    if (!c.logged && !c.match) { say('This call is not in the CRM (the number is not a lead or customer).', 'error'); return; }
    if (!c.logged) { say('Save the call first (Phone calls → Log), then add its recording.', 'error'); return; }
    queueRecordingFile({ ref: c.ref, file: f, duration: c.duration, label: `Call recording: ${c.match ? c.match.name : c.number}` });
    say('The recording is being sent.', 'ok');
    sync();
    load();
  };

  if (!canReadPhone()) return <div className="screen no-nav"><TopBar title="Recordings check" /><div className="body"><Empty title="Only in the app on the phone" /></div></div>;
  return (
    <div className="screen no-nav">
      <TopBar title="Recordings check" right={<button type="button" className="icon-btn" aria-label="Again" onClick={load}><RefreshCw size={20} /></button>} />
      <StatusBars />
      <div className="body">
        {!st ? <Loading /> : (
          <div className="card col" style={{ gap: 8 }} data-testid="rec-status">
            <div className="card-title">This phone</div>
            <Yes ok={rules.recordings}>The company saves call recordings {rules.recordings ? '' : '(off in Settings → Field force → Calls & app)'}</Yes>
            <Yes ok={st.callLog}>Call history allowed {!st.callLog && <button type="button" className="btn small ghost" onClick={async () => { await askCallLog(); load(); }}>Allow</button>}</Yes>
            <Yes ok={st.audio}>“Music and audio” allowed (to read recordings) {!st.audio && <button type="button" className="btn small ghost" onClick={async () => { await askAudio(); load(); }}>Allow</button>}</Yes>
            <div className="tiny muted">{st.maker ? `${st.maker} · ` : ''}Android {st.sdk ? `API ${st.sdk}` : ''}</div>
          </div>
        )}
        {error && <div className="note warn small">{error}</div>}
        {!calls ? <Loading /> : !calls.length ? <Empty icon={FileAudio} title="No answered calls in the last 2 days" /> : calls.map((c) => (
          <div key={c.ref} className="card col" style={{ gap: 6 }} data-testid="rec-call">
            <div className="flex between">
              <div className="strong">{c.match ? c.match.name : (c.name || c.number)}</div>
              {c.rec === 'saved' ? <span className="tag ok" data-testid="rec-state">saved in CRM</span>
                : c.rec === 'sending' ? <span className="tag info" data-testid="rec-state">sending…</span>
                  : c.rec === 'failed' ? <span className="tag bad" data-testid="rec-state">not sent</span>
                    : <span className="tag warn" data-testid="rec-state">no recording yet</span>}
            </div>
            <div className="tiny muted">{niceDate(iso(c.date))} {niceTime(iso(c.date))} · {talk(c.duration)} · {c.type === 'out' ? 'outgoing' : 'incoming'}{c.match ? (c.logged ? ' · in the CRM' : ' · not saved in the CRM yet') : ' · number not in the CRM'}</div>
            {c.rec === 'saved' && c.recording_url && <audio controls preload="none" src={c.recording_url} className="rec-audio" data-testid="rec-check-audio" />}
            {!c.files.length && <div className="note small">No sound file around this call. Is “record calls automatically” on in the phone's own Phone app?</div>}
            {c.files.map((f) => (
              <div key={f.id} className="flex" style={{ alignItems: 'center', gap: 8, borderTop: '1px solid var(--line-soft)', paddingTop: 6 }}>
                <FileAudio size={18} color={f.score >= RECORDING_SURE ? 'var(--ok)' : 'var(--muted)'} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="small" style={{ wordBreak: 'break-all' }}>{f.name}</div>
                  <div className="tiny faint">{f.path || '—'} · {niceTime(iso(f.added))}{f.duration ? ` · ${talk(Math.round(f.duration / 1000))}` : ''} · match {Math.max(0, f.score)}</div>
                </div>
                {c.rec !== 'saved' && c.rec !== 'sending' && <button type="button" className="btn small primary" onClick={() => use(c, f)} data-testid="rec-use">Use</button>}
              </div>
            ))}
          </div>
        ))}
        <p className="tiny faint center">A file with “match” {RECORDING_SURE} or more is sent by itself after the call. If your phone's recordings are not found, send a screenshot of this screen to your administrator.</p>
      </div>
    </div>
  );
}
