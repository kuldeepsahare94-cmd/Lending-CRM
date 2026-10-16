/*
 * Settings — organised around what iCRM actually has.
 *
 * Every card links to a working configuration screen. Two leftovers from the
 * base application were removed:
 *   - Receipt Templates (Institute A / Institute B, placeholder text): payment
 *     receipts now print the Company Profile letterhead, like quotations,
 *     proforma invoices and invoices. No separate receipt template exists.
 *   - Master Option Lists (Lead Source / Qualification / Payment Mode cards):
 *     replaced by Dropdown Options, which manages those same shared lists AND
 *     every field's dropdown, and shows which fields each list feeds.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays, Settings as SettingsIcon, Sparkles, Database, ShieldCheck, Boxes, Zap, GitBranch, Users2, History,
  Percent, Mail, LayoutList, Check, AlertTriangle, Building2, LayoutTemplate, ListChecks, Bell, Search, Palette,
  UserCog, KeyRound, LifeBuoy, MessageCircle, Radio, Wrench, GitMerge, PhoneCall, ReceiptText, MapPinned, ChevronRight
} from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';

function AiAuditLog() {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.assistantAuditLog().then(setRows).catch(() => setRows([])); }, []);
  if (rows === null) return null;
  return (
    <div className="card overflow-hidden overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left bg-[var(--color-canvas)] border-b border-line">
            <th className="py-2.5 px-4 font-medium">When</th>
            <th className="py-2.5 px-4 font-medium">User</th>
            <th className="py-2.5 px-4 font-medium">Tool</th>
            <th className="py-2.5 px-4 font-medium">Type</th>
            <th className="py-2.5 px-4 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-line/60">
              <td className="py-2 px-4 text-xs text-slate-400 whitespace-nowrap">{r.created_at}</td>
              <td className="py-2 px-4 text-slate-600">{r.username}</td>
              <td className="py-2 px-4 text-ink font-medium">{r.tool_name}</td>
              <td className="py-2 px-4 text-slate-500">{r.is_write ? 'Write' : 'Read'}</td>
              <td className="py-2 px-4">
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  r.status === 'success' ? 'bg-emerald-100 text-good' : r.status === 'denied' ? 'bg-red-50 text-warn' : 'bg-amber-soft text-amber'
                }`}>{r.status}</span>
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-slate-400">No AI assistant activity yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// The settings map. `show` decides visibility from the user's permissions —
// the screens themselves enforce the same permissions on the server.
function sections(can) {
  return [
    {
      title: 'General', icon: Building2, tint: '#D97706',
      items: [
        { to: '/settings/company', icon: Building2, tint: '#D97706', title: 'Company Profile', show: can('settings', 'edit'),
          desc: 'Letterhead, GSTIN, bank details and signature — printed on quotations, proforma invoices, invoices and payment receipts.' },
        { to: '/appearance', icon: Palette, tint: '#DB2777', title: 'Appearance', show: true,
          desc: 'Theme and colours for your CRM.' },
        { to: '/settings/notifications', icon: Bell, tint: '#F59E0B', title: 'Follow-up Reminders', show: true,
          desc: 'Your reminders: browser notifications, sound, timing and overdue reminders.',
          keywords: 'notification reminder browser sound follow up' },
        { to: '/settings/calendar', icon: CalendarDays, tint: '#0284C7', title: 'My Calendar', show: true,
          desc: 'Connect your own Google or Outlook calendar and choose what syncs each way.' },
      ],
    },
    {
      title: 'CRM Configuration', icon: Boxes, tint: '#7C3AED',
      items: [
        { to: '/settings/modules', icon: Boxes, tint: '#7C3AED', title: 'Modules & Fields', show: can('settings', 'edit'),
          desc: 'Create custom modules, add fields to any module, and manage each dropdown’s options.' },
        { to: '/settings/layout', icon: LayoutList, tint: '#4F46E5', title: 'Field & Layout Manager', show: can('settings', 'edit'),
          desc: 'Choose which fields appear in list, form and detail views, their order, and which are mandatory.' },
        { to: '/settings/options', icon: ListChecks, tint: '#0D9488', title: 'Dropdown Options', show: can('fields', 'view') || can('settings', 'view'),
          desc: 'Add, rename, reorder and deactivate the choices in every dropdown — Status, Stage, Source, Priority, custom fields and shared lists.',
          keywords: 'options master lists lead source qualification payment mode status priority' },
        { to: '/settings/pipelines', icon: GitBranch, tint: '#2563EB', title: 'Pipelines', show: can('settings', 'edit'),
          desc: 'The stages deals move through — names, colours and win probability.' },
        { to: '/duplicates', icon: GitMerge, tint: '#D97706', title: 'Duplicate Check & Merge',
          show: can('leads', 'view') || can('contacts', 'view') || can('accounts', 'view') || can('settings', 'view'),
          desc: 'Stop the same lead, contact or account being created twice (same mobile or email), and merge the duplicates already here.',
          keywords: 'duplicate merge dedupe same mobile email repeat enquiry' },
      ],
    },
    {
      title: 'Sales & Documents', icon: LayoutTemplate, tint: '#0284C7',
      items: [
        { to: '/settings/template-library', icon: LayoutTemplate, tint: 'var(--color-brand)', title: 'Template Library', show: can('document_templates', 'view'),
          desc: 'Ready-made quotation, proforma and invoice designs. Pick one, add your logo and colours.' },
        { to: '/settings/templates', icon: LayoutTemplate, tint: '#0284C7', title: 'Template Builder', show: can('document_templates', 'view'),
          desc: 'My Templates, and the block-by-block builder for a completely custom document design.' },
        { to: '/settings/finance', icon: Percent, tint: '#059669', title: 'Taxes & Currencies', show: can('settings', 'edit'),
          desc: 'Tax rates for quotes and products, and the currencies you trade in.' },
      ],
    },
    {
      title: 'Field Team & Expenses', icon: MapPinned, tint: '#0D9488',
      items: [
        { to: '/settings/field', icon: MapPinned, tint: '#0284C7', title: 'Field force', show: can('settings', 'view'),
          desc: 'The mobile app for the field team: punch in / out with location and selfie, live tracking, km per day, visits at customers, km as an expense.' },
        { to: '/settings/expenses', icon: ReceiptText, tint: '#0D9488', title: 'Expenses', show: can('settings', 'view'),
          desc: 'Field expenses with bill photos, km and daily allowance: categories and limits, who approves, who pays, advances. Also what the mobile app uses.' },
      ],
    },
    {
      title: 'Calls, Email & Messaging', icon: PhoneCall, tint: '#3B5BFF',
      items: [
        { to: '/settings/telephony', icon: PhoneCall, tint: '#3B5BFF', title: 'Telephony (MCube IVR)', show: can('settings', 'view'),
          desc: 'Click-to-call, automatic call logs with recordings, incoming-call pop-up, missed-call follow-ups, auto-dialer and live calls.' },
        { to: '/settings/email', icon: Mail, tint: '#7C3AED', title: 'Email', show: true,
          desc: 'The mailbox this CRM sends from — organisation-wide or your own address.' },
        { to: '/whatsapp', icon: MessageCircle, tint: '#16A34A', title: 'WhatsApp', show: can('whatsapp', 'view'),
          desc: 'WhatsApp Business providers, templates, workflows and campaigns.' },
        { to: '/lead-sources', icon: Radio, tint: '#C026D3', title: 'Lead Sources', show: can('lead_sources', 'view'),
          desc: 'Website forms and Facebook / Instagram lead ads that create leads automatically.' },
      ],
    },
    {
      title: 'Users & Security', icon: KeyRound, tint: '#475569',
      items: [
        { to: '/users', icon: UserCog, tint: '#475569', title: 'Users', show: can('users', 'view'),
          desc: 'Add people, set their role, deactivate leavers.' },
        { to: '/roles', icon: KeyRound, tint: '#475569', title: 'Roles & Permissions', show: can('users', 'view'),
          desc: 'What each role can view, create, edit, delete and export — module by module.' },
        { to: '/settings/teams', icon: Users2, tint: '#7C3AED', title: 'Teams', show: can('settings', 'edit'),
          desc: 'Group users into teams so records can be assigned to a team, not just a person.' },
        { to: '/settings/security', icon: ShieldCheck, tint: '#E11D48', title: 'Security', show: can('security', 'view'),
          desc: 'Restrict sign-in by IP address, date range or time of day.' },
      ],
    },
    {
      title: 'Automation & Support', icon: Zap, tint: '#7C3AED',
      items: [
        { to: '/settings/workflows', icon: Zap, tint: '#7C3AED', title: 'Workflows', show: can('settings', 'edit'),
          desc: 'Rules that run by themselves: tell the owner, remind about untouched leads, escalate to the manager, daily lists. Ready-made ones for every module.' },
        { to: '/support/settings', icon: LifeBuoy, tint: '#E11D48', title: 'Support Desk Settings', show: can('support', 'view'),
          desc: 'SLA policies, queues, categories, escalation rules and business hours for tickets.' },
      ],
    },
    {
      title: 'System', icon: History, tint: '#475569',
      items: [
        { to: '/settings/data', icon: History, tint: '#475569', title: 'Data & Audit Log', show: can('settings', 'view'),
          desc: 'Import and export any module as CSV, and see who changed what — including dropdown option changes.' },
      ],
    },
  ];
}

// one group: a panel with its settings as rows
function GroupPanel({ group }) {
  const GIcon = group.icon;
  return (
    <section className="card overflow-hidden break-inside-avoid mb-4" data-testid="settings-group">
      <header className="flex items-center gap-2.5 px-4 py-3" style={{ borderBottom: '1px solid var(--color-line)', background: `color-mix(in srgb, ${group.tint} 5%, transparent)` }}>
        <span className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: `color-mix(in srgb, ${group.tint} 14%, transparent)`, color: group.tint }}>
          <GIcon className="w-4 h-4" />
        </span>
        <h2 className="text-[12px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-ink)' }}>{group.title}</h2>
        <span className="ml-auto text-[11px] font-medium" style={{ color: 'var(--color-faint)' }}>{group.items.length}</span>
      </header>
      <div>
        {group.items.map((i) => <LinkRow key={i.to} item={i} />)}
      </div>
    </section>
  );
}

function LinkRow({ item }) {
  const Icon = item.icon;
  return (
    <Link to={item.to} data-testid="settings-link"
      className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-canvas)]"
      style={{ borderTop: '1px solid var(--color-line-soft, var(--color-line))' }}>
      <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: `color-mix(in srgb, ${item.tint} 12%, transparent)`, color: item.tint }}>
        <Icon className="w-[18px] h-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink group-hover:text-[var(--color-brand)]">{item.title}</span>
        <span className="block text-xs text-slate-500 mt-0.5 leading-relaxed">{item.desc}</span>
      </span>
      <ChevronRight className="w-4 h-4 shrink-0 mt-2.5 opacity-40 group-hover:opacity-100 transition-opacity" style={{ color: 'var(--color-brand)' }} />
    </Link>
  );
}

export default function Settings() {
  const can = usePermissions();
  const [q, setQ] = useState('');
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState(null);

  // What is loaded right now, so the panel can say so instead of leaving the
  // admin to press the button and find out.
  const [demoStatus, setDemoStatus] = useState(null);
  const loadDemoStatus = () => api.demoDataStatus().then(setDemoStatus).catch(() => {});

  const seedDemoData = async () => {
    const already = demoStatus?.loaded;
    const warning = already
      ? 'Demo data is already loaded. This will clear it and build a fresh set.\n\nRecords you entered yourself are not touched. Continue?'
      : 'This fills every module with about a year of sample data — customers, deals, quotations, proforma invoices, invoices, payments, tickets and activity history.\n\nYou can remove all of it again with one click. Continue?';
    if (!confirm(warning)) return;
    setSeeding(true);
    setSeedResult(null);
    try {
      const res = await api.seedDemoData();
      setSeedResult(res);
      loadDemoStatus();
    } catch (err) {
      alert('Could not load demo data: ' + err.message);
    } finally {
      setSeeding(false);
    }
  };

  const [repairing, setRepairing] = useState(false);
  const [repairResult, setRepairResult] = useState(null);
  const repairPermissions = async () => {
    setRepairing(true);
    setRepairResult(null);
    try {
      const res = await api.repairPermissions();
      setRepairResult(res);
    } catch (err) {
      alert('Could not repair permissions: ' + err.message);
    } finally {
      setRepairing(false);
    }
  };

  const [wiping, setWiping] = useState(false);
  const wipeDemoData = async () => {
    if (!confirm('Remove every demo record?\n\nAnything you entered yourself stays exactly as it is.')) return;
    setWiping(true);
    setSeedResult(null);
    try {
      const res = await api.wipeDemoData();
      setSeedResult(res);
      loadDemoStatus();
    } catch (err) {
      alert('Could not remove demo data: ' + err.message);
    } finally {
      setWiping(false);
    }
  };

  // "42 accounts, 130 leads, 66 invoices…" — ordered the way someone walking
  // through the sidebar would meet them, not alphabetically.
  const DEMO_ORDER = ['leads', 'accounts', 'contacts', 'opportunities', 'quotations',
    'proforma_invoices', 'invoices', 'payments', 'products', 'subscriptions', 'tickets',
    'calls', 'meetings', 'tasks', 'notes', 'emails', 'documents'];
  const demoLabel = (k) => k.replace(/_/g, ' ');

  const [downloading, setDownloading] = useState(false);
  const [emailingBackup, setEmailingBackup] = useState(false);
  const [backupResult, setBackupResult] = useState(null);
  const [storage, setStorage] = useState(null);
  const [restoring, setRestoring] = useState(false);

  // Tells the admin whether data actually survives a redeploy, rather than
  // leaving them to find out the hard way after one.
  useEffect(() => { if (can('settings', 'edit')) api.backupStatus().then(setStorage).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const restoreBackup = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';                 // let the same file be picked again
    if (!file) return;
    if (!window.confirm(
      `Restore from "${file.name}"?\n\n`
      + 'This replaces ALL current data with the data in this backup, right away. '
      + 'Download a backup of the current data first if you might need it.',
    )) return;

    setRestoring(true);
    setBackupResult(null);
    try {
      const res = await api.restoreBackup(file);
      setBackupResult({ ok: true, message: res.message });
      api.backupStatus().then(setStorage).catch(() => {});
    } catch (err) {
      setBackupResult({ ok: false, message: err.message });
    } finally {
      setRestoring(false);
    }
  };

  const downloadBackup = async () => {
    setDownloading(true);
    try {
      await api.downloadBackup();
    } catch (err) {
      alert('Could not download backup: ' + err.message);
    } finally {
      setDownloading(false);
    }
  };

  const emailBackup = async () => {
    setEmailingBackup(true);
    setBackupResult(null);
    try {
      const res = await api.emailBackupNow();
      setBackupResult({ ok: true, message: `Sent to ${res.sent_to} (${res.size_mb} MB)` });
    } catch (err) {
      setBackupResult({ ok: false, message: err.message });
    } finally {
      setEmailingBackup(false);
    }
  };

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    return sections(can)
      .map((g) => ({
        ...g,
        items: g.items.filter((i) => i.show && (!term || `${g.title} ${i.title} ${i.desc} ${i.keywords || ''}`.toLowerCase().includes(term))),
      }))
      .filter((g) => g.items.length);
  }, [can, q]);

  const term = q.trim().toLowerCase();
  const matches = (text) => !term || text.toLowerCase().includes(term);
  const showRepair = can('settings', 'edit') && matches('repair administrator access permissions company profile document templates fix system');
  const showDemo = false;   // demo data is not offered on this customer's CRM
  const showBackup = can('settings', 'edit') && matches('database backup restore download email system');
  const showAiLog = can('users', 'view') && matches('ai assistant activity log audit system');
  const anySystemPanel = showRepair || showDemo || showBackup || showAiLog;

  return (
    <div className="w-full">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-soft text-amber flex items-center justify-center">
            <SettingsIcon className="w-5 h-5" />
          </div>
          <div>
            <h1 className="t-page-title">Settings</h1>
            <p className="text-sm text-slate-500 mt-1">Configure your CRM — company, fields and dropdowns, documents, notifications, users and more.</p>
          </div>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-faint)]" />
          <input className="input w-full pl-9" style={{ paddingLeft: 36 }} placeholder="Search settings…" value={q} onChange={(e) => setQ(e.target.value)}
            aria-label="Search settings" />
        </div>
      </div>

      {groups.length > 0 && (
        <div className="mt-6 columns-1 md:columns-2 xl:columns-3 2xl:columns-4 gap-4" data-testid="settings-groups">
          {groups.map((g) => <GroupPanel key={g.title} group={g} />)}
        </div>
      )}

      {anySystemPanel && (
        <section className="mt-4">
          <h2 className="text-[12px] font-bold uppercase tracking-wider text-slate-500 mb-3">System tools</h2>
          <div className="grid xl:grid-cols-2 gap-4 items-start">
            {showBackup && (
              <div className="card p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-50 text-good flex items-center justify-center shrink-0">
                    <Database className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-ink">Database Backup &amp; Restore</h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Download or email yourself a copy before any risky change, and restore from one if something goes wrong.
                    </p>
                  </div>
                </div>

                {/* Storage health. On a host without a persistent disk,
                    uploaded files are lost on every redeploy. */}
                {storage && (
                  <div className={`text-xs rounded-lg px-3 py-2.5 mb-3 flex items-start gap-2 ${
                    storage.persistent ? 'bg-emerald-50 text-good' : 'bg-amber-50 text-warn'
                  }`}>
                    {storage.persistent
                      ? <Check className="w-4 h-4 shrink-0 mt-px" />
                      : <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />}
                    <span>
                      {storage.persistent ? (
                        <>
                          <strong>Data is safe across restarts.</strong> Records are in the PostgreSQL
                          database ({storage.size_mb} MB); uploaded files are stored outside the application
                          folder ({storage.data_dir}).
                        </>
                      ) : (
                        <>
                          <strong>Records are safe; uploaded files are not.</strong> Records are in the
                          PostgreSQL database ({storage.size_mb} MB) and survive restarts, but uploaded files
                          are inside the application folder, so a redeploy removes them. Set the{' '}
                          <code>DATA_DIR</code> environment variable to a mounted disk on your host.
                        </>
                      )}
                    </span>
                  </div>
                )}

                {storage?.restore_pending && (
                  <p className="text-xs bg-blue-50 text-blue-700 rounded-lg px-3 py-2.5 mb-3">
                    A restore is staged and will be applied the next time the backend restarts.
                  </p>
                )}

                {backupResult && (
                  <p className={`text-xs mb-3 ${backupResult.ok ? 'text-good' : 'text-warn'}`}>{backupResult.message}</p>
                )}
                <div className="flex gap-2 flex-wrap">
                  <button onClick={downloadBackup} disabled={downloading}
                    className="border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-canvas disabled:opacity-60">
                    {downloading ? 'Downloading…' : 'Download Backup Now'}
                  </button>
                  <button onClick={emailBackup} disabled={emailingBackup}
                    className="border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-canvas disabled:opacity-60">
                    {emailingBackup ? 'Sending…' : 'Email Backup to Myself'}
                  </button>
                  <label className={`border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-canvas cursor-pointer ${restoring ? 'opacity-60 pointer-events-none' : ''}`}>
                    {restoring ? 'Checking…' : 'Restore from Backup…'}
                    <input type="file" accept=".json,.gz" className="hidden" onChange={restoreBackup} disabled={restoring} />
                  </label>
                </div>
              </div>
            )}

            {showDemo && (
              <div className="card p-5 flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center shrink-0">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-ink">Demo Data</h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Fills every module with about a year of realistic sample data — customers, deals,
                      quotations, proforma invoices, invoices with part payments, tickets and activity
                      history — so reports and dashboards have something real to show.
                      {' '}Records you entered yourself are never touched.
                    </p>

                    {demoStatus?.loaded && !seedResult && (
                      <p className="text-xs text-slate-500 mt-2">
                        <span className="font-medium text-ink">Currently loaded:</span>{' '}
                        {DEMO_ORDER.filter((k) => demoStatus.counts[k])
                          .map((k) => `${demoStatus.counts[k]} ${demoLabel(k)}`)
                          .join(' · ')}
                      </p>
                    )}

                    {seedResult && (
                      <p className="text-xs text-good mt-2">
                        {seedResult.message}
                        {seedResult.counts && Object.keys(seedResult.counts).length > 0 && (
                          <span className="block text-slate-500 mt-1">
                            {DEMO_ORDER.filter((k) => seedResult.counts[k])
                              .map((k) => `${seedResult.counts[k]} ${demoLabel(k)}`)
                              .join(' · ')}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <button onClick={seedDemoData} disabled={seeding || wiping}
                    className="bg-ink text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-ink-light disabled:opacity-60">
                    {seeding ? 'Loading…' : demoStatus?.loaded ? 'Reload Demo Data' : 'Load Demo Data'}
                  </button>
                  {demoStatus?.loaded && (
                    <button onClick={wipeDemoData} disabled={seeding || wiping}
                      className="text-sm font-medium px-4 py-2 rounded-lg border border-line text-slate-600 hover:text-warn disabled:opacity-60">
                      {wiping ? 'Removing…' : 'Remove Demo Data'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {showRepair && (
              <div className="card p-5 flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
                    <Wrench className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-ink">Repair administrator access</h3>
                    <p className="text-xs text-slate-500 mt-0.5 max-w-2xl">
                      If Company Profile or document templates are missing for an administrator, their
                      permission was never granted on this install. This switches full access on for the
                      Super Admin and Admin roles. Safe to run any time.
                    </p>
                    {repairResult && <p className="text-xs text-good mt-2">{repairResult.message}</p>}
                  </div>
                </div>
                <button onClick={repairPermissions} disabled={repairing}
                  className="text-sm font-medium px-4 py-2 rounded-lg border border-line bg-white hover:bg-[var(--color-canvas)] disabled:opacity-60 shrink-0">
                  {repairing ? 'Checking…' : 'Repair access'}
                </button>
              </div>
            )}

            {showAiLog && (
              <div className="xl:col-span-2">
                <h3 className="text-sm font-semibold text-ink mt-2 mb-1 flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-amber" /> AI Assistant Activity Log
                </h3>
                <p className="text-xs text-slate-400 mb-3">Every query and action the AI assistant has run, per user, for audit purposes.</p>
                <AiAuditLog />
              </div>
            )}
          </div>
        </section>
      )}

      {!groups.length && !anySystemPanel && (
        <div className="card p-8 text-center t-meta mt-7">No settings match “{q}”.</div>
      )}
    </div>
  );
}
