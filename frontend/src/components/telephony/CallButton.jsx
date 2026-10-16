/*
 * The "Call" button on a lead, a contact or an account.
 *
 * Shown only to people who can call (telephony is on, their phone is set up in
 * Settings → Telephony → Agents, and their role may log calls). Pressing it
 * asks MCube to ring the agent's own phone (or softphone) first and then the
 * customer; the call card at the bottom-left of the screen follows the call.
 *
 * It sits beside the red "Dispose" button and does not replace it: Dispose is
 * still where the outcome and the next follow-up are recorded.
 */
import { Phone } from 'lucide-react';
import { useTelephony, requestCall, sessionOf } from './telephony';

export default function CallButton({ module, recordId, className = '', style, label = 'Call', compact = false }) {
  const tel = useTelephony();
  if (!tel.status || !tel.status.can_call) return null;
  const session = sessionOf(module, recordId, tel.sessions);
  const live = !!(session && session.live);
  const busy = tel.starting || live;
  return (
    <button type="button" onClick={() => requestCall({ module, recordId })} disabled={busy}
      title={live ? 'This call is going on — see the call card at the bottom left' : 'MCube rings your phone first, then the customer'}
      className={className || `flex items-center gap-1.5 text-sm font-semibold ${compact ? 'px-3 py-1.5 rounded-lg' : 'px-4 py-2.5 rounded-xl'} h-fit border disabled:opacity-60`}
      style={style || { color: 'var(--color-brand)', borderColor: 'var(--color-brand)', background: 'var(--color-brand-soft)' }}>
      <Phone className="w-4 h-4" /> {live ? 'On call…' : (tel.starting ? 'Calling…' : label)}
    </button>
  );
}

// For screens that draw their own button (the quick-action bar).
export function useCallAction(module, recordId) {
  const tel = useTelephony();
  const can = !!(tel.status && tel.status.can_call);
  const session = can ? sessionOf(module, recordId, tel.sessions) : null;
  return { can, busy: tel.starting || !!(session && session.live), run: () => requestCall({ module, recordId }) };
}
