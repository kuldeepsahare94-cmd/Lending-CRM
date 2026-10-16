/*
 * A thin bar across the top of the screen while something you asked for is
 * loading (like a browser's own page-load bar). A click always shows a
 * response at once, even when the server needs a moment, so the CRM never
 * looks frozen. Background polling (chat, bell, reminders) never shows it,
 * and quick answers (under 150 ms) never flash it.
 */
import { useEffect, useRef, useState } from 'react';
import { onBusyChange } from '../api';

const SHOW_AFTER_MS = 150;

export default function TopProgress() {
  const [phase, setPhase] = useState('idle');   // idle | running | finishing
  const showTimer = useRef(null);
  const hideTimer = useRef(null);
  const phaseRef = useRef('idle');

  useEffect(() => {
    const set = (p) => { phaseRef.current = p; setPhase(p); };
    const off = onBusyChange((count) => {
      if (count > 0) {
        clearTimeout(hideTimer.current);
        if (phaseRef.current === 'finishing') { set('running'); return; }
        if (phaseRef.current === 'idle' && !showTimer.current) {
          showTimer.current = setTimeout(() => { showTimer.current = null; set('running'); }, SHOW_AFTER_MS);
        }
      } else {
        if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
        if (phaseRef.current === 'running') {
          set('finishing');
          hideTimer.current = setTimeout(() => set('idle'), 350);
        }
      }
    });
    return () => { off(); clearTimeout(showTimer.current); clearTimeout(hideTimer.current); };
  }, []);

  if (phase === 'idle') return null;
  return (
    <div aria-hidden="true" className="fixed top-0 left-0 right-0 z-[70] h-[3px] pointer-events-none">
      <div className={phase === 'running' ? 'icrm-progress-run' : 'icrm-progress-done'}
        style={{ height: '100%', background: 'linear-gradient(90deg, var(--color-brand), var(--color-special, var(--color-brand)))', boxShadow: '0 0 8px var(--color-brand)' }} />
    </div>
  );
}
