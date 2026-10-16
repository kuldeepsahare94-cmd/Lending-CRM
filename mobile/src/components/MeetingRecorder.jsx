/*
 * At a visit: record the meeting (v1.3). First the customer agrees — the way the
 * company asks (Settings → Field force): a sentence read out at the start of the
 * recording ("spoken"), or a code sent to the customer on WhatsApp ("otp").
 * Then record (pause / go on / stop). The recording is sent with the visit.
 */
import { useEffect, useRef, useState } from 'react';
import { Mic, Pause, Play, Square, ShieldCheck, Loader2, MessageCircle, CheckCircle2, X } from 'lucide-react';
import { useApp } from '../lib/app';
import { GET, POST } from '../lib/api';
import { makeRecorder, queueMeeting } from '../lib/meetrec';
import { get, set } from '../lib/store';

const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export default function MeetingRecorder({ visit }) {
  const { boot, say } = useApp();
  const rules = boot.sfa || {};
  const key = visit.id || visit.ref;
  const done = (get('meeting_recorded', []) || []).includes(key) || !!visit.recording_id;
  const [step, setStep] = useState(done ? 'done' : 'start');   // start | consent | recording | done
  const [how, setHow] = useState(rules.meeting_consent === 'otp' ? 'otp' : 'spoken');
  const [info, setInfo] = useState(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState('');
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [secs, setSecs] = useState(0);
  const [paused, setPaused] = useState(false);
  const rec = useRef(null);
  const max = (rules.meeting_max_minutes || 60) * 60;
  useEffect(() => () => { if (rec.current) rec.current.cancel(); }, []);
  useEffect(() => { if (secs >= max && rec.current) stop(); }, [secs]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rules.meeting_rec_on) return null;

  const needCode = rules.meeting_consent === 'otp' || (rules.meeting_consent === 'either' && how === 'otp');
  const begin = async () => {
    setError('');
    if (rules.meeting_consent === 'none') { start('none'); return; }
    setStep('consent');
    if (['otp', 'either'].includes(rules.meeting_consent) && visit.id) GET(`/sfa/visits/${visit.id}/recording-info`).then(setInfo).catch(() => {});
  };
  const sendCode = async () => {
    setError(''); setBusy('send');
    try {
      if (!visit.id) throw new Error('The check-in has not reached the CRM yet (no internet). Use spoken consent.');
      const r = await POST(`/sfa/visits/${visit.id}/consent/send`, phone.trim() ? { phone: phone.trim() } : {});
      setSent(r.to);
    } catch (e) { setError(e.offline ? 'No internet: the code cannot be sent. Use spoken consent.' : e.message); } finally { setBusy(''); }
  };
  const checkCode = async () => {
    setError(''); setBusy('check');
    try { await POST(`/sfa/visits/${visit.id}/consent/check`, { code: code.trim() }); setVerified(true); }
    catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const start = async (consent) => {
    setError(''); setBusy('start');
    try {
      rec.current = await makeRecorder({ onTick: setSecs });
      rec.current.start();
      rec.current.consent = consent;
      setSecs(0); setPaused(false); setStep('recording');
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const stop = async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    setBusy('stop');
    try {
      const out = await r.stop();
      if (out.seconds < 3 || !out.blob.size) { setError('The recording is too short. Record again.'); setStep('start'); return; }
      await queueMeeting({ visit, blob: out.blob, seconds: out.seconds, consent: r.consent });
      set('meeting_recorded', [...(get('meeting_recorded', []) || []), key].slice(-100));
      setStep('done');
      say('The recording is kept and sent with the visit.', 'ok');
    } catch (e) { setError(e.message); setStep('start'); } finally { setBusy(''); }
  };
  const pause = () => { if (!rec.current) return; if (paused) rec.current.resume(); else rec.current.pause(); setPaused(!paused); };

  return (
    <div className="card col meet-rec" data-testid="meet-rec">
      <div className="card-title"><Mic size={15} /> Record the meeting</div>
      {step === 'done' && <div className="flex small" style={{ gap: 8, alignItems: 'center' }} data-testid="meet-rec-done"><CheckCircle2 size={18} color="var(--ok)" /> Recorded. It is sent with the visit; the text and a summary show in the CRM.</div>}
      {step === 'start' && (
        <>
          <div className="tiny muted">The customer agrees first. Keep the app open while it records (the screen stays on). At most {rules.meeting_max_minutes || 60} minutes.</div>
          <button type="button" className="btn outline" onClick={begin} data-testid="meet-rec-begin"><Mic size={18} /> Record the meeting</button>
        </>
      )}
      {step === 'consent' && (
        <div className="col" style={{ gap: 10 }} data-testid="meet-consent">
          {rules.meeting_consent === 'either' && (
            <div className="chips">
              <button type="button" className={`chip${how === 'spoken' ? ' on' : ''}`} onClick={() => setHow('spoken')} data-testid="consent-spoken">Customer says yes</button>
              <button type="button" className={`chip${how === 'otp' ? ' on' : ''}`} onClick={() => setHow('otp')} data-testid="consent-otp">Code on WhatsApp</button>
            </div>
          )}
          {!needCode ? (
            <>
              <div className="note info small"><ShieldCheck size={16} /> Start the recording, then read this out and let the customer answer:</div>
              <div className="consent-text" data-testid="consent-text">“{rules.meeting_consent_text}”</div>
              <button type="button" className="btn primary" onClick={() => start('spoken')} disabled={!!busy} data-testid="meet-rec-start">{busy === 'start' ? <Loader2 className="spin" size={18} /> : <Mic size={18} />} Start recording</button>
            </>
          ) : verified ? (
            <>
              <div className="note ok small" data-testid="consent-verified"><CheckCircle2 size={16} /> The customer agreed with the code.</div>
              <button type="button" className="btn primary" onClick={() => start('otp')} disabled={!!busy} data-testid="meet-rec-start">{busy === 'start' ? <Loader2 className="spin" size={18} /> : <Mic size={18} />} Start recording</button>
            </>
          ) : (
            <>
              <div className="small">A 6-digit code goes to the customer on WhatsApp{info && info.phone ? ` (${info.phone})` : ''}. They tell you the code.</div>
              {info && !info.has_phone && <input className="input" type="tel" inputMode="tel" placeholder="Customer's mobile" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="consent-phone" />}
              <button type="button" className="btn outline" onClick={sendCode} disabled={!!busy} data-testid="consent-send">{busy === 'send' ? <Loader2 className="spin" size={18} /> : <MessageCircle size={18} />} {sent ? 'Send the code again' : 'Send the code'}</button>
              {sent && (
                <div className="flex" style={{ gap: 8 }}>
                  <input className="input grow" inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} data-testid="consent-code" />
                  <button type="button" className="btn primary" onClick={checkCode} disabled={code.length !== 6 || !!busy} data-testid="consent-check">{busy === 'check' ? <Loader2 className="spin" size={18} /> : 'Check'}</button>
                </div>
              )}
              {sent && <div className="tiny muted">Sent to {sent}.</div>}
            </>
          )}
          <button type="button" className="btn ghost small" onClick={() => { setStep('start'); setError(''); }}><X size={16} /> Not now</button>
        </div>
      )}
      {step === 'recording' && (
        <div className="col center" style={{ gap: 10 }} data-testid="meet-recording">
          <div className={`rec-dot${paused ? ' paused' : ''}`} />
          <div className="rec-clock" data-testid="meet-rec-clock">{clock(secs)}</div>
          <div className="tiny muted">{paused ? 'Paused' : 'Recording…'} · stops by itself at {rules.meeting_max_minutes || 60} min</div>
          <div className="flex" style={{ gap: 10 }}>
            <button type="button" className="btn outline" onClick={pause} data-testid="meet-rec-pause">{paused ? <><Play size={18} /> Go on</> : <><Pause size={18} /> Pause</>}</button>
            <button type="button" className="btn danger" onClick={stop} disabled={busy === 'stop'} data-testid="meet-rec-stop">{busy === 'stop' ? <Loader2 className="spin" size={18} /> : <Square size={18} />} Stop</button>
          </div>
        </div>
      )}
      {error && <div className="note bad small" data-testid="meet-rec-error">{error}</div>}
    </div>
  );
}
