import { Check, Palette, Moon, Sun } from 'lucide-react';
import { THEMES, useTheme } from '../context/ThemeContext';
import { PageHeader } from '../components/ui';

export default function Appearance() {
  const { theme, setTheme, dark, setDark } = useTheme();

  return (
    <div className="w-full">
      <PageHeader
        title="Appearance"
        subtitle="Pick a theme — changes apply instantly, saved on this device."
        icon={Palette}
        accent="settings"
      />

      <div className="bg-white border border-line rounded-xl p-4 mt-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {dark ? <Moon className="w-4 h-4 text-ink" /> : <Sun className="w-4 h-4 text-ink" />}
          <div>
            <div className="text-sm font-medium text-ink">Dark mode</div>
            <div className="text-xs text-slate-400">Easier on the eyes for evening work</div>
          </div>
        </div>
        <button onClick={() => setDark(!dark)}
          className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${dark ? 'bg-amber' : 'bg-line'}`}>
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${dark ? 'left-5' : 'left-0.5'}`} />
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-8">
        {Object.entries(THEMES).map(([key, t]) => (
          <button key={key} onClick={() => setTheme(key)}
            className={`text-left rounded-xl border-2 overflow-hidden transition-all ${
              theme === key ? 'border-amber shadow-md' : 'border-line hover:border-ink/20'
            }`}>
            <div className="h-16 flex" style={{ background: t.canvas }}>
              <div className="w-1/3 h-full" style={{ background: t.ink }} />
              <div className="flex-1 flex items-center justify-center gap-2">
                <span className="w-4 h-4 rounded-full" style={{ background: t.accent }} />
                <span className="w-4 h-4 rounded-full" style={{ background: t.good }} />
              </div>
            </div>
            <div className="px-3 py-2.5 bg-white flex items-center justify-between">
              <span className="text-sm font-medium text-ink">{t.name}</span>
              {theme === key && <Check className="w-4 h-4 text-amber" />}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
