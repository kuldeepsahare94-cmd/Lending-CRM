/*
 * Sign-in page — "iCRM by ipercepts".
 *
 * Plain and fast: a user ID and a password. If they match, the person is in;
 * if not, the page says "User ID or password is not correct." No animation,
 * mascot or extra step stands between the button and the dashboard.
 *
 * WHY THE FIRST SIGN-IN CAN STILL BE SLOW
 * On a free Render plan the backend sleeps when nobody uses it and needs up
 * to a minute to wake. So the page pings the server the moment it opens (it
 * wakes while the person is typing), and if signing in still takes more than
 * a few seconds it says the server is waking up instead of looking stuck.
 *
 * The request is made here directly rather than through api.js, because the
 * shared request helper treats every 401 as "session expired" — on this page
 * a 401 means a wrong user ID or password, and must say so.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  User, Lock, Eye, EyeOff, ArrowRight, ShieldCheck, Cloud, TabletSmartphone,
  Users, BarChart3, Headset, Settings, AlertCircle, Loader2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { forgetThisBrowser } from '../components/followup/notify';

const API_ROOT = import.meta.env.VITE_API_BASE_URL || '';
const API = `${API_ROOT.replace(/\/+$/, '')}/api`;

// ---------------------------------------------------------------------------
// "Remember me"
//   ticked   — stay signed in on this browser (7 days, as before) and fill in
//              the user ID next time.
//   unticked — signed out when the browser is closed. A session cookie (it
//              dies with the browser) marks the sign-in as still current.
// This check runs when the app starts, before anything uses the saved token
// (App imports this page up front, so this module loads first).
// ---------------------------------------------------------------------------
const REMEMBER_KEY = 'cd_remember';
const LAST_USER_KEY = 'cd_last_username';
const LIVE_COOKIE = 'cd_live';

function hasLiveCookie() {
  return document.cookie.split(';').some((c) => c.trim().startsWith(`${LIVE_COOKIE}=`));
}

(function endSignInAfterBrowserClosed() {
  try {
    if (localStorage.getItem(REMEMBER_KEY) === '0' && !hasLiveCookie()) {
      const token = localStorage.getItem('cd_token');
      if (token) { try { forgetThisBrowser(token); } catch { /* best effort */ } }
      localStorage.removeItem('cd_token');
      localStorage.removeItem('cd_user');
      localStorage.removeItem(REMEMBER_KEY);
    }
  } catch { /* storage blocked — nothing to clear */ }
})();

