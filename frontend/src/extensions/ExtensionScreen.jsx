/*
 * Renders one customer's bespoke screen, and contains its failures.
 *
 * A screen written for a single customer will sometimes be half-finished, or
 * broken by a data shape nobody anticipated. Without a boundary, one bad
 * render takes the whole React tree down and the customer sees a white page
 * where their CRM used to be — from a feature they may not even use.
 *
 * So every extension screen is wrapped: if it throws, the rest of the CRM
 * keeps working and the failure is reported in place, with enough detail for
 * whoever wrote it.
 */
import { Component, Suspense, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { AlertTriangle, Puzzle, ChevronLeft } from 'lucide-react';
import { loadExtensionScreens } from './loader';
import { EmptyState } from '../components/ui';

class ScreenBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error(`[ext] screen "${this.props.name}" crashed:`, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border px-4 py-4 mt-5"
          style={{ background: '#FEF2F2', borderColor: '#FECACA' }}>
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#B91C1C' }} />
            <div className="min-w-0">
              <p className="text-sm font-semibold" style={{ color: '#991B1B' }}>
                This screen stopped working
              </p>
              <p className="text-xs mt-1" style={{ color: '#991B1B' }}>
                The “{this.props.name}” feature hit an error. The rest of the CRM is unaffected.
              </p>
              <pre className="text-[11px] mt-2 overflow-x-auto whitespace-pre-wrap" style={{ color: '#7F1D1D' }}>
                {String(this.state.error && this.state.error.message)}
              </pre>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function ExtensionScreen() {
  const { route } = useParams();
  const [screens, setScreens] = useState(null);

  useEffect(() => {
    let alive = true;
    loadExtensionScreens().then((s) => { if (alive) setScreens(s); });
    return () => { alive = false; };
  }, []);

  if (screens === null) {
    return <div className="max-w-[1600px] mx-auto"><p className="t-meta mt-8">Loading…</p></div>;
  }

  const screen = screens.find((s) => s.route === route || s.name === route);

  if (!screen) {
    return (
      <div className="max-w-[1600px] mx-auto mt-6">
        <EmptyState icon={Puzzle} title="No such screen"
          description="This feature is not installed for this account." />
      </div>
    );
  }

  if (screen.error) {
    return (
      <div className="max-w-[1600px] mx-auto">
        <Link to="/" className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-muted)] hover:text-ink mb-3">
          <ChevronLeft className="w-4 h-4" /> Back
        </Link>
        <div className="rounded-xl border px-4 py-4"
          style={{ background: '#FFFBEB', borderColor: '#FDE68A' }}>
          <p className="text-sm font-semibold" style={{ color: '#92400E' }}>
            “{screen.label}” could not be loaded
          </p>
          <p className="text-xs mt-1" style={{ color: '#92400E' }}>{screen.error}</p>
          <p className="text-xs mt-2" style={{ color: '#92400E' }}>
            Nothing else is affected. Whoever wrote this feature needs the message above.
          </p>
        </div>
      </div>
    );
  }

  const Screen = screen.component;
  return (
    <div className="max-w-[1600px] mx-auto">
      <ScreenBoundary name={screen.label}>
        <Suspense fallback={<p className="t-meta mt-8">Loading…</p>}>
          <Screen />
        </Suspense>
      </ScreenBoundary>
    </div>
  );
}
