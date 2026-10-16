/*
 * Notification tones for team chat.
 *
 * WHY THESE ARE SYNTHESISED, NOT MP3 FILES
 *
 * Six sound files would be six more things to ship, cache-bust and lose. They
 * would sit in the build output, add weight to every page load whether or not
 * anyone ever hears them, and — on the free hosting this currently runs on —
 * would be one more asset path to get wrong after a redeploy.
 *
 * The Web Audio API is in every browser this CRM supports and can make these
 * tones from nothing: a few oscillators and a volume envelope. No files, no
 * network request, nothing to break. Total cost is this file.
 *
 * EACH USER PICKS THEIR OWN
 *
 * The choice is per user and per browser, kept in localStorage — it is a
 * personal preference about this machine (an open-plan desk wants Silent; a
 * home office may not), not company data, so it does not belong in the
 * database and does not need a backend round trip to read.
 */

export const TONES = [
  { id: 'ping', label: 'Soft Ping', hint: 'Short and neutral' },
  { id: 'double', label: 'Double Tap', hint: 'Two quick taps' },
  { id: 'chime', label: 'Chime', hint: 'Rising three-note' },
  { id: 'knock', label: 'Knock', hint: 'Low and discreet' },
  { id: 'bubble', label: 'Bubble', hint: 'Soft upward blip' },
  { id: 'alert', label: 'Alert', hint: 'Firmer, harder to miss' },
  { id: 'silent', label: 'Silent', hint: 'No sound at all' },
];

const STORAGE_PREFIX = 'cd_chat_tone_';

// Per user, so two people sharing a machine do not inherit each other's
// choice. Falls back to Soft Ping — a default of Silent would look like the
// feature was never delivered.
export function getTone(userId) {
  try {
    return localStorage.getItem(STORAGE_PREFIX + userId) || 'ping';
  } catch {
    return 'ping';
  }
}

export function setTone(userId, toneId) {
  try {
    localStorage.setItem(STORAGE_PREFIX + userId, toneId);
  } catch {
    /* private browsing — the choice just will not persist */
  }
}

// One context for the whole app. Browsers cap how many can exist, and
// creating one per notification leaks them.
let ctx = null;
function audio() {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  // Autoplay policy: a context created before the user has interacted with
  // the page starts suspended. Opening the chat panel is a click, so by the
  // time a tone is due this normally resolves.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// One note: frequency, when it starts, how long, how loud, what shape.
function note(ac, { freq, at = 0, dur = 0.16, gain = 0.14, type = 'sine' }) {
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ac.currentTime + at);
  // A short fade in and an exponential fade out. Without the envelope the
  // start and end of the note click audibly.
  vol.gain.setValueAtTime(0.0001, ac.currentTime + at);
  vol.gain.exponentialRampToValueAtTime(gain, ac.currentTime + at + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + at + dur);
  osc.connect(vol).connect(ac.destination);
  osc.start(ac.currentTime + at);
  osc.stop(ac.currentTime + at + dur + 0.02);
}

// A note that slides from one pitch to another.
function slide(ac, { from, to, at = 0, dur = 0.18, gain = 0.13, type = 'sine' }) {
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, ac.currentTime + at);
  osc.frequency.exponentialRampToValueAtTime(to, ac.currentTime + at + dur);
  vol.gain.setValueAtTime(0.0001, ac.currentTime + at);
  vol.gain.exponentialRampToValueAtTime(gain, ac.currentTime + at + 0.015);
  vol.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + at + dur);
  osc.connect(vol).connect(ac.destination);
  osc.start(ac.currentTime + at);
  osc.stop(ac.currentTime + at + dur + 0.02);
}

const RECIPES = {
  ping: (ac) => note(ac, { freq: 880, dur: 0.22, gain: 0.13 }),
  double: (ac) => {
    note(ac, { freq: 740, dur: 0.1, gain: 0.12 });
    note(ac, { freq: 988, dur: 0.14, gain: 0.12, at: 0.12 });
  },
  chime: (ac) => {
    note(ac, { freq: 523.25, dur: 0.16, gain: 0.1, type: 'triangle' });
    note(ac, { freq: 659.25, dur: 0.16, gain: 0.1, type: 'triangle', at: 0.1 });
    note(ac, { freq: 783.99, dur: 0.3, gain: 0.11, type: 'triangle', at: 0.2 });
  },
  knock: (ac) => {
    note(ac, { freq: 196, dur: 0.09, gain: 0.16, type: 'triangle' });
    note(ac, { freq: 174.6, dur: 0.11, gain: 0.14, type: 'triangle', at: 0.13 });
  },
  bubble: (ac) => slide(ac, { from: 420, to: 960, dur: 0.2, gain: 0.12 }),
  alert: (ac) => {
    note(ac, { freq: 1046.5, dur: 0.1, gain: 0.15, type: 'square' });
    note(ac, { freq: 1046.5, dur: 0.1, gain: 0.15, type: 'square', at: 0.14 });
    note(ac, { freq: 1318.5, dur: 0.18, gain: 0.14, type: 'square', at: 0.28 });
  },
  silent: () => {},
};

/**
 * Browsers only let a page play sound after the person has interacted with
 * it. Calling this from a click or key press unlocks audio for the rest of
 * the session, so a reminder that arrives later can actually be heard.
 */
export function primeAudio() {
  try { audio(); } catch { /* no Web Audio — reminders stay silent */ }
}

/**
 * Play a tone by id. Safe to call anywhere: a browser with no Web Audio, a
 * blocked autoplay policy or an unknown tone id all end as silence rather
 * than an exception, because a notification sound must never be able to
 * break the thing it is notifying about.
 */
export function playTone(toneId) {
  if (!toneId || toneId === 'silent') return;
  const recipe = RECIPES[toneId];
  if (!recipe) return;
  try {
    const ac = audio();
    if (ac) recipe(ac);
  } catch {
    /* ignore — silence is an acceptable outcome */
  }
}
