/*
 * Settings → Field force (the mobile app for people in the field).
 *
 *   General      switch on; which roles see everyone; how the app connects
 *   Attendance   working hours (late / left early), selfies, a day left open
 *   Tracking     the route between punch in and punch out, and how km are counted
 *   Visits       check-in at customers: selfie, how far is "far", the customer's place
 *   Km expense   the day's km made into an expense at punch out (needs Expenses)
 *   Map          OpenStreetMap, or another map server
 *   Calls & app  calls from the app (auto log, the phone's calls, recordings, target, WhatsApp),
 *                call transcription and summary, the app's newest version
 *   Plans & leave   (v1.3) visit plans and their approval, the route's speed, leave and its kinds
 *   Reminders       (v1.3) the phone's reminders, punch out / check out by themselves
 *   Meeting recording (v1.3) recording a meeting at a visit, and how the customer agrees
 *
 * Who may use it: Roles & Permissions → "Field force" (view = use the app; export = the CSV).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MapPinned, ArrowLeft, Check, Loader2, Copy } from 'lucide-react';
import { api, absoluteApiBase } from '../api';
import { PageHeader } from '../components/ui';
import { fieldSettingsChanged } from '../components/field/field';

const TABS = [['general', 'General'], ['attendance', 'Attendance'], ['tracking', 'Tracking & km'], ['visits', 'Visits'], ['plans', 'Plans & leave'], ['reminders', 'Reminders'], ['meetings', 'Meeting recording'], ['calls', 'Calls & app'], ['expense', 'Km expense'], ['map', 'Map']];

function Toggle({ on, onChange, label, testid }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} aria-label={label} onClick={() => onChange(!on)} data-testid={testid}
      className="relative w-10 h-6 rounded-full transition-colors shrink-0" style={{ background: on ? 'var(--color-success)' : 'var(--color-line-strong)' }}>
      <span className="absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all" style={{ left: on ? 20 : 4 }} />
    </button>
  );
}
function Row({ title, hint, children }) {
  return (
    <div className="grid gap-2 md:gap-8 md:grid-cols-[minmax(240px,2fr)_3fr] items-start py-3.5" style={{ borderBottom: '1px solid var(--color-line-soft)' }}>
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        {hint && <p className="t-meta mt-0.5">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
function Num({ value, onChange, unit, step = 1, min, max, testid, width = 96 }) {
  return (
    <span className="inline-flex items-center gap-2">
      <input type="number" className="input" style={{ width }} value={value} step={step} min={min} max={max} onChange={(e) => onChange(e.target.value)} data-testid={testid} />
      {unit && <span className="t-meta">{unit}</span>}
    </span>
  );
}

const NUMBERS = ['interval_seconds', 'distance_filter_m', 'max_accuracy_m', 'max_speed_kmh', 'min_move_m', 'road_factor', 'auto_out_hours', 'visit_radius_m', 'km_expense_min', 'call_daily_target', 'call_recording_days',
  'route_speed_kmh', 'remind_visit_minutes', 'visit_auto_out_m', 'visit_auto_out_hours', 'meeting_max_minutes'];

export default function SettingsField() {
  const [payload, setPayload] = useState(null);
  const [f, setF] = useState(null);
  const [tab, setTab] = useState('general');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const take = (p) => {
    setPayload(p);
    const s = p.settings;
    setF({ ...s, ...Object.fromEntries(NUMBERS.map((k) => [k, String(s[k] ?? '')])), km_expense_category_id: s.km_expense_category_id ? String(s.km_expense_category_id) : '', transcribe_key: '', maps_google_key: '', leave_types_text: (s.leave_types || []).join('\n') });
  };
  useEffect(() => { api.fieldSettings().then(take).catch((e) => setError(e.message || 'The settings could not be loaded.')); }, []);
  const set = (k, v) => { setF((x) => ({ ...x, [k]: v })); setSaved(false); };

  const save = async () => {
    setBusy(true); setError(''); setSaved(false);
    try {
      const body = { ...f };
      NUMBERS.forEach((k) => { body[k] = body[k] === '' ? undefined : Number(body[k]); });
      body.km_expense_category_id = f.km_expense_category_id ? Number(f.km_expense_category_id) : null;
      body.leave_types = String(f.leave_types_text || '').split('\n').map((x) => x.trim()).filter(Boolean);
      delete body.leave_types_text;
      take(await api.saveFieldSettings(body));
      setSaved(true);
      fieldSettingsChanged();
    } catch (e) { setError(e.message || 'The settings could not be saved.'); } finally { setBusy(false); }
  };

  if (!f) {
    return (
      <div>
        <PageHeader title="Field force" icon={MapPinned} accent="meetings" />
        {error ? <p className="text-sm" style={{ color: 'var(--color-danger)' }}>{error}</p> : <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--color-faint)' }} />}
      </div>
    );
  }
  const appAddress = absoluteApiBase().replace(/\/api$/, '');
  const copy = async () => { try { await navigator.clipboard.writeText(appAddress); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the address is on the screen */ } };
  const roles = payload.roles || [];
  const viewers = new Set((f.viewer_role_ids || []).map(Number));

  return (
    <div className="w-full">
      <Link to="/settings" className="t-meta inline-flex items-center gap-1 mb-3 hover:underline"><ArrowLeft className="w-4 h-4" /> Settings</Link>
      <PageHeader title="Field force" subtitle="Attendance with location, live tracking, km, visits at customers — the mobile app for the field team" icon={MapPinned} accent="meetings">
        <Link to="/field" className="btn btn-secondary">Open Field team</Link>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy} data-testid="field-save">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save</button>
      </PageHeader>

      {error && <div className="rounded-xl px-4 py-3 text-sm mb-4" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }} data-testid="field-error">{error}</div>}
      {saved && <div className="rounded-xl px-4 py-3 text-sm mb-4" style={{ background: 'var(--color-success-soft)', color: 'var(--color-success)' }} data-testid="field-saved">Saved. The app picks the new rules up the next time it opens.</div>}

      <div className="flex items-center gap-1 mb-4 overflow-x-auto thin-scroll" role="tablist" style={{ borderBottom: '1px solid var(--color-line)' }}>
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`ftab-${k}`} className="px-3.5 py-2.5 text-sm font-medium whitespace-nowrap -mb-px"
            style={tab === k ? { color: 'var(--color-brand)', borderBottom: '2px solid var(--color-brand)' } : { color: 'var(--color-muted)', borderBottom: '2px solid transparent' }}>{label}</button>
        ))}
      </div>

      <section className="card px-5 py-1">
        {tab === 'general' && (
          <>
            <Row title="Switch Field force on" hint="Punch in / out, tracking and visits in the mobile app, and the Field team page. Who may use it: Roles & Permissions → Field force.">
              <Toggle on={f.enabled} onChange={(v) => set('enabled', v)} label="Field force on" testid="f-enabled" />
            </Row>
            <Row title="Roles that see everyone" hint="Besides Super Admin. Everyone else sees themselves, and a manager the people who report to them (Users → Reports to).">
              <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto pr-1" data-testid="f-viewers">
                {roles.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={viewers.has(r.id)} onChange={(e) => set('viewer_role_ids', e.target.checked ? [...viewers, r.id] : [...viewers].filter((x) => x !== r.id))} />{r.name}
                  </label>
                ))}
              </div>
            </Row>
            <Row title="The mobile app connects to" hint="People type this address in the app once, then sign in with their CRM user name and password.">
              <span className="inline-flex items-center gap-2">
                <code className="text-xs px-2 py-1 rounded" style={{ background: 'var(--color-canvas-alt)' }} data-testid="f-app-address">{appAddress}</code>
                <button type="button" className="btn btn-ghost" style={{ padding: '.3rem .5rem' }} onClick={copy} title="Copy">{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}</button>
              </span>
            </Row>
          </>
        )}

        {tab === 'attendance' && (
          <>
            <Row title="Work starts at" hint="A punch in later than this is marked late."><input type="time" className="input" style={{ width: 130 }} value={f.work_start} onChange={(e) => set('work_start', e.target.value)} data-testid="f-work-start" /></Row>
            <Row title="Work ends at" hint="A punch out earlier than this is marked “left early”."><input type="time" className="input" style={{ width: 130 }} value={f.work_end} onChange={(e) => set('work_end', e.target.value)} data-testid="f-work-end" /></Row>
            <Row title="Selfie at punch in" hint="The app opens the front camera; the photo is kept with the attendance."><Toggle on={f.selfie_in} onChange={(v) => set('selfie_in', v)} label="Selfie at punch in" testid="f-selfie-in" /></Row>
            <Row title="Selfie at punch out"><Toggle on={f.selfie_out} onChange={(v) => set('selfie_out', v)} label="Selfie at punch out" testid="f-selfie-out" /></Row>
            <Row title="Close a day left open after" hint="Someone forgot to punch out (or the phone died): the day is closed at the last place the phone sent, and marked “no punch out”.">
              <Num value={f.auto_out_hours} onChange={(v) => set('auto_out_hours', v)} unit="hours" min={4} max={24} testid="f-auto-out" />
            </Row>
          </>
        )}

        {tab === 'tracking' && (
          <>
            <Row title="Record the route" hint="Only between punch in and punch out — never outside working time. Off: only the punch and visit places are kept, and km are straight lines between them.">
              <Toggle on={f.track} onChange={(v) => set('track', v)} label="Record the route" testid="f-track" />
            </Row>
            <Row title="Take a point every" hint="Shorter = a more exact route and km, but more battery. 60 seconds is a good balance."><Num value={f.interval_seconds} onChange={(v) => set('interval_seconds', v)} unit="seconds" min={15} max={900} testid="f-interval" /></Row>
            <Row title="…and only after moving" hint="Standing still, the phone sends nothing new (saves battery)."><Num value={f.distance_filter_m} onChange={(v) => set('distance_filter_m', v)} unit="metres" min={0} max={1000} /></Row>
            <Row title="Leave out points less exact than" hint="Indoors GPS can be hundreds of metres off; such points are not counted in km."><Num value={f.max_accuracy_m} onChange={(v) => set('max_accuracy_m', v)} unit="metres" min={10} max={1000} /></Row>
            <Row title="Leave out jumps faster than" hint="A point that would need this speed is a GPS error, not travel."><Num value={f.max_speed_kmh} onChange={(v) => set('max_speed_kmh', v)} unit="km/h" min={20} max={400} /></Row>
            <Row title="Do not count moves smaller than" hint="Standing still, points wander a few metres; that is not travel."><Num value={f.min_move_m} onChange={(v) => set('min_move_m', v)} unit="metres" min={0} max={200} /></Row>
            <Row title="Road factor" hint="Km are measured as straight lines between points. Roads bend: 1.1–1.2 comes close to road km in a city when points are far apart. 1 = no change.">
              <Num value={f.road_factor} onChange={(v) => set('road_factor', v)} step={0.05} min={1} max={1.6} testid="f-road-factor" />
            </Row>
            <p className="t-meta py-3">Points sent from a fake-location app are never counted, and the manager sees a warning.</p>
          </>
        )}

        {tab === 'visits' && (
          <>
            <Row title="Selfie at check-in" hint="At a customer, the app asks for a selfie before the check-in."><Toggle on={f.selfie_visit} onChange={(v) => set('selfie_visit', v)} label="Selfie at check-in" testid="f-selfie-visit" /></Row>
            <Row title="A check-in further than this from the customer is “far”" hint="When the customer's place is known. The manager sees it marked."><Num value={f.visit_radius_m} onChange={(v) => set('visit_radius_m', v)} unit="metres" min={20} max={20000} testid="f-radius" /></Row>
            <Row title="Save the customer's place from the first visit" hint="A lead, contact or account with no place yet gets the place of the first check-in. Used for “nearby” in the app."><Toggle on={f.save_place_on_visit} onChange={(v) => set('save_place_on_visit', v)} label="Save the place" /></Row>
            <Row title="Complete the meeting at check-out" hint="A check-in at a meeting marks it Completed with the notes and outcome of the visit."><Toggle on={f.close_meeting_on_checkout} onChange={(v) => set('close_meeting_on_checkout', v)} label="Complete the meeting" /></Row>
            <Row title="Find a customer's place from the address" hint="With OpenStreetMap's free address search (one address a second). Off: places come from visits or from the app's “the customer is here”.">
              <Toggle on={f.geocode} onChange={(v) => set('geocode', v)} label="Find from the address" testid="f-geocode" />
            </Row>
          </>
        )}

        {tab === 'plans' && (
          <>
            <p className="text-sm font-semibold text-ink pt-4">Visit plans (beat plans)</p>
            <Row title="People plan their visits" hint="In the app: My plan — the customers to visit each day (or a week ahead). The day is then measured: done, missed, not planned (Field team → Plans).">
              <Toggle on={f.plan_on} onChange={(v) => set('plan_on', v)} label="Visit plans" testid="f-plan-on" />
            </Row>
            <Row title="The manager approves each plan" hint="A plan goes to the person's manager (Users → Reports to), who approves it or sends it back with a reason. Someone with nobody above them is approved at once.">
              <Toggle on={f.plan_approval} onChange={(v) => set('plan_approval', v)} label="Plan approval" testid="f-plan-approval" />
            </Row>
            <Row title="Average speed in town" hint="For the travel time between stops of the day's best route.">
              <Num value={f.route_speed_kmh} onChange={(v) => set('route_speed_kmh', v)} unit="km/h" min={5} max={80} testid="f-route-speed" />
            </Row>
            <p className="text-sm font-semibold text-ink pt-5">Leave</p>
            <Row title="People ask for leave in the app" hint="Their manager approves it (in the app or Field team → Leave). The attendance shows “On leave” on those days — not absent, not late.">
              <Toggle on={f.leave_on} onChange={(v) => set('leave_on', v)} label="Leave requests" testid="f-leave-on" />
            </Row>
            <Row title="Kinds of leave" hint="One on each line.">
              <textarea className="input" style={{ width: 280, minHeight: 110 }} value={f.leave_types_text} onChange={(e) => set('leave_types_text', e.target.value)} data-testid="f-leave-types" />
            </Row>
          </>
        )}

        {tab === 'reminders' && (
          <>
            <p className="text-sm font-semibold text-ink pt-4">Reminders on the phone</p>
            <Row title="“Time to punch in”" hint={`At the start of work (${f.work_start}), when the person has not punched in. Not on a day of leave.`}>
              <Toggle on={f.remind_punch_in} onChange={(v) => set('remind_punch_in', v)} label="Punch in reminder" testid="f-remind-in" />
            </Row>
            <Row title="“Still punched in”" hint={`At the end of work (${f.work_end}), while still punched in.`}>
              <Toggle on={f.remind_punch_out} onChange={(v) => set('remind_punch_out', v)} label="Punch out reminder" testid="f-remind-out" />
            </Row>
            <Row title="“Still at the customer?”" hint="After this many minutes checked in at a customer. 0 = never.">
              <Num value={f.remind_visit_minutes} onChange={(v) => set('remind_visit_minutes', v)} unit="minutes" min={0} max={1440} testid="f-remind-visit" />
            </Row>
            <p className="text-sm font-semibold text-ink pt-5">By themselves</p>
            <Row title="Punch out by itself at" hint="A day still open at this time is punched out at this time (marked “no punch out”). Empty = never (a day is still closed after the hours in Attendance).">
              <span className="inline-flex items-center gap-2">
                <input type="time" className="input" style={{ width: 130 }} value={f.auto_out_time} onChange={(e) => set('auto_out_time', e.target.value)} data-testid="f-auto-out-time" />
                {f.auto_out_time && <button type="button" className="btn btn-ghost" onClick={() => set('auto_out_time', '')}>Never</button>}
              </span>
            </Row>
            <Row title="Check out of a visit by itself when the person is this far away" hint="Two GPS points in a row further than this from where they checked in close the visit (at the first of them). 0 = never. 300 m or more works well.">
              <Num value={f.visit_auto_out_m} onChange={(v) => set('visit_auto_out_m', v)} unit="metres" min={0} max={50000} testid="f-visit-auto-m" />
            </Row>
            <Row title="…or after" hint="A visit open longer than this is checked out by itself. 0 = never.">
              <Num value={f.visit_auto_out_hours} onChange={(v) => set('visit_auto_out_hours', v)} unit="hours" step={0.5} min={0} max={24} testid="f-visit-auto-h" />
            </Row>
          </>
        )}

        {tab === 'meetings' && (
          <>
            <Row title="Record meetings at visits" hint="At a visit the app offers “Record the meeting”. The recording is kept with the visit; with “Recordings to text” on (Calls & app) the CRM writes it as text with a short summary.">
              <Toggle on={f.meeting_rec_on} onChange={(v) => set('meeting_rec_on', v)} label="Meeting recording" testid="f-meet-on" />
            </Row>
            <Row title="How the customer agrees" hint="Recording someone needs their consent.">
              <select className="input" style={{ width: 320 }} value={f.meeting_consent} onChange={(e) => set('meeting_consent', e.target.value)} data-testid="f-meet-consent">
                <option value="spoken">Spoken: the customer says yes at the start of the recording</option>
                <option value="otp" disabled={!payload.whatsapp_ready}>A code on WhatsApp the customer tells{payload.whatsapp_ready ? '' : ' (set up WhatsApp first)'}</option>
                <option value="either" disabled={!payload.whatsapp_ready}>Either (the person chooses)</option>
                <option value="none">No consent step</option>
              </select>
            </Row>
            <Row title="The sentence read out" hint="The app shows it; it is read out at the start of the recording and the customer answers.">
              <textarea className="input" style={{ width: 360, minHeight: 64 }} value={f.meeting_consent_text} onChange={(e) => set('meeting_consent_text', e.target.value)} data-testid="f-meet-text" />
            </Row>
            {['otp', 'either'].includes(f.meeting_consent) && (
              <>
                <Row title="WhatsApp template with the code" hint="An approved template of your WhatsApp account whose text has {{1}} for the 6-digit code (an “Authentication” template, e.g. “{{1}} is your code to agree to the recording of our meeting.”).">
                  {payload.whatsapp_templates && payload.whatsapp_templates.length ? (
                    <select className="input" style={{ width: 320 }} value={f.meeting_otp_template} onChange={(e) => { const t = payload.whatsapp_templates.find((x) => x.template_name === e.target.value); set('meeting_otp_template', e.target.value); if (t && t.language) set('meeting_otp_language', t.language); }} data-testid="f-meet-template">
                      <option value="">Choose…</option>
                      {payload.whatsapp_templates.map((t) => <option key={`${t.template_name}-${t.language}`} value={t.template_name}>{t.template_name} ({t.language}{t.status ? `, ${String(t.status).toLowerCase()}` : ''})</option>)}
                    </select>
                  ) : <input className="input" style={{ width: 260 }} value={f.meeting_otp_template} placeholder="template name" onChange={(e) => set('meeting_otp_template', e.target.value)} data-testid="f-meet-template" />}
                </Row>
                <Row title="Template language"><input className="input" style={{ width: 120 }} value={f.meeting_otp_language} onChange={(e) => set('meeting_otp_language', e.target.value)} /></Row>
              </>
            )}
            <Row title="Longest recording" hint="The app stops by itself after this.">
              <Num value={f.meeting_max_minutes} onChange={(v) => set('meeting_max_minutes', v)} unit="minutes" min={5} max={180} testid="f-meet-max" />
            </Row>
            <p className="t-meta py-3">Recordings are deleted after the days set in Calls & app (“Delete recordings after”).</p>
          </>
        )}

        {tab === 'calls' && (
          <>
            <p className="text-sm font-semibold text-ink pt-4">Calls from the mobile app</p>
            <Row title="Save calls by themselves (auto log)" hint="After a call from the app, the call is saved at once with its real start, end and length (from the phone's call history). The person can still add the outcome, a remark and a follow-up. Off: the person saves each call.">
              <Toggle on={f.call_auto_log} onChange={(v) => set('call_auto_log', v)} label="Auto log" testid="f-call-auto" />
            </Row>
            <Row title="Find calls made outside the app" hint="The app looks at the phone's call history for calls with numbers that are in the CRM (leads, contacts, customers): missed calls to call back, calls not saved yet (saved by themselves with auto log). Calls with other numbers are never saved.">
              <Toggle on={f.call_scan_phone} onChange={(v) => set('call_scan_phone', v)} label="Find calls on the phone" testid="f-call-scan" />
            </Row>
            <Row title="Calls a day (target)" hint="Shown on the app's Home and to managers (Field team → Live). 0 = no target.">
              <Num value={f.call_daily_target} onChange={(v) => set('call_daily_target', v)} unit="calls" min={0} max={1000} testid="f-call-target" />
            </Row>
            <Row title="Save the phone's call recordings" hint="Many Android phones record calls in their own dialer (Samsung, Xiaomi, Oppo, Vivo, Realme, OnePlus — switch “Record calls automatically” on in the phone's Phone app). The app finds the recording after the call and saves it with the call. Phones with the Google Phone app cannot: use the telephony (MCube) for those.">
              <Toggle on={f.call_recordings} onChange={(v) => set('call_recordings', v)} label="Save recordings" testid="f-call-rec" />
            </Row>
            <Row title="Delete recordings after" hint="Recordings take space in the database. After this many days the sound file is deleted (the call stays). 0 = keep them.">
              <Num value={f.call_recording_days} onChange={(v) => set('call_recording_days', v)} unit="days" min={0} max={3650} testid="f-call-rec-days" />
            </Row>
            <Row title="WhatsApp message after a call" hint="The app offers it after each call. {name} = the customer's name, {me} = the person's name. Empty: WhatsApp opens without a message.">
              <textarea className="input" style={{ width: 360, minHeight: 70 }} value={f.call_whatsapp_text} placeholder="Hi {name}, thank you for your time today. – {me}" onChange={(e) => set('call_whatsapp_text', e.target.value)} data-testid="f-call-wa" />
            </Row>

            <p className="text-sm font-semibold text-ink pt-5">Recordings to text (optional, paid)</p>
            <Row title="Write each recording as text" hint="A speech service (OpenAI Whisper, or any service with the same API — Groq, a local Whisper server) writes what was said. It costs about ₹0.50 a minute of call with OpenAI. Off by default.">
              <Toggle on={f.transcribe_on} onChange={(v) => set('transcribe_on', v)} label="Transcription" testid="f-tr-on" />
            </Row>
            <Row title="Service address" hint="https://api.openai.com/v1 for OpenAI; https://api.groq.com/openai/v1 for Groq.">
              <input className="input" style={{ width: 360 }} value={f.transcribe_base_url} onChange={(e) => set('transcribe_base_url', e.target.value)} data-testid="f-tr-url" />
            </Row>
            <Row title="Model" hint="whisper-1 (OpenAI), whisper-large-v3 (Groq).">
              <input className="input" style={{ width: 220 }} value={f.transcribe_model} onChange={(e) => set('transcribe_model', e.target.value)} data-testid="f-tr-model" />
            </Row>
            <Row title="Language of the calls" hint="Empty = the service finds it (calls in Hinglish work best this way).">
              <select className="input" style={{ width: 220 }} value={f.transcribe_language} onChange={(e) => set('transcribe_language', e.target.value)} data-testid="f-tr-lang">
                <option value="">Find it by itself</option><option value="en">English</option><option value="hi">Hindi</option><option value="mr">Marathi</option>
              </select>
            </Row>
            <Row title="Service key" hint={payload.settings.transcribe_key_set ? 'A key is saved (kept encrypted, never shown). Type a new one to change it.' : 'The key of your account at the speech service.'}>
              <span className="inline-flex items-center gap-2">
                <input className="input" type="password" autoComplete="new-password" style={{ width: 260 }} value={f.transcribe_key} placeholder={payload.settings.transcribe_key_set ? '•••••••• (saved)' : 'sk-…'} onChange={(e) => set('transcribe_key', e.target.value)} data-testid="f-tr-key" />
                {payload.settings.transcribe_key_set && <button type="button" className="btn btn-ghost" onClick={() => { set('transcribe_key', '-'); set('transcribe_on', false); }} data-testid="f-tr-key-remove">Remove</button>}
              </span>
            </Row>
            <Row title="A short summary of each call" hint={payload.ai_summary_ready ? "The CRM's AI assistant writes 3–5 points from the text (what the customer wants, the next step)." : "Needs the CRM's AI assistant (ANTHROPIC_API_KEY on the server), which is not set up."}>
              <Toggle on={f.call_summary} onChange={(v) => set('call_summary', v)} label="Call summary" testid="f-tr-summary" />
            </Row>

            <p className="text-sm font-semibold text-ink pt-5">The app's newest version</p>
            <Row title="Newest version" hint="When a phone has an older app, it shows “A new version is ready” with the link below. Example: 1.1.0">
              <input className="input" style={{ width: 140 }} value={f.app_latest_version} placeholder="1.1.0" onChange={(e) => set('app_latest_version', e.target.value)} data-testid="f-app-version" />
            </Row>
            <Row title="Download link" hint="Where the people get the APK (Google Drive link, your website…). With the Play Store, its link.">
              <input className="input" style={{ width: 360 }} value={f.app_download_url} placeholder="https://…" onChange={(e) => set('app_download_url', e.target.value)} data-testid="f-app-url" />
            </Row>
          </>
        )}

        {tab === 'expense' && (
          <>
            {!payload.expenses_on && <p className="text-sm py-3" style={{ color: 'var(--color-warning-strong)' }}>Expense management is off. Switch it on in <Link to="/settings/expenses" className="underline">Settings → Expenses</Link> first.</p>}
            <Row title="Make the day's km an expense at punch out" hint="The km of the day × the vehicle's rate, added to the person's expenses (not sent yet: they send it with their claim).">
              <Toggle on={f.km_expense} onChange={(v) => set('km_expense', v)} label="Km expense" testid="f-km-expense" />
            </Row>
            <Row title="Expense category" hint="A category of the kind “Own vehicle: km × rate”.">
              <select className="input" style={{ width: 220 }} value={f.km_expense_category_id} onChange={(e) => set('km_expense_category_id', e.target.value)} data-testid="f-km-category">
                <option value="">Choose…</option>
                {payload.km_categories.map((c) => <option key={c.id} value={c.id} disabled={!c.active}>{c.name}{c.active ? '' : ' (off)'}</option>)}
              </select>
            </Row>
            <Row title="Vehicle" hint="Its rate per km comes from Settings → Expenses → Km rates.">
              <select className="input" style={{ width: 220 }} value={f.km_expense_vehicle} onChange={(e) => set('km_expense_vehicle', e.target.value)} data-testid="f-km-vehicle">
                <option value="">Choose…</option>
                {payload.vehicles.map((v) => <option key={v.name} value={v.name} disabled={!v.active}>{v.name} — {v.rate_per_km}/km</option>)}
              </select>
            </Row>
            <Row title="Only when the day has at least" hint="A day of less km makes no expense."><Num value={f.km_expense_min} onChange={(v) => set('km_expense_min', v)} unit="km" step={0.5} min={0} max={1000} /></Row>
          </>
        )}

        {tab === 'map' && (
          <>
            <Row title="Map pictures" hint="Empty = OpenStreetMap (free, fine for a team). For many users or heavy use, take a map service (MapTiler, Mapbox, Stadia…) and paste its tile address with {z}, {x}, {y} and your key.">
              <input className="input" style={{ width: 360 }} value={f.map_tiles_url} placeholder="https://tile.openstreetmap.org/{z}/{x}/{y}.png" onChange={(e) => set('map_tiles_url', e.target.value)} data-testid="f-tiles" />
            </Row>
            <Row title="Credit line" hint="The map service's credit, shown in the corner of the map (most services ask for it).">
              <input className="input" style={{ width: 360 }} value={f.map_attribution} placeholder="© OpenStreetMap contributors" onChange={(e) => set('map_attribution', e.target.value)} />
            </Row>
            <p className="text-sm font-semibold text-ink pt-5">Addresses</p>
            <Row title="Google Maps key (optional)" hint="Used for the address suggestions while typing and for “Use my location” on the forms of leads, contacts and accounts, and for the addresses of visits. Empty = OpenStreetMap (free). Google is better for Indian addresses; switch on the “Geocoding API” for the key in Google Cloud (Google charges after its free monthly amount). Type - to remove the key.">
              <div>
                <input className="input" style={{ width: 360 }} type="password" autoComplete="new-password" value={f.maps_google_key || ''} placeholder={payload.settings.maps_google_key_set ? 'A key is saved (type a new one to change it)' : 'AIza…'} onChange={(e) => set('maps_google_key', e.target.value)} data-testid="f-google-key" />
                <p className="t-meta mt-1" data-testid="f-address-provider">Now: {payload.settings.maps_google_key_set ? 'Google' : 'OpenStreetMap (free)'}</p>
              </div>
            </Row>
          </>
        )}
      </section>
    </div>
  );
}
