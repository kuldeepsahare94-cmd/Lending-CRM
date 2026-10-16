// Shown in place of a record the signed-in person's role does not let them
// see (Settings → Roles → "Can see": own / own + team), or that could not be
// loaded. The server's own sentence says why.
import { Link } from 'react-router-dom';
import { Lock, AlertCircle, ArrowLeft } from 'lucide-react';

export default function NoAccess({ error, backTo, backLabel = 'Back to the list', onRetry }) {
  const denied = error?.code === 'NOT_YOURS' || error?.status === 403;
  const missing = error?.status === 404;
  const Icon = denied ? Lock : AlertCircle;
  return (
    <div className="card p-10 text-center max-w-xl mx-auto mt-10" role="alert" data-no-access={denied ? 'denied' : 'error'}>
      <div className="w-12 h-12 rounded-full mx-auto flex items-center justify-center mb-3"
        style={{
          background: denied ? 'var(--color-warning-soft)' : 'var(--color-danger-soft)',
          color: denied ? 'var(--color-warning-strong, var(--color-warning))' : 'var(--color-danger)',
        }}>
        <Icon className="w-6 h-6" />
      </div>
      <p className="t-section mb-1">
        {denied ? 'You cannot open this record' : missing ? 'This record was not found' : 'This record could not be opened'}
      </p>
      <p className="t-meta mb-4">
        {denied
          ? (error?.message || 'It belongs to someone else.')
          : missing ? 'It may have been deleted or merged into another record.' : (error?.message || 'Please try again.')}
        {denied && <><br />If you need it, ask its owner or your manager to assign it to you.</>}
      </p>
      <div className="flex items-center justify-center gap-2 flex-wrap">
        {backTo && (
          <Link to={backTo} className="btn btn-secondary">
            <ArrowLeft className="w-4 h-4" /> {backLabel}
          </Link>
        )}
        {!denied && !missing && onRetry && <button type="button" onClick={onRetry} className="btn btn-primary">Try again</button>}
      </div>
    </div>
  );
}
