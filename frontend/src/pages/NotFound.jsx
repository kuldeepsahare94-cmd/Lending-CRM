import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';

// Rendered for any URL that matches no route. Previously such a URL produced
// an empty React tree — visually identical to a crashed application — which
// is how a simple typo or stale bookmark looked like a total outage.
export default function NotFound() {
  return (
    <div className="max-w-lg mx-auto py-20 text-center">
      <div className="w-12 h-12 rounded-full mx-auto flex items-center justify-center mb-4"
        style={{ background: 'var(--color-neutral-soft)', color: 'var(--color-neutral)' }}>
        <Compass className="w-6 h-6" />
      </div>
      <h1 className="t-page-title mb-2">Page not found</h1>
      <p className="t-page-sub mb-6">
        That address doesn't match anything in the CRM. It may have moved, or the link may be out of date.
      </p>
      <div className="flex gap-2 justify-center flex-wrap">
        <Link to="/" className="btn btn-primary">Go to dashboard</Link>
        <Link to="/leads" className="btn btn-secondary">Go to leads</Link>
      </div>
    </div>
  );
}
