/* Choose the call's recording from the sound files the phone saved around the call. */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileAudio, Star } from 'lucide-react';
import { Sheet, Loading, Empty } from './ui';
import { audioAround, scoreRecording, RECORDING_SURE, askAudio, phoneStatus } from '../lib/calls';
import { niceDate, niceTime, talk } from '../lib/format';

const iso = (ms) => new Date(ms).toISOString();
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * @param call  { date, end, duration, digits, name } — the call (start/end in ms), to put the likely file first
 * @param onPick (file) => void
 */
export default function RecordingPicker({ call, onPick, onClose }) {
  const [files, setFiles] = useState(null);
  const [allowed, setAllowed] = useState(true);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    let on = true;
    (async () => {
      const st = await phoneStatus();
      if (!st.audio && !(await askAudio())) { if (on) { setAllowed(false); setFiles([]); } return; }
      const span = wide ? 6 * 3600000 : 30 * 60000;
      const list = await audioAround(call.date - span, call.end + span);
      if (on) setFiles(list.map((f) => ({ ...f, score: scoreRecording(call, f) })).sort((a, b) => b.score - a.score || b.added - a.added));
    })();
    return () => { on = false; };
  }, [call, wide]);
  return createPortal(
    <Sheet title="Choose the call's recording" onClose={onClose}>
      <div className="tiny muted" style={{ marginBottom: 8 }}>Call at {niceTime(iso(call.date))}{call.duration ? ` · ${talk(call.duration)}` : ''}. Sound files the phone saved around that time:</div>
      {!allowed && <div className="note warn small">Allow “Music and audio” for iCRM (Settings → Apps → iCRM → Permissions), then try again.</div>}
      {!files && <Loading />}
      {files && !files.length && allowed && <Empty icon={FileAudio} title="No sound files around that time">Is “record calls” on in the phone's Phone app?</Empty>}
      {files && files.length > 0 && (
        <div className="list flat" style={{ boxShadow: 'none', border: '1px solid var(--line)', maxHeight: '55vh', overflowY: 'auto' }}>
          {files.map((f) => (
            <button type="button" key={f.id} className="row" onClick={() => onPick(f)} data-testid="rec-file">
              <FileAudio size={20} color={f.score >= RECORDING_SURE ? 'var(--ok)' : 'var(--muted)'} />
              <div className="main">
                <div className="title" style={{ wordBreak: 'break-all' }}>{f.name}</div>
                <div className="line">{niceDate(iso(f.added))} {niceTime(iso(f.added))}{f.duration ? ` · ${talk(Math.round(f.duration / 1000))}` : ''} · {kb(f.size)}{f.path ? ` · ${f.path}` : ''}</div>
              </div>
              {f.score >= RECORDING_SURE && <span className="tag ok"><Star size={11} /> likely</span>}
            </button>
          ))}
        </div>
      )}
      {!wide && files && <button type="button" className="btn ghost block" onClick={() => { setFiles(null); setWide(true); }} data-testid="rec-wider">Show files of a longer time (±6 hours)</button>}
    </Sheet>,
    document.body,
  );
}
