/*
 * Renders the REAL production build in Chromium and reports, per route:
 *   - any console error or uncaught exception
 *   - whether the page actually painted content (not a blank shell)
 *   - a screenshot, so the UI can be looked at rather than inferred
 *
 * Why not jsdom any more: routes are lazy-loaded now, so the entry bundle
 * alone renders only the Suspense fallback. jsdom also can't resolve the
 * dynamic-import chunks. A real browser over a real static server exercises
 * the shipped artifact exactly as a user gets it.
 *
 * The API is mocked at the network layer with deliberately *plausible but
 * obviously fake* data. This is a rendering harness, never a data source —
 * nothing it produces goes anywhere near the product.
 *
 *   node render-check.mjs [--shot-dir DIR] [--width 1440]
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SHOT_DIR = argOf('--shot-dir', null);
const WIDTH = Number(argOf('--width', 1440));

if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true });

// ---------------------------------------------------------------- server
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  let file = path.join(DIST, url);
  // SPA fallback — any unknown path is a client route.
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------- API mock
// usePermissions reads user.permissions[module][action], so without this
// every gated action button is hidden and the harness silently stops
// exercising them — which is where most of the header markup lives.
const ALL_ACTIONS = { view: 1, create: 1, edit: 1, delete: 1, export: 1 };
const PERMS = {};
for (const m of ['leads', 'accounts', 'contacts', 'opportunities', 'quotations', 'products',
  'subscriptions', 'tickets', 'calls', 'meetings', 'tasks', 'notes', 'emails', 'payments',
  'documents', 'teams', 'workflows', 'reports', 'users', 'settings', 'modules', 'fields',
  'whatsapp', 'email_campaigns', 'lead_sources']) PERMS[m] = { ...ALL_ACTIONS };

const USER = { id: 1, username: 'demo', full_name: 'Demo User', role_id: 1, is_admin: 1, permissions: PERMS };

const MODULES = [
  { id: 1, api_name: 'accounts', table_name: 'accounts', singular_label: 'Account', plural_label: 'Accounts', icon: 'building', has_pipeline: 0 },
  { id: 2, api_name: 'contacts', table_name: 'contacts', singular_label: 'Contact', plural_label: 'Contacts', icon: 'user', has_pipeline: 0 },
  { id: 3, api_name: 'opportunities', table_name: 'opportunities', singular_label: 'Deal', plural_label: 'Opportunities', icon: 'target', has_pipeline: 1 },
  { id: 4, api_name: 'quotations', table_name: 'quotations', singular_label: 'Quotation', plural_label: 'Quotations', icon: 'file', has_pipeline: 0 },
  { id: 5, api_name: 'tickets', table_name: 'tickets', singular_label: 'Ticket', plural_label: 'Tickets', icon: 'ticket', has_pipeline: 1 },
];

const FIELDS = [
  { id: 1, api_name: 'name', label: 'Name', field_type: 'text', required: 1, show_in_list: 1, show_in_detail: 1, show_in_edit: 1, display_order: 1 },
  { id: 2, api_name: 'email', label: 'Email', field_type: 'email', required: 0, show_in_list: 1, show_in_detail: 1, show_in_edit: 1, display_order: 2 },
  { id: 3, api_name: 'status', label: 'Status', field_type: 'status', required: 0, show_in_list: 1, show_in_detail: 1, show_in_edit: 1, display_order: 3, options: 'Open,Won,Lost' },
];

// Generic shapes keyed by what the path contains. Anything unmatched gets an
// empty array, which is the case every list page must survive anyway.
function mockFor(url) {
  const u = url.toLowerCase();
  const has = (s) => u.includes(s);

  if (has('/auth/me')) return USER;

  // These shapes are copied from the real backend handlers. When a mock
  // shape drifts from the server, the page crashes here for a reason that
  // does not exist in production — which is worse than no test at all, so
  // each one below cites where it comes from.

  // routes/callDisposition.js — res.json({ range, overview, follow_ups, ... })
  if (has('call') && has('report')) {
    return {
      range: { from: '2026-09-01', to: '2026-09-18', user_id: null, scoped: false },
      overview: {
        total_calls: 96, connected_calls: 61, unconnected_calls: 35, outbound: 80, inbound: 16,
        total_talk_time: '04:12:30', total_seconds: 15150, avg_call_duration: '00:02:38',
        avg_connected_duration: '00:04:08', avg_form_time: '00:00:45', connect_rate: 63.5,
      },
      follow_ups: { due_today: 4, overdue: 2, done_today: 3, compliance: 50 },
      dispositions: [], by_agent: [], by_day: [],
    };
  }

  // routes/whatsappAnalytics.js -> services/whatsapp/analyticsEngine.js
  if (has('campaign-options')) return [{ id: 1, name: 'September promo' }];
  if (has('whatsapp') && has('analytic')) {
    return {
      totals: { sent: 420, delivered: 401, read: 288, failed: 19, replied: 54, opted_out: 3 },
      avg_delivery_seconds: 6,
      by_provider: [], error_logs: [],
    };
  }

  // routes/inbox.js — res.json({ emails, counts })
  if (has('/inbox') || has('/emails')) {
    return { emails: [], counts: { all: 0, unread: 0, unlinked: 0 } };
  }

  // routes/pipelines.js — each pipeline carries its stages
  if (has('pipeline')) {
    return [{
      id: 1, name: 'Sales Pipeline', module_id: 3, is_default: 1,
      stages: [
        { id: 1, stage: 'New', color: '#3B82F6', probability: 10, display_order: 1 },
        { id: 2, stage: 'Won', color: '#10B981', probability: 100, display_order: 2 },
      ],
    }];
  }

  // routes/roles.js — each role carries its permission rows
  if (has('/roles')) {
    return [{
      id: 1, name: 'Administrator', is_system: 1,
      permissions: ['leads', 'accounts', 'contacts', 'opportunities', 'users', 'settings']
        .map((m) => ({ role_id: 1, module: m, can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_export: 1 })),
    }];
  }

  // routes/layouts.js — field placement per view
  if (has('layout')) {
    return { list: [], detail: [], edit: [] };
  }

  if (has('/notifications')) return [];
  if (has('/whatsapp/provider-types')) return [{ id: 'meta', name: 'Meta Cloud API' }];
  if (has('/whatsapp/providers')) return [];
  if (has('/whatsapp/campaigns')) return [];
  if (has('/whatsapp/workflows')) return [];
  if (has('/whatsapp/templates')) return [];
  if (has('/settings/master-options')) return [];
  if (has('/settings/receipt-templates')) return [];
  if (has('/auth/login')) return { token: 'test', user: USER };
  if (has('/fields')) return FIELDS;
  if (has('kanban')) {
    const stage = (id, name, color, probability) => ({
      stage: { id, stage: name, color, probability, sort_order: id, active: 1 },
      cards: [], total: 0, weighted: 0,
    });
    return {
      pipeline: { id: 1, name: 'Sales Pipeline', module_id: 3, is_default: 1 },
      stages: [stage(1, 'New', '#3B82F6', 10), stage(2, 'Qualified', '#8B5CF6', 40), stage(3, 'Won', '#10B981', 100)],
    };
  }
  // /api/modules -> list; /api/modules/<api_name> -> that one module.
  // Returning the list for both left module.api_name undefined, which sent
  // the page on to /api/modules/undefined/fields.
  if (has('/modules')) {
    const m = url.split('/modules/')[1];
    if (m && !m.startsWith('?') && !m.includes('/')) {
      const key = m.split('?')[0];
      return MODULES.find((x) => x.api_name === key || String(x.id) === key)
        || { ...MODULES[0], api_name: key, plural_label: key, singular_label: key };
    }
    return MODULES;
  }
  if (has('permission')) return [{ module: '*', can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_export: 1 }];
  if (has('/users')) return [USER];
  if (has('/teams')) return [];
  // routes/dashboard.js -> res.json({ cards, trends, agenda, performance,
  // attention, leads_by_source, opportunities_by_stage, revenue_by_month,
  // recent_activities })
  if (has('dashboard')) {
    const trend = (c, p) => ({ current: c, previous: p, delta: c - p, unit: 'count', label: 'this week' });
    return {
      cards: {
        total_leads: 128, open_opportunities: 34, pipeline_value: 1820000, weighted_pipeline: 610000,
        won_revenue_month: 482000, lost_this_month: 6, open_tickets: 9, overdue_tasks: 4,
        todays_calls: 12, todays_meetings: 3, followups_due_today: 5, followups_overdue: 2,
      },
      trends: { total_leads: trend(128, 111), open_opportunities: trend(34, 30), won_revenue_month: trend(482000, 401000) },
      agenda: { follow_ups: [], meetings: [], tasks_due: [] },
      performance: { won: 18, lost: 7, win_rate: 72, avg_deal_size: 96000 },
      attention: [
        { severity: 'high', text: '2 overdue lead follow-up(s)', link: '/leads' },
        { severity: 'medium', text: '4 overdue task(s)', link: '/records/tasks' },
      ],
      leads_by_source: [{ source: 'Website', c: 40 }, { source: 'Referral', c: 22 }, { source: 'Campaign', c: 15 }],
      opportunities_by_stage: [
        { stage: 'New', c: 12, total: 240000, color: '#3B82F6' },
        { stage: 'Qualified', c: 9, total: 310000, color: '#8B5CF6' },
        { stage: 'Won', c: 5, total: 150000, color: '#10B981' },
      ],
      revenue_by_month: [
        { month: 'Apr', revenue: 210000 }, { month: 'May', revenue: 265000 },
        { month: 'Jun', revenue: 240000 }, { month: 'Jul', revenue: 305000 },
        { month: 'Aug', revenue: 288000 }, { month: 'Sep', revenue: 482000 },
      ],
      recent_activities: [],
    };
  }

  return [];
}

// --------------------------------------------------------------- routes
const ROUTES = [
  '/', '/leads', '/records/accounts', '/records/contacts', '/records/opportunities',
  '/records/opportunities/kanban', '/records/quotations', '/records/tickets',
  '/payments', '/reports', '/call-reports', '/inbox', '/email-campaigns',
  '/users', '/roles', '/appearance', '/lead-sources',
  '/settings', '/settings/modules', '/settings/layout', '/settings/workflows',
  '/settings/pipelines', '/settings/teams', '/settings/data', '/settings/finance',
  '/settings/email',
  '/whatsapp', '/whatsapp/templates', '/whatsapp/workflows', '/whatsapp/campaigns',
  '/whatsapp/analytics',
];

// The container ships a pinned Chromium that may not match the playwright
// package's expected revision, so point at it explicitly rather than letting
// playwright try to download one (the sandbox has no route to do that).
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => fs.existsSync(p));

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  ...(CHROME ? { executablePath: CHROME } : {}),
});
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 1000 } });

// Seed auth so ProtectedRoute lets us in.
await ctx.addInitScript((u) => {
  try {
    // Must match the keys AuthContext reads, or every route just
    // redirects to /login and the whole run passes vacuously.
    localStorage.setItem('cd_token', 'test-token');
    localStorage.setItem('cd_user', JSON.stringify(u));
  } catch { /* storage unavailable */ }
}, USER);

