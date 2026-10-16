import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Database, History, Download, Upload, FileText, GitMerge, ArrowRight, Columns3, AlertTriangle, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader } from '../components/ui';

const inputClass = 'border border-line rounded-lg px-3 py-1.5 text-sm';

/* ------------------------------------------------------------------
   Match your columns

   Every column of the file, and the CRM field it goes to. The CRM fills
   this in by itself — it compares the column's heading with each field's
   LABEL ("Name"), not with the name the field has in the database
   (student_name) — and the person importing can change any of them:
   another field, a new field, or "do not import".
   ------------------------------------------------------------------ */
const NEW_FIELD = '__new__';
const SKIP = '__skip__';
const HOW = {
  'field label': 'Matched by label',
  'exact name': 'Matched by name',
  'name match': 'Matched by name',
  'similar name': 'Similar name',
  'your choice': 'Your choice',
};

function ColumnMatcher({ analysis, analysing, moduleLabel, changed, onChoose, onReset }) {
  const usedBy = useMemo(
    () => new Map(analysis.columns.filter((c) => c.action === 'map').map((c) => [c.field, c])),
    [analysis],
  );
  const byLabel = (a, b) => a.label.localeCompare(b.label);
  const main = useMemo(() => analysis.fields.filter((f) => f.listed).sort(byLabel), [analysis]);
  const more = useMemo(() => analysis.fields.filter((f) => !f.listed).sort(byLabel), [analysis]);
  const count = (action) => analysis.columns.filter((c) => c.action === action).length;

  const option = (f, column) => {
    const other = usedBy.get(f.key);
    const taken = other && other.index !== column.index;
    return (
      <option key={f.key} value={f.key} disabled={taken}>
        {f.label}{f.required ? ' *' : ''}{f.hint ? ` (${f.hint})` : ''}{taken ? ` — used by “${other.header}”` : ''}
      </option>
    );
  };

  return (
    <div className="mt-4 rounded-xl border border-line overflow-hidden" data-import-mapping>
      <div className="px-3.5 py-3 border-b border-line bg-canvas flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Columns3 className="w-3.5 h-3.5 text-amber" /> Match your columns
            {analysing && <span className="font-normal text-slate-400">· checking…</span>}
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Each column of your file goes to one {moduleLabel} field. The CRM matched them by the field&apos;s label —
            change any of them, create a new field, or leave a column out.
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap text-[11px] font-medium" data-mapping-summary>
          <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">{count('map')} matched</span>
          {count('new') > 0 && <span className="px-2 py-0.5 rounded-full bg-sky-50 text-sky-700">{count('new')} new field{count('new') > 1 ? 's' : ''}</span>}
          {count('skip') > 0 && <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">{count('skip')} not imported</span>}
          {changed && (
            <button type="button" onClick={onReset} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-line text-slate-500 hover:text-ink">
              <RotateCcw className="w-3 h-3" /> Reset
            </button>
          )}
        </div>
      </div>

      {/* What must be fixed before importing — above the list, so it is seen. */}
      {(analysis.problems?.length > 0 || analysis.missing_required?.length > 0) && (
        <div className="px-3.5 py-2.5 border-b border-line text-xs bg-red-50 text-warn space-y-1" data-mapping-problems>
          {analysis.missing_required?.length > 0 && (
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                No column is matched to <strong>{analysis.missing_required.join(', ')}</strong>. A record cannot be saved
                without {analysis.missing_required.length > 1 ? 'them' : 'it'} — choose the column that holds it.
              </span>
            </div>
          )}
          {(analysis.problems || []).map((p) => (
            <div key={p} className="flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{p}</span></div>
          ))}
        </div>
      )}

      <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-white z-[1]">
            <tr className="text-left text-slate-400 border-b border-line">
              <th className="py-2 px-3.5 font-medium">Column in your file</th>
              <th className="py-2 px-1 w-6" />
              <th className="py-2 px-2 font-medium">Goes to this CRM field</th>
              <th className="py-2 px-3.5 font-medium">How</th>
            </tr>
          </thead>
          <tbody>
            {analysis.columns.map((c) => {
              const value = c.action === 'map' ? c.field : c.action === 'new' ? NEW_FIELD : SKIP;
              return (
                <tr key={c.index} className="border-b border-line/60 align-top" data-column={c.header}>
                  <td className="py-2 px-3.5 max-w-[260px]">
                    <div className="font-semibold text-ink break-words">{c.header || <span className="text-slate-400">(no heading)</span>}</div>
                    <div className="text-slate-400 truncate" title={c.samples.join(' · ')}>
                      {c.samples.length ? c.samples.join(' · ') : 'empty in every row'}
                    </div>
                  </td>
                  <td className="py-3 px-1 text-slate-300"><ArrowRight className="w-3.5 h-3.5" /></td>
                  <td className="py-2 px-2">
                    <select value={value} onChange={(e) => onChoose(c.index, e.target.value)}
                      aria-label={`Field for column ${c.header || c.index + 1}`}
                      className={`border rounded-lg px-2 py-1.5 text-xs w-full min-w-[220px] max-w-[340px] ${
                        c.action === 'skip' ? 'border-line text-slate-400' : c.action === 'new' ? 'border-sky-300 text-ink' : 'border-line text-ink'}`}>
                      <optgroup label={`${moduleLabel} fields`}>{main.map((f) => option(f, c))}</optgroup>
                      {more.length > 0 && <optgroup label="More columns">{more.map((f) => option(f, c))}</optgroup>}
                      <optgroup label="Or">
                        <option value={NEW_FIELD} disabled={!c.header}>➕ Create a new field{c.header ? ` “${c.header}”` : ''}</option>
                        <option value={SKIP}>Do not import this column</option>
                      </optgroup>
                    </select>
                  </td>
                  <td className="py-2.5 px-3.5 whitespace-nowrap">
                    {c.action === 'map' && (
                      <span className={`px-2 py-0.5 rounded-full font-medium ${c.via === 'your choice' ? 'bg-violet-50 text-violet-700' : c.via === 'similar name' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>
                        {HOW[c.via] || 'Matched'}
                      </span>
                    )}
                    {c.action === 'new' && (
                      <span className="px-2 py-0.5 rounded-full font-medium bg-sky-50 text-sky-700">New field · {c.new_field.field_type}</span>
                    )}
                    {c.action === 'skip' && <span className="text-slate-400 whitespace-normal">{c.reason}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

    </div>
  );
}

function ImportExportSection({ modules }) {
  const [selected, setSelected] = useState('');
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // When on, headers the module doesn't have yet become new fields instead
  // of rejecting the file. On by default because that is almost always what
  // someone importing an export from another CRM wants.
  const [autoCreate, setAutoCreate] = useState(true);
  // Duplicate check. What this module can be compared on (mobile, email,
  // company name) and the starting choice come from its duplicate rule.
  const [dupInfo, setDupInfo] = useState(null);
  const [dup, setDup] = useState({ mobile: true, email: true, name: false, action: 'skip' });

  useEffect(() => {
    setDupInfo(null);
    if (!selected) return undefined;
    let live = true;
    api.importDuplicateOptions(selected).then((info) => {
      if (!live) return;
      setDupInfo(info);
      setDup({
        mobile: info.mobile.length > 0 && info.default_by.mobile !== false,
        email: info.email.length > 0 && info.default_by.email !== false,
        name: !!info.name && !!info.default_by.name,
        action: info.default_action || 'skip',
      });
    }).catch(() => { if (live) setDupInfo({ available: false }); });
    return () => { live = false; };
  }, [selected]);

  // ---- which column goes to which field ---------------------------------
  // `analysis` is the server's answer for the file as it stands; `choices`
  // holds only what the person changed (by column number). The server puts
  // their choices first and matches the remaining columns by itself.
  const [analysis, setAnalysis] = useState(null);
  const [analysing, setAnalysing] = useState(false);
  const [choices, setChoices] = useState({});
  const analysisSeq = useRef(0);
  const headerLine = useMemo(() => csv.split(/\r?\n/, 1)[0] || '', [csv]);
  const hasRows = useMemo(() => csv.trim().split(/\r?\n/).length >= 2, [csv]);

  // Another file (or module) starts again from the automatic matching.
  useEffect(() => { setChoices((c) => (Object.keys(c).length ? {} : c)); }, [selected, headerLine]);

  useEffect(() => {
    const mine = ++analysisSeq.current;
    if (!selected || !hasRows) { setAnalysis(null); setAnalysing(false); return undefined; }
    setAnalysing(true);
    const timer = setTimeout(() => {
      api.importAnalyze(selected, csv, { createMissingFields: autoCreate, mapping: choices })
        .then((a) => { if (mine === analysisSeq.current) setAnalysis(a && Array.isArray(a.columns) && Array.isArray(a.fields) ? a : null); })
        .catch(() => { if (mine === analysisSeq.current) setAnalysis(null); })
        .finally(() => { if (mine === analysisSeq.current) setAnalysing(false); });
    }, 350);
    return () => clearTimeout(timer);
  }, [selected, csv, hasRows, autoCreate, choices]);

  const choose = (index, value) => { setChoices((c) => ({ ...c, [index]: value })); setResult(null); setError(null); };
  // Exactly what is on screen is what gets imported.
  const mapping = analysis
    ? Object.fromEntries(analysis.columns.map((c) => [String(c.index), c.action === 'map' ? c.field : c.action === 'new' ? NEW_FIELD : SKIP]))
    : undefined;
  const mappingBlocked = !!analysis && ((analysis.problems?.length || 0) > 0 || (analysis.missing_required?.length || 0) > 0);
  const moduleLabel = modules.find((m) => m.api_name === selected)?.singular_label || 'CRM';

  const changeDup = (patch) => { setDup((d) => ({ ...d, ...patch })); setResult(null); setError(null); };
  const dupChecked = dupInfo?.available && dup.action !== 'allow' && (dup.mobile || dup.email || dup.name);

  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setCsv(String(reader.result)); setResult(null); setError(null); };
    reader.readAsText(file);
    e.target.value = '';
  };

  const run = async (dryRun) => {
    if (!selected || !csv.trim()) return;
    setBusy(true); setResult(null); setError(null);
    try {
      const r = await api.importCsv(selected, csv, dryRun, autoCreate,
        dupChecked ? { mobile: dup.mobile, email: dup.email, name: dup.name, action: dup.action } : undefined,
        mapping);
      setResult(r);
    } catch (err) {
      // The backend returns structured validation detail (which lines failed,
      // which columns are valid) — show it rather than one opaque message.
      setError(err.data && typeof err.data === 'object' && err.data.error ? err.data : { error: err.message });
    } finally { setBusy(false); }
  };

  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-ink mb-1 flex items-center gap-1.5">
        <Database className="w-4 h-4 text-amber" /> Import &amp; Export
      </h2>
      <p className="text-xs text-slate-400 mb-4">Export any module to CSV, or bulk-import records. Imports are all-or-nothing — if any row fails validation, nothing is written.</p>

      <label className="text-xs text-slate-500 font-medium block mb-1">Module</label>
      <select value={selected} onChange={(e) => { setSelected(e.target.value); setResult(null); setError(null); }} className={inputClass + ' w-full mb-3'}>
        <option value="">Select a module…</option>
        {modules.map((m) => <option key={m.api_name} value={m.api_name}>{m.plural_label}</option>)}
      </select>

      {selected && (
        <>
          <div className="flex gap-2 flex-wrap mb-4">
            <a href={api.exportUrl(selected)} className="text-xs border border-line rounded-lg px-3 py-1.5 hover:bg-canvas inline-flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5" /> Export CSV
            </a>
            <a href={api.importTemplateUrl(selected)} className="text-xs border border-line rounded-lg px-3 py-1.5 hover:bg-canvas inline-flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" /> Blank template
            </a>
            <label className="text-xs border border-line rounded-lg px-3 py-1.5 hover:bg-canvas cursor-pointer inline-flex items-center gap-1.5">
              <Upload className="w-3.5 h-3.5" /> Choose CSV file
              <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
            </label>
          </div>

          <label className="text-xs text-slate-500 font-medium block mb-1">CSV content</label>
          <textarea value={csv} onChange={(e) => { setCsv(e.target.value); setResult(null); setError(null); }} rows={6}
            placeholder="Paste CSV here, or choose a file above. First row must be column headers."
            className="border border-line rounded-lg px-3 py-2 text-xs w-full font-mono" />

          <label className="flex items-start gap-2 mt-3 text-xs text-slate-600 cursor-pointer">
            <input type="checkbox" checked={autoCreate} onChange={(e) => { setAutoCreate(e.target.checked); setResult(null); setError(null); }}
              className="mt-0.5 w-3.5 h-3.5" />
            <span>
              <strong className="text-ink">Create missing fields automatically</strong> — a column that matches
              no field becomes a new field, with the type worked out from the data. A heading that is the label of
              an existing field (e.g. "Name", "Email Address") always goes to that field, never to a new one.
              Untick to leave unmatched columns out instead.
            </span>
          </label>

          {analysis && (
            <ColumnMatcher analysis={analysis} analysing={analysing} moduleLabel={moduleLabel}
              changed={Object.keys(choices).length > 0} onChoose={choose}
              onReset={() => { setChoices({}); setResult(null); setError(null); }} />
          )}
          {!analysis && analysing && <p className="text-xs text-slate-400 mt-3">Reading the columns of your file…</p>}

          {dupInfo?.available && (
            <div className="mt-4 rounded-xl border border-line p-3.5" data-import-duplicates>
              <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                <GitMerge className="w-3.5 h-3.5 text-amber" /> Duplicate check
              </div>
              <p className="text-xs text-slate-500 mt-1">
                A row is a duplicate when a record with the same value is already in the CRM, or when it is repeated in
                this file. Mobile numbers are compared on their last 10 digits, so +91, 0, spaces and dashes do not matter.
              </p>

              <div className="flex items-center gap-x-5 gap-y-1.5 flex-wrap mt-3 text-xs text-slate-600">
                <span className="font-medium text-ink">Check by</span>
                {dupInfo.mobile.length > 0 && (
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" className="w-3.5 h-3.5" checked={dup.mobile} disabled={dup.action === 'allow'}
                      onChange={(e) => changeDup({ mobile: e.target.checked })} /> Mobile
                  </label>
                )}
                {dupInfo.email.length > 0 && (
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" className="w-3.5 h-3.5" checked={dup.email} disabled={dup.action === 'allow'}
                      onChange={(e) => changeDup({ email: e.target.checked })} /> Email
                  </label>
                )}
                {dupInfo.name && (
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" className="w-3.5 h-3.5" checked={dup.name} disabled={dup.action === 'allow'}
                      onChange={(e) => changeDup({ name: e.target.checked })} /> Company name
                  </label>
                )}
              </div>

              <div className="mt-3 text-xs text-slate-600 space-y-1.5">
                <div className="font-medium text-ink">When a row is a duplicate</div>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="radio" name="dup-action" className="mt-0.5 w-3.5 h-3.5" checked={dup.action === 'skip'} onChange={() => changeDup({ action: 'skip' })} />
                  <span><strong className="text-ink">Do not import it</strong> — the row is left out; the record already there is not touched.</span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="radio" name="dup-action" className="mt-0.5 w-3.5 h-3.5" checked={dup.action === 'merge'} onChange={() => changeDup({ action: 'merge' })} />
                  <span>
                    <strong className="text-ink">Merge into the existing record</strong> — no new record; its empty fields are filled from the row
                    (nothing is overwritten){selected === 'leads' ? ', and the lead shows that it came in again today.' : '.'}
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="radio" name="dup-action" className="mt-0.5 w-3.5 h-3.5" checked={dup.action === 'allow'} onChange={() => changeDup({ action: 'allow' })} />
                  <span><strong className="text-ink">Import it anyway</strong> — no check; duplicates are created.</span>
                </label>
              </div>
              <p className="text-[11px] text-slate-400 mt-2.5">
                Tip: press <strong>Validate only</strong> first — it lists the duplicate rows without importing anything.
                {' '}<Link to="/duplicates?tab=rules" className="underline">Duplicate rules</Link>
              </p>
            </div>
          )}

          <div className="flex gap-2 mt-3">
            <button onClick={() => run(true)} disabled={busy || !csv.trim() || analysing || mappingBlocked}
              className="border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-canvas disabled:opacity-50">
              {busy ? 'Checking…' : 'Validate only'}
            </button>
            <button onClick={() => run(false)} disabled={busy || !csv.trim() || analysing || mappingBlocked}
              className="btn btn-primary disabled:opacity-50">
              {busy ? 'Importing…' : 'Import'}
            </button>
            {mappingBlocked && (
              <span className="text-xs text-warn self-center">Fix the column matching above to continue.</span>
            )}
          </div>

          {result && (
            <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mt-3 space-y-2">
              <div className="font-medium" data-import-result>
                {result.dry_run
                  ? `Looks good — ${result.would_import} row(s) would be imported.`
                  : `Imported ${result.imported} row(s).`}
              </div>

              {result.duplicates && (
                <div data-import-duplicate-result>
                  {result.duplicates.found === 0 ? (
                    <div>No duplicates found (checked by {[result.duplicates.checked.mobile && 'mobile', result.duplicates.checked.email && 'email', result.duplicates.checked.name && 'company name'].filter(Boolean).join(', ') || 'nothing — the file has no mobile or email column'}).</div>
                  ) : (
                    <>
                      <div className="font-medium text-amber">
                        {result.duplicates.found} duplicate row(s): {result.duplicates.already_in_crm} already in the CRM,
                        {' '}{result.duplicates.repeated_in_file} repeated in this file —
                        {' '}{result.duplicates.action === 'merge'
                          ? (result.dry_run ? 'would be merged into the existing records.' : 'merged into the existing records.')
                          : (result.dry_run ? 'would not be imported.' : 'not imported.')}
                      </div>
                      <div className="mt-1.5 max-h-56 overflow-auto rounded-lg border border-emerald-200 bg-white">
                        <table className="w-full text-[11px] text-slate-600">
                          <thead>
                            <tr className="text-left text-slate-400 border-b border-line">
                              <th className="py-1.5 px-2 font-medium">Row</th>
                              <th className="py-1.5 px-2 font-medium">Same</th>
                              <th className="py-1.5 px-2 font-medium">Value</th>
                              <th className="py-1.5 px-2 font-medium">Same as</th>
                            </tr>
                          </thead>
                          <tbody>
                            {result.duplicates.rows.map((d) => (
                              <tr key={d.row} className="border-b border-line/60">
                                <td className="py-1 px-2">{d.row}</td>
                                <td className="py-1 px-2">{d.matched_on.join(' + ')}</td>
                                <td className="py-1 px-2">{d.value}</td>
                                <td className="py-1 px-2">{d.same_as}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {result.duplicates.found > result.duplicates.rows.length && (
                        <div className="opacity-70 mt-1">…and {result.duplicates.found - result.duplicates.rows.length} more.</div>
                      )}
                    </>
                  )}
                </div>
              )}

              {result.value_notes?.length > 0 && (
                <div className="text-amber" data-import-notes>
                  <div className="font-medium">Some values could not be used as they are:</div>
                  <ul className="list-disc list-inside mt-0.5">
                    {result.value_notes.map((n) => (
                      <li key={`${n.field}-${n.kind}`}>{n.message}{n.examples?.length ? ` (e.g. ${n.examples.join(', ')})` : ''}</li>
                    ))}
                  </ul>
                </div>
              )}

              {(result.fields_created?.length > 0 || result.create?.length > 0) && (
                <div>
                  <div className="font-medium">
                    {result.dry_run ? 'Fields that would be created:' : 'New fields created:'}
                  </div>
                  <ul className="list-disc list-inside mt-0.5">
                    {(result.fields_created || result.create).map((f) => (
                      <li key={f.api_name || f.column}>
                        {f.label} <span className="opacity-70">({f.field_type})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(result.mapped_to_existing?.length > 0 || result.mapped?.length > 0) && (
                <div>
                  <div className="font-medium">Matched to fields you already have:</div>
                  <ul className="list-disc list-inside mt-0.5">
                    {(result.mapped_to_existing || result.mapped).map((m) => (
                      <li key={m.header}>{m.header} → {m.field || m.column}</li>
                    ))}
                  </ul>
                </div>
              )}

              {result.skipped?.length > 0 && (
                <div>
                  <div className="font-medium">Ignored:</div>
                  <ul className="list-disc list-inside mt-0.5">
                    {result.skipped.map((sk, i) => <li key={i}>{sk.header} — {sk.reason}</li>)}
                  </ul>
                </div>
              )}

              {result.display_name_filled_from && (
                <div className="opacity-80">
                  Record names were built from {result.display_name_filled_from.join(' + ')}.
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="text-xs text-warn bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-3">
              <div className="font-medium">{error.error}</div>
              {error.issues && (
                <ul className="list-disc list-inside mt-1.5 space-y-0.5">
                  {error.issues.map((i, idx) => <li key={idx}>{i}</li>)}
                </ul>
              )}
              {error.total_issues > (error.issues?.length || 0) && (
                <div className="mt-1">…and {error.total_issues - error.issues.length} more.</div>
              )}
              {error.allowed_columns && (
                <div className="mt-1.5">Valid columns: {error.allowed_columns.join(', ')}</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AuditSection({ modules }) {
  const [rows, setRows] = useState([]);
  const [moduleFilter, setModuleFilter] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.listAudit({ module: moduleFilter || undefined, limit: 200 })
      .then(setRows).catch(() => setRows()).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [moduleFilter]);

  // Dropdown option changes (Settings → Dropdown Options) are configuration,
  // not a record: they are logged against the field, with record 0.
  const OPTION_VERBS = {
    option_added: 'added an option to', option_renamed: 'renamed an option of', option_deactivated: 'deactivated an option of',
    option_activated: 'reactivated an option of', option_deleted: 'deleted an option of', options_reordered: 'reordered the options of',
  };
  const fieldName = (r) => (String(r.field_api_name || '').startsWith('list:')
    ? `the ${String(r.field_api_name).slice(5).replace(/_/g, ' ')} list`
    : `${r.singular_label} › ${String(r.field_api_name || '').replace(/_/g, ' ')}`);
  const describe = (r) => {
    if (OPTION_VERBS[r.action]) return `${OPTION_VERBS[r.action]} ${fieldName(r)}`;
    if (r.action === 'created') return `created ${r.singular_label} #${r.record_id}`;
    if (r.action === 'deleted') return `deleted ${r.singular_label} #${r.record_id}`;
    if (r.action === 'field_changed') {
      return `changed ${r.field_api_name} on ${r.singular_label} #${r.record_id}`;
    }
    return `${r.action} ${r.singular_label} #${r.record_id}`;
  };

  return (
    <div className="card p-5 mt-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
        <h2 className="text-sm font-semibold text-ink flex items-center gap-1.5">
          <History className="w-4 h-4 text-amber" /> Audit Log
        </h2>
        <select value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)} className={inputClass}>
          <option value="">All modules</option>
          {modules.map((m) => <option key={m.api_name} value={m.api_name}>{m.plural_label}</option>)}
        </select>
      </div>
      <p className="text-xs text-slate-400 mb-4">Who changed what, most recent first. Showing the latest 200 entries.</p>

      {loading && <p className="text-xs text-slate-400">Loading…</p>}
      {!loading && rows.length === 0 && <p className="text-xs text-slate-400">No activity recorded yet.</p>}

      {!loading && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400 border-b border-line">
                <th className="py-2 pr-3 font-medium">When</th>
                <th className="py-2 pr-3 font-medium">Who</th>
                <th className="py-2 pr-3 font-medium">What</th>
                <th className="py-2 font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line/60">
                  <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">{r.created_at}</td>
                  <td className="py-2 pr-3 text-slate-600">{r.full_name || r.username || '—'}</td>
                  <td className="py-2 pr-3 text-ink">{describe(r)}</td>
                  <td className="py-2 text-slate-500">
                    {r.action === 'field_changed' || r.action === 'option_renamed' || r.action === 'options_reordered'
                      ? <span><span className="line-through opacity-60">{r.old_value || '(empty)'}</span> → {r.new_value || '(empty)'}</span>
                      : OPTION_VERBS[r.action]
                        ? <span>{r.new_value || r.old_value || '—'}</span>
                        : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function SettingsData() {
  const can = usePermissions();
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.listModulesMeta()
      // Import/export and audit only make sense for modules backed by a real
      // table — custom JSON-backed modules store everything in one blob.
      .then((m) => setModules(m.filter((x) => x.table_name)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="py-8 t-meta">Loading…</div>;

  return (
    <div className="w-full">
      <PageHeader
        title="Data & Audit"
        subtitle="Bulk import/export, and a record of who changed what."
        icon={Database}
        accent="documents"
      />
{can('settings', 'edit') && <ImportExportSection modules={modules} />}
      {can('settings', 'view') && <AuditSection modules={modules} />}
    </div>
  );
}
