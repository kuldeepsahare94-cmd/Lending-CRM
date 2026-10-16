import { createContext, useContext, useEffect, useState } from 'react';

/*
 * Themes change the ACCENT. They do not change the surface system.
 *
 * This file used to set --color-ink, --color-canvas and --color-line as
 * inline styles on <html>, which outrank anything a stylesheet declares —
 * so index.css could define the palette perfectly and still be overruled on
 * every page load. The default theme was a warm cream set (#F6F5F1 canvas,
 * #E2E0D8 line), which is why the product rendered slightly beige no matter
 * what the design tokens said.
 *
 * Now index.css is the single source of truth for neutrals, exactly once,
 * and a theme only swaps the accent. That is also better design: a page is
 * built from one light background, one white card, one subtle border and
 * ONE accent — so the accent is the only part that should vary.
 */
const NEUTRALS = { ink: '#17233C', canvas: '#F7F8FC', good: '#10B981' };

export const THEMES = {
  indigo:  { name: 'Indigo',  accent: '#6C4FF7', accentSoft: '#F0EDFF', ...NEUTRALS },
  violet:  { name: 'Violet',  accent: '#8B5CF6', accentSoft: '#F5F3FF', ...NEUTRALS },
  ocean:   { name: 'Ocean',   accent: '#3B82F6', accentSoft: '#EFF6FF', ...NEUTRALS },
  teal:    { name: 'Teal',    accent: '#14B8A6', accentSoft: '#ECFDF9', ...NEUTRALS },
  emerald: { name: 'Emerald', accent: '#10B981', accentSoft: '#ECFDF5', ...NEUTRALS },
  rose:    { name: 'Rose',    accent: '#F43F5E', accentSoft: '#FFF1F2', ...NEUTRALS },
};

export const DEFAULT_THEME = 'indigo';

// 'amber' was the old default, and its cream palette is the one thing that
// actively contradicts the current design system. Anyone still carrying it
// in localStorage is carrying a default they never chose, so it maps to the
// new default rather than leaving them on a palette the product no longer
// uses. Named themes someone did pick are left alone.
const LEGACY = { amber: DEFAULT_THEME };

export function resolveThemeKey(stored) {
  const key = LEGACY[stored] || stored;
  return THEMES[key] ? key : DEFAULT_THEME;
}

const ThemeContext = createContext(null);

function applyTheme(key) {
  const t = THEMES[key] || THEMES[DEFAULT_THEME];
  const root = document.documentElement.style;
  // Accent only. Everything else is owned by index.css.
  root.setProperty('--color-brand', t.accent);
  root.setProperty('--color-brand-soft', t.accentSoft);
  // Legacy alias — plenty of existing components still say `text-amber`.
  root.setProperty('--color-amber', t.accent);
  root.setProperty('--color-amber-soft', t.accentSoft);
}

function applyDark(on) {
  document.documentElement.classList.toggle('dark-mode', on);
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => resolveThemeKey(localStorage.getItem('cd_theme')));
  const [dark, setDarkState] = useState(() => localStorage.getItem('cd_dark') === '1');

  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => { applyDark(dark); }, [dark]);

  const setTheme = (key) => {
    const resolved = resolveThemeKey(key);
    localStorage.setItem('cd_theme', resolved);
    setThemeState(resolved);
  };

  const setDark = (on) => {
    localStorage.setItem('cd_dark', on ? '1' : '0');
    setDarkState(on);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, dark, setDark }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
