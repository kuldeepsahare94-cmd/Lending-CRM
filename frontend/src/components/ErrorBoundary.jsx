import { Component } from 'react';

/* ------------------------------------------------------------------
   Catches render-time errors anywhere below it.

   Without this, a single component throwing during render unmounts the
   entire React tree and leaves a blank white page with nothing on screen
   — which is exactly the failure mode this app hit in production.

   The real error stays in the console for developers; the user gets
   something they can act on.
   ------------------------------------------------------------------ */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[iCRM] Unhandled render error:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    // A background helper (e.g. the reminder popups) passes fallback={null}:
    // if it fails, it disappears quietly instead of covering the page.
    if (this.props.fallback !== undefined) return this.props.fallback;

    return (
      <div style={{
        fontFamily: 'Inter, Segoe UI, sans-serif', background: '#F7F8FC',
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}>
        <div style={{
          background: '#fff', border: '1px solid #E7E9F0', borderRadius: 12,
          padding: 28, maxWidth: 520, textAlign: 'center',
        }}>
          <h1 style={{ fontSize: 18, color: '#101423', margin: '0 0 8px' }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: '#6B7280', lineHeight: 1.6, margin: '0 0 18px' }}>
            This screen hit an unexpected error. The rest of the app is unaffected —
            reloading usually clears it.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={() => window.location.reload()}
              style={{ background: '#4F46E5', color: '#fff', border: 0, padding: '10px 18px', borderRadius: 8, fontSize: 14, cursor: 'pointer' }}
            >
              Reload
            </button>
            <button
              onClick={() => { window.location.href = '/'; }}
              style={{ background: '#fff', color: '#101423', border: '1px solid #E7E9F0', padding: '10px 18px', borderRadius: 8, fontSize: 14, cursor: 'pointer' }}
            >
              Back to dashboard
            </button>
          </div>
          <details style={{ marginTop: 18, textAlign: 'left' }}>
            <summary style={{ fontSize: 12, color: '#9CA3AF', cursor: 'pointer' }}>Technical details</summary>
            <pre style={{
              fontSize: 11, color: '#6B7280', whiteSpace: 'pre-wrap',
              wordBreak: 'break-word', marginTop: 8, maxHeight: 200, overflow: 'auto',
            }}>
              {String(this.state.error?.stack || this.state.error)}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
