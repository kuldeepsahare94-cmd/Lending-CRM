/*
 * What a record page shows for the moment before its data arrives: the shape
 * of the page (header, tabs, cards) and, when you came from a list, the
 * record's name straight away — instead of a bare "Loading…" line. The page
 * appears to open at once and fills in around the name.
 */
import { avatarGradientFor, initialsOf } from '../theme/avatarColors';

export default function DetailSkeleton({ title }) {
  return (
    <div className="w-full space-y-4" aria-busy="true" aria-label={title ? `Opening ${title}` : 'Opening record'}>
      <div className="card p-5 flex items-center gap-4">
        {title ? (
          <span className="w-14 h-14 rounded-2xl flex items-center justify-center text-white text-lg font-bold shrink-0"
            style={{ background: avatarGradientFor(title) }}>
            {initialsOf(title)}
          </span>
        ) : <div className="skeleton w-14 h-14 rounded-2xl shrink-0" />}
        <div className="flex-1 min-w-0 space-y-2">
          {title
            ? <h1 className="text-xl font-bold text-ink truncate">{title}</h1>
            : <div className="skeleton h-6 w-56" />}
          <div className="skeleton h-4 w-80 max-w-full" />
        </div>
        <div className="hidden sm:flex gap-2">
          <div className="skeleton h-10 w-24 rounded-xl" />
          <div className="skeleton h-10 w-28 rounded-xl" />
        </div>
      </div>
      <div className="flex gap-5 px-1">
        {[70, 60, 55, 70, 60].map((w, i) => <div key={i} className="skeleton h-4" style={{ width: w }} />)}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="card p-5 space-y-3">
            <div className="skeleton h-4 w-32" />
            {[0, 1, 2, 3, 4].map((r) => (
              <div key={r} className="flex justify-between gap-4">
                <div className="skeleton h-3.5 w-24" />
                <div className="skeleton h-3.5 w-32" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