function rememberChoice(remember, username) {
  try {
    if (remember) {
      localStorage.setItem(REMEMBER_KEY, '1');
      localStorage.setItem(LAST_USER_KEY, username);
    } else {
      localStorage.setItem(REMEMBER_KEY, '0');
      localStorage.removeItem(LAST_USER_KEY);
      const secure = window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${LIVE_COOKIE}=1; path=/; SameSite=Lax${secure}`;
    }
  } catch { /* storage blocked — sign-in still works for this visit */ }
}

function savedUsername() {
  try { return localStorage.getItem(LAST_USER_KEY) || ''; } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Brand marks (drawn, so they stay sharp at any size)
// ---------------------------------------------------------------------------
const NAVY = '#0C1A3A';
const BLUE = '#1677F2';

function IMark({ className = '', style }) {
  return (
    <svg viewBox="0 0 40 100" className={className} style={style} aria-hidden="true">
      <defs>
        <linearGradient id="imark-g" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="#2E9BFF" />
          <stop offset="1" stopColor="#0A5FDB" />
        </linearGradient>
      </defs>
      <circle cx="27" cy="12" r="11" fill="url(#imark-g)" />
      <path d="M15 32h19a4 4 0 0 1 4 4.6l-7.4 56.6a5 5 0 0 1-5 4.3H7.8a4 4 0 0 1-4-4.6l7.4-56.6a5 5 0 0 1 5-4.3z" fill="url(#imark-g)" />
    </svg>
  );
}

function ICrmLogo({ size }) {
  return (
    <span className="inline-flex items-baseline select-none" style={{ fontSize: size, lineHeight: 1, color: NAVY, fontWeight: 800, letterSpacing: '-0.035em' }}>
      <IMark style={{ height: '0.74em', width: '0.3em', marginRight: '0.05em' }} />
      <span>CRM</span>
    </span>
  );
}

function IperceptsLogo({ size = 26, tagline = false }) {
  return (
    <span className="inline-flex flex-col select-none">
      <span className="inline-flex items-baseline" style={{ fontSize: size, lineHeight: 1, color: NAVY, fontWeight: 700, letterSpacing: '-0.02em' }}>
        <IMark style={{ height: '0.72em', width: '0.29em', marginRight: '0.03em' }} />
        <span>percepts</span>
      </span>
      {tagline && <span className="text-[12px] mt-1" style={{ color: '#334155' }}>Technology for Growth</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The landscape behind the page: sky, clouds, mountains, the path to the flag
// ---------------------------------------------------------------------------
function Pine({ x, y, h, fill }) {
  const w = h * 0.46;
  return (
    <g transform={`translate(${x} ${y})`} fill={fill}>
      <rect x={-h * 0.03} y={-h * 0.12} width={h * 0.06} height={h * 0.14} />
      <path d={`M0 ${-h} L${w * 0.32} ${-h * 0.7} L${w * 0.16} ${-h * 0.7} L${w * 0.42} ${-h * 0.42} L${w * 0.22} ${-h * 0.42} L${w * 0.5} ${-h * 0.1} L${-w * 0.5} ${-h * 0.1} L${-w * 0.22} ${-h * 0.42} L${-w * 0.42} ${-h * 0.42} L${-w * 0.16} ${-h * 0.7} L${-w * 0.32} ${-h * 0.7} Z`} />
    </g>
  );
}

const TREES = [
  // [x, y, height, colour]
  [575, 1004, 70, '#2B5FA6'], [600, 990, 96, '#1E4B8C'], [628, 1010, 78, '#2A62AC'], [652, 985, 118, '#173F7A'],
  [682, 1000, 92, '#1E4B8C'], [708, 978, 132, '#153A72'], [736, 1004, 84, '#2458A0'], [760, 990, 104, '#1B447F'],
  [786, 1012, 70, '#2B5FA6'], [812, 982, 126, '#163C76'], [842, 1000, 96, '#1F4D8E'], [868, 976, 140, '#133568'],
  [900, 998, 104, '#1C4683'], [640, 930, 46, '#6F9BD6'], [668, 924, 52, '#5B8BCB'], [720, 916, 58, '#5B8BCB'],
  [778, 922, 50, '#6F9BD6'], [836, 912, 60, '#5485C6'], [452, 900, 40, '#7FA7DC'], [478, 894, 48, '#6F9BD6'],
];

function Scenery() {
  return (
    <svg className="absolute inset-0 w-full h-full" viewBox="0 0 1536 1024" preserveAspectRatio="xMinYMax slice" aria-hidden="true">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="1" y2="0.35">
          <stop offset="0" stopColor="#F4F9FE" />
          <stop offset="0.45" stopColor="#D3E8FC" />
          <stop offset="1" stopColor="#86BCF2" />
        </linearGradient>
        <linearGradient id="haze" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.35" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="0.62" stopColor="#FFFFFF" stopOpacity="0.55" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.2" />
        </linearGradient>
        <linearGradient id="peak" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5E97DF" />
          <stop offset="1" stopColor="#9CC4F0" />
        </linearGradient>
        <linearGradient id="peakDark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3F78C8" />
          <stop offset="1" stopColor="#7FAEE8" />
        </linearGradient>
        <filter id="soft" x="-20%" y="-50%" width="140%" height="200%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
      </defs>

      <rect width="1536" height="1024" fill="url(#sky)" />

      {/* clouds */}
      <g fill="#FFFFFF" filter="url(#soft)">
        <g opacity="0.85"><ellipse cx="560" cy="120" rx="170" ry="38" /><ellipse cx="640" cy="96" rx="110" ry="40" /><ellipse cx="480" cy="140" rx="120" ry="26" /></g>
        <g opacity="0.75"><ellipse cx="1180" cy="80" rx="220" ry="46" /><ellipse cx="1290" cy="60" rx="140" ry="40" /></g>
        <g opacity="0.7"><ellipse cx="820" cy="300" rx="190" ry="34" /><ellipse cx="900" cy="280" rx="120" ry="30" /></g>
        <g opacity="0.8"><ellipse cx="1420" cy="360" rx="200" ry="44" /><ellipse cx="1340" cy="390" rx="160" ry="30" /></g>
        <g opacity="0.6"><ellipse cx="120" cy="560" rx="220" ry="40" /><ellipse cx="300" cy="590" rx="180" ry="30" /></g>
        <g opacity="0.65"><ellipse cx="1030" cy="520" rx="200" ry="36" /></g>
      </g>

      {/* far range */}
      <path d="M0 700 L90 660 L170 690 L260 620 L330 650 L420 590 L500 640 L560 610 L640 650 L700 600 L780 640 L860 580 L950 630 L1040 570 L1130 620 L1220 560 L1320 610 L1420 570 L1536 600 V1024 H0Z" fill="#C3DBF5" />
      <path d="M260 620 L300 640 L285 646 L330 650 L420 590 L445 620 L430 624 L470 640 L500 640 L420 590 L360 632 L330 650Z" fill="#F2F8FE" opacity="0.8" />

      {/* left mid range */}
      <path d="M0 780 L110 720 L200 750 L330 660 L420 700 L520 650 L600 700 L640 760 L0 840Z" fill="#A9CAF0" />
      <path d="M330 660 L352 690 L338 694 L380 712 L420 700 L372 676Z M520 650 L548 682 L532 686 L574 700 L600 700 L560 664Z" fill="#F4F9FF" />

      {/* main peak (the one with the flag) */}
      <path d="M470 820 L560 740 L620 700 L690 640 L741 600 L790 650 L850 700 L930 760 L1010 800 L1010 900 L470 900Z" fill="url(#peak)" />
      <path d="M741 600 L790 650 L850 700 L930 760 L1010 800 L1010 900 L820 900 L800 780 L770 690Z" fill="url(#peakDark)" opacity="0.8" />
      <path d="M741 600 L720 640 L730 646 L700 690 L716 694 L676 740 L700 744 L650 800 L741 700 L752 650Z" fill="#F5FAFF" />
      <path d="M741 600 L760 628 L748 640 L770 690 L741 660Z" fill="#DCEBFB" />
      <path d="M470 900 L470 820 L560 740 L600 760 L560 800 L600 820 L540 860 Z" fill="#8BB6EA" opacity="0.7" />

      {/* haze over the lower slopes */}
      <rect width="1536" height="1024" fill="url(#haze)" />

      {/* the winding path up to the flag */}
      <g fill="none" stroke="#FFFFFF" strokeLinecap="round" strokeLinejoin="round">
        <path d="M430 1030 C 470 960, 640 950, 620 900" strokeWidth="46" />
        <path d="M620 900 C 600 850, 520 850, 560 810" strokeWidth="30" />
        <path d="M560 810 C 600 770, 680 770, 670 730" strokeWidth="18" />
        <path d="M670 730 C 660 690, 700 680, 715 660 C 728 640, 736 624, 741 604" strokeWidth="8" />
      </g>
      <g fill="none" stroke="#D5E6F9" strokeLinecap="round" opacity="0.8">
        <path d="M452 1030 C 492 966, 652 956, 634 904" strokeWidth="6" />
      </g>

      {/* flag */}
      <line x1="741" y1="604" x2="741" y2="532" stroke="#162B55" strokeWidth="3.5" strokeLinecap="round" />
      <path d="M743 535 C 760 530, 772 546, 796 538 L786 556 L798 572 C 776 580, 762 566, 743 572 Z" fill="#2F86F6" />

      {/* trees */}
      {TREES.map(([x, y, h, fill], i) => <Pine key={i} x={x} y={y} h={h} fill={fill} />)}

      {/* white wave, bottom left */}
      <path d="M0 770 C 180 780, 420 860, 640 1024 L0 1024Z" fill="#E4F0FC" opacity="0.9" />
      <path d="M0 810 C 200 822, 420 900, 600 1024 L0 1024Z" fill="#FFFFFF" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
const FEATURES = [
  { icon: Users, label: ['Manage', 'Leads & Customers'], bg: '#DBEAFE', fg: '#2563EB' },
  { icon: BarChart3, label: ['Track', 'Sales & Revenue'], bg: '#D1FAE5', fg: '#16A34A' },
  { icon: Headset, label: ['Deliver', 'Better Support'], bg: '#EDE9FE', fg: '#7C3AED' },
  { icon: Settings, label: ['Streamline', 'Your Operations'], bg: '#FFEDD5', fg: '#F97316' },
];

const BADGES = [
  { icon: ShieldCheck, label: ['Secure', 'Access'] },
  { icon: Cloud, label: ['Cloud', 'Ready'] },
  { icon: TabletSmartphone, label: ['Access', 'Anywhere'] },
];

const SLOW_AFTER_MS = 4000;

// Sizes follow the screen height as well as its width, so the whole page fits
// on a 1366×768 laptop without scrolling.
const PAGE_CSS = `
.icrm-login { --gap: clamp(10px, 2.3vh, 24px); }
.icrm-login :focus-visible { outline-color: #1677F2; }
.icrm-login .li-input { height: clamp(44px, 6.4vh, 52px); }
.icrm-login .li-input:focus { outline: none; border-color: #1677F2 !important; box-shadow: 0 0 0 4px rgba(22,119,242,0.15); }
.icrm-login .li-card { padding: clamp(20px, 3.8vh, 48px) clamp(20px, 3.6vw, 56px); }
.icrm-login .li-btn { height: clamp(46px, 7vh, 58px); }
/* The four feature icons.
   Tall screens: a small row under the text, above the mountains.
   Shorter screens (most laptops): the text block would push that row onto
   the mountain, so a compact 2 × 2 version sits at the bottom left, on the
   snow, where nothing is behind it. */
.icrm-login .li-features-row { display: flex; gap: 26px; margin-top: calc(var(--gap) * 1.3); }
.icrm-login .li-features-row .li-feature { width: 46px; height: 46px; }
.icrm-login .li-features-row .li-feature svg { width: 21px; height: 21px; }
.icrm-login .li-features-row .li-feature-label { margin-top: 7px; font-size: 13px; line-height: 1.3; }
.icrm-login .li-features-grid { display: none; }
@media (max-height: 859px) {
  .icrm-login .li-tagline { display: none; }
  .icrm-login .li-features-row { display: none; }
  .icrm-login .li-features-grid {
    display: grid; grid-template-columns: auto auto; column-gap: 22px; row-gap: 10px;
    position: absolute; left: 3.5rem; bottom: clamp(12px, 3vh, 26px);   /* 3.5rem = the page's side padding */
  }
  .icrm-login .li-features-grid li { display: flex; align-items: center; gap: 9px; }
  .icrm-login .li-features-grid .li-feature { width: 32px; height: 32px; }
  .icrm-login .li-features-grid .li-feature svg { width: 16px; height: 16px; }
  .icrm-login .li-features-grid .li-feature-label { font-size: 12px; line-height: 1.25; }
  .icrm-login .li-story-text { max-width: 500px; }
}
@media (max-width: 1279px) { .icrm-login .li-features-grid { display: none; } }
`;

function Features({ className }) {
  return (
    <ul className={className}>
      {FEATURES.map(({ icon: Icon, label, bg, fg }) => (
        <li key={label[1]} className={className === 'li-features-row' ? 'flex flex-col items-center text-center' : undefined}>
          <span className="li-feature rounded-full flex items-center justify-center shadow-sm shrink-0" style={{ background: bg }}>
            <Icon style={{ color: fg }} strokeWidth={2.2} />
          </span>
          <span className="li-feature-label font-medium" style={{ color: '#0F172A' }}>
            {label[0]}<br />{label[1]}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [username, setUsername] = useState(savedUsername);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(() => { try { return localStorage.getItem(REMEMBER_KEY) !== '0'; } catch { return true; } });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [slow, setSlow] = useState(false);
  const [forgot, setForgot] = useState(false);
  const passwordRef = useRef(null);

  useEffect(() => {
    // Wake the backend now, so it is ready by the time the password is typed.
    fetch(`${API}/health`, { cache: 'no-store' }).catch(() => {});
    // The handwritten line at the bottom left (only these letters are fetched).
    if (!document.getElementById('login-script-font')) {
      const link = document.createElement('link');
      link.id = 'login-script-font';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Caveat:wght@700&display=swap&text=TogetherTowardsGrowth.%20';
      document.head.appendChild(link);
    }
    if (savedUsername()) passwordRef.current?.focus();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    const user = username.trim();
    if (!user || !password) { setError('Enter your user ID and password.'); return; }
    setError('');
    setForgot(false);
    setSubmitting(true);
    const slowTimer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.token) {
        rememberChoice(remember, user);
        login(data.token, data.user);
        navigate('/', { replace: true });
        return;
      }
      if (res.status === 401 || res.status === 400) {
        setError('User ID or password is not correct.');
        setPassword('');
        passwordRef.current?.focus();
      } else if (res.status === 403 && data?.error) {
        setError(data.error);                       // account deactivated, or access restricted
      } else {
        setError('The server could not sign you in right now. Please try again in a minute.');
      }
    } catch {
      setError('Cannot reach the server. Check your internet connection and try again.');
    } finally {
      clearTimeout(slowTimer);
      setSlow(false);
      setSubmitting(false);
    }
  };

  const inputBox = 'li-input w-full rounded-[10px] border bg-white pl-11 pr-4 text-[15px] transition-shadow placeholder:text-slate-400';
  const borderColor = error ? '#F87171' : '#D5DDE8';

  return (
    <div className="icrm-login relative min-h-screen flex flex-col overflow-hidden" style={{ background: '#EAF4FE', color: NAVY, colorScheme: 'light' }}>
      <style>{PAGE_CSS}</style>
      <Scenery />

      {/* Company logo. On wide screens it floats over the top-left corner, so
          the sign-in card can use the full height of the screen. */}
      <div className="relative xl:absolute xl:top-0 xl:left-0 z-10 px-5 sm:px-10 lg:px-14" style={{ paddingTop: 'clamp(14px, 3.2vh, 34px)' }}>
        <IperceptsLogo size={26} tagline />
      </div>

      <div className="relative z-10 flex-1 w-full mx-auto max-w-[1480px] px-5 sm:px-10 lg:px-14 grid xl:grid-cols-[minmax(0,1fr)_minmax(460px,600px)] gap-10 items-center"
        style={{ paddingTop: 'clamp(8px, 2vh, 32px)', paddingBottom: 'clamp(12px, 3vh, 48px)' }}>

        {/* left: product story (large screens), starting near the top so the
            text stays above the mountains */}
        <div className="hidden xl:block self-start" style={{ paddingTop: 'clamp(84px, 14vh, 150px)' }}>
          <ICrmLogo size="clamp(64px, min(6.6vw, 12vh), 110px)" />
          <h1 className="font-bold leading-[1.1]" style={{ marginTop: 'var(--gap)', fontSize: 'clamp(28px, min(3vw, 5.4vh), 48px)', letterSpacing: '-0.02em' }}>
            All Your Business<br />Relationships. <span style={{ color: BLUE }}>Smarter.</span>
          </h1>
          <p className="li-story-text max-w-[560px] leading-relaxed" style={{ marginTop: 'var(--gap)', fontSize: 'clamp(15px, min(1.3vw, 2.6vh), 20px)', color: '#1E293B' }}>
            A powerful, flexible and industry-ready CRM to manage leads, customers, sales, projects, support and more — built for growing businesses.
          </p>
          <Features className="li-features-row" />
        </div>
        {/* the same four, compact, at the bottom left on shorter screens
            (placed by the stylesheet above; it takes no space in the layout) */}
        <Features className="li-features-grid" />

        {/* right: sign-in card */}
        <form onSubmit={submit} noValidate
          className="li-card w-full max-w-[600px] mx-auto xl:mx-0 xl:justify-self-end rounded-[24px] border border-white/70"
          style={{ background: 'rgba(255,255,255,0.94)', boxShadow: '0 30px 70px -30px rgba(15,45,100,0.45)', backdropFilter: 'blur(6px)' }}>
          <div className="text-center">
            <p className="font-medium" style={{ fontSize: 'clamp(18px, 3vh, 24px)', color: '#475569' }}>Welcome to</p>
            <div className="mt-1.5"><ICrmLogo size="clamp(46px, min(5vw, 8.4vh), 76px)" /></div>
            <div className="mt-1.5 inline-flex items-baseline gap-2" style={{ fontSize: 'clamp(16px, 2.6vh, 20px)', color: '#64748B' }}>
              by <IperceptsLogo size="clamp(20px, 3.2vh, 26px)" />
            </div>
            <p style={{ marginTop: 'calc(var(--gap) * 0.6)', fontSize: 'clamp(15px, 2.5vh, 19px)', color: '#475569' }}>Sign in to access your CRM workspace</p>
          </div>

          <div style={{ marginTop: 'calc(var(--gap) * 1.3)' }}>
            <label htmlFor="login-user" className="block text-[15px] sm:text-[16px] font-semibold mb-1.5" style={{ color: '#0F172A' }}>Username</label>
            <div className="relative">
              <User className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2" style={{ color: '#64748B' }} />
              <input id="login-user" autoComplete="username" autoFocus={!savedUsername()} value={username}
                onChange={(e) => { setUsername(e.target.value); if (error) setError(''); }}
                placeholder="Enter your username" className={inputBox}
                style={{ borderColor, paddingLeft: 46, color: NAVY }} aria-invalid={!!error} />
            </div>
          </div>

          <div style={{ marginTop: 'var(--gap)' }}>
            <label htmlFor="login-pass" className="block text-[15px] sm:text-[16px] font-semibold mb-1.5" style={{ color: '#0F172A' }}>Password</label>
            <div className="relative">
              <Lock className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2" style={{ color: '#64748B' }} />
              <input id="login-pass" ref={passwordRef} type={showPassword ? 'text' : 'password'} autoComplete="current-password"
                value={password} onChange={(e) => { setPassword(e.target.value); if (error) setError(''); }}
                placeholder="Enter your password" className={inputBox}
                style={{ borderColor, paddingLeft: 46, paddingRight: 50, color: NAVY }} aria-invalid={!!error} />
              <button type="button" onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-md hover:bg-slate-100"
                aria-label={showPassword ? 'Hide password' : 'Show password'} title={showPassword ? 'Hide password' : 'Show password'}>
                {showPassword ? <EyeOff className="w-5 h-5" style={{ color: '#64748B' }} /> : <Eye className="w-5 h-5" style={{ color: '#64748B' }} />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3" style={{ marginTop: 'calc(var(--gap) * 0.9)' }}>
            <label className="inline-flex items-center gap-2.5 cursor-pointer text-[15px]" style={{ color: '#1E293B' }}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)}
                className="w-[18px] h-[18px] rounded cursor-pointer" style={{ accentColor: BLUE }} />
              Remember me
            </label>
            <button type="button" onClick={() => setForgot((v) => !v)} className="text-[15px] font-medium hover:underline" style={{ color: BLUE }}>
              Forgot Password?
            </button>
          </div>

          {forgot && (
            <p className="mt-3 text-[13px] rounded-lg px-3 py-2" style={{ background: '#EFF6FF', color: '#1E3A8A' }}>
              Ask your CRM administrator to reset your password (Settings → Users).
            </p>
          )}

          {error && (
            <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg px-3 py-2.5 text-[14px] font-medium"
              style={{ background: '#FEF2F2', color: '#B91C1C', border: '1px solid #FECACA' }}>
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </div>
          )}

          <button type="submit" disabled={submitting}
            className="li-btn w-full rounded-[10px] text-white text-[17px] sm:text-[18px] font-semibold inline-flex items-center justify-center gap-2.5 transition-[filter] hover:brightness-105 disabled:opacity-80"
            style={{ marginTop: 'var(--gap)', background: 'linear-gradient(90deg, #1A8CFF 0%, #0B66E4 100%)', boxShadow: '0 10px 24px -10px rgba(11,102,228,0.7)' }}>
            {submitting ? <><Loader2 className="w-5 h-5 animate-spin" /> Signing in…</> : <>Sign In <ArrowRight className="w-5 h-5" /></>}
          </button>
          {slow && (
            <p className="mt-3 text-center text-[13px]" style={{ color: '#475569' }} role="status">
              Waking up the server — the first sign-in after a quiet spell can take up to a minute.
            </p>
          )}

          <div className="border-t grid grid-cols-3" style={{ borderColor: '#E2E8F0', marginTop: 'calc(var(--gap) * 1.2)', paddingTop: 'var(--gap)' }}>
            {BADGES.map(({ icon: Icon, label }, i) => (
              <div key={label.join(' ')} className="flex flex-col sm:flex-row items-center justify-center gap-1.5 sm:gap-2.5 px-1 text-center sm:text-left"
                style={i ? { borderLeft: '1px solid #E2E8F0' } : undefined}>
                <span className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ background: '#EFF6FF' }}>
                  <Icon className="w-5 h-5" style={{ color: BLUE }} />
                </span>
                <span className="text-[13px] sm:text-[14px] leading-tight" style={{ color: '#334155' }}>{label[0]}<br />{label[1]}</span>
              </div>
            ))}
          </div>
        </form>
      </div>

      {/* bottom-left line */}
      <p className="li-tagline hidden xl:block absolute z-10 left-12 bottom-10 select-none pointer-events-none"
        style={{ fontFamily: 'Caveat, "Segoe Script", cursive', fontWeight: 700, fontSize: 'clamp(40px, 3.6vw, 60px)', lineHeight: 0.95, color: NAVY, transform: 'rotate(-7deg)', transformOrigin: 'left bottom' }}>
        Together<br />
        <span className="relative">
          Towards <span style={{ color: BLUE }}>Growth.</span>
          <svg viewBox="0 0 300 20" className="absolute left-[20%] -bottom-3 w-[85%] h-4" aria-hidden="true">
            <path d="M4 14 C 90 4, 200 2, 296 8" stroke={BLUE} strokeWidth="5" fill="none" strokeLinecap="round" />
          </svg>
        </span>
      </p>
    </div>
  );
}