await ctx.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith(BASE) && !url.includes('/api/')) return route.continue();
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(mockFor(url)),
  });
});

let failed = 0;
const results = [];

for (const r of ROUTES) {
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('UNCAUGHT: ' + e.message));

  try {
    await page.goto(BASE + r, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1600); // recharts animates on mount
  } catch (e) {
    errs.push('NAV: ' + e.message);
  }

  const info = await page.evaluate(() => {
    const root = document.getElementById('root');
    const txt = (root?.innerText || '').trim();
    return {
      chars: txt.length,
      heading: document.querySelector('h1')?.innerText?.trim() || '',
      // Horizontal overflow is the responsive bug that keeps recurring.
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  // Chunk-loading noise and the deliberately-mocked backend are not defects.
  const real = errs.filter((e) => !/favicon|ERR_ABORTED|Download the React DevTools/i.test(e));
  const blank = info.chars < 40;
  const bad = real.length > 0 || blank || info.overflow > 2;
  if (bad) failed++;

  results.push({ r, ...info, errs: real, blank, bad });
  const tag = bad ? 'FAIL' : ' ok ';
  console.log(`[${tag}] ${r.padEnd(32)} h1="${info.heading}" chars=${info.chars}${info.overflow > 2 ? ` OVERFLOW+${info.overflow}` : ''}`);
  real.slice(0, 3).forEach((e) => console.log(`         ! ${e.slice(0, 160)}`));
  if (blank) console.log('         ! rendered blank');

  if (SHOT_DIR) {
    const name = r === '/' ? 'root' : r.replace(/^\//, '').replace(/\//g, '_');
    await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
  }
  await page.close();
}

await browser.close();
server.close();

console.log(`\n${ROUTES.length - failed}/${ROUTES.length} routes clean at ${WIDTH}px`);
process.exit(failed ? 1 : 0);
