/*
 * Speak instead of typing: the phone's own speech recognition (free, Google's on
 * Android), in English, Hindi or Marathi. In a browser (testing), the browser's.
 */
import { Capacitor } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { get, set } from './store';

export const LANGS = [
  { code: 'en-IN', label: 'English' },
  { code: 'hi-IN', label: 'हिंदी' },
  { code: 'mr-IN', label: 'मराठी' },
];
export const voiceLang = () => get('voice_lang', 'en-IN') || 'en-IN';
export const setVoiceLang = (code) => set('voice_lang', code);

const native = Capacitor.isNativePlatform();
const WebSR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

export async function voiceAvailable() {
  if (native) {
    try { return (await SpeechRecognition.available()).available; } catch { return false; }
  }
  return !!WebSR;
}

export class VoiceError extends Error {}

/** Listen once; resolves with what was said ('' when nothing). */
export async function listen(lang = voiceLang()) {
  if (native) {
    let p = await SpeechRecognition.checkPermissions().catch(() => ({ speechRecognition: 'prompt' }));
    if (p.speechRecognition !== 'granted') p = await SpeechRecognition.requestPermissions().catch(() => ({ speechRecognition: 'denied' }));
    if (p.speechRecognition !== 'granted') throw new VoiceError('Allow the microphone for iCRM (Settings → Apps → iCRM → Permissions).');
    try {
      const r = await SpeechRecognition.start({ language: lang, maxResults: 1, prompt: 'Speak now', partialResults: false, popup: true });
      return ((r && r.matches && r.matches[0]) || '').trim();
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/^\s*(6|7)\s*$|no match|didn't understand|no speech|timeout/i.test(m)) return '';
      throw new VoiceError('Speech could not be heard. Try again.');
    }
  }
  if (!WebSR) throw new VoiceError('Speaking is not possible here.');
  return new Promise((resolve, reject) => {
    const r = new WebSR();
    r.lang = lang; r.interimResults = false; r.maxAlternatives = 1;
    let said = '';
    r.onresult = (ev) => { said = Array.from(ev.results).map((x) => x[0].transcript).join(' '); };
    r.onerror = (ev) => (ev.error === 'no-speech' || ev.error === 'aborted' ? resolve('') : reject(new VoiceError(ev.error === 'not-allowed' ? 'Allow the microphone.' : 'Speech could not be heard. Try again.')));
    r.onend = () => resolve(said.trim());
    try { r.start(); } catch (e) { reject(new VoiceError(e.message)); }
  });
}

/** add spoken text after what is already typed */
export const joinText = (before, said) => (!said ? before : !before ? said : `${before}${/\s$/.test(before) ? '' : ' '}${said}`);
