'use strict';
// Runs the sample-data scripts in a separate process so the CRM keeps answering while they work.
// One run at a time. The state lives in memory: it is only ever "is something running, and what did it say".
const { spawn } = require('child_process');
const path = require('path');
const db = require('../../db');
const { LoanError } = require('./engine');

const ROOT = path.join(__dirname, '..', '..');
const ACTIONS = {
  add_small: { label: 'Adding 13 sample loans', script: 'seed-loan-demo.js', args: [] },
  add_bulk: { label: 'Adding 1,000 sample loans', script: 'seed-loan-bulk.js', args: ['1000'] },
  remove: { label: 'Removing sample data', script: 'seed-loan-demo.js', args: ['--remove'] },
};
// The loader runs in another process, so this server did not see its writes. Counting a (harmless, no-row)
// write against each table the dashboard reads tells the dashboard cache that its figures are out of date.
const WATCHED = ['loans', 'loan_installments', 'loan_receipts', 'loan_collateral', 'loan_collection_actions', 'loan_ledger', 'leads', 'tickets', 'tasks', 'calls', 'contacts', 'accounts', 'users'];
function touchCaches() {
  for (const t of WATCHED) { try { db.prepare(`UPDATE ${t} SET id = id WHERE id = -1`).run(); } catch (e) { /* a table that is not there has nothing cached */ } }
}

const state = { running: false, action: null, started_at: null, log: [], last: null };

function status() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM loans').get().n;
  const sample = db.prepare("SELECT COUNT(*) AS n FROM loans WHERE external_reference = 'DEMO'").get().n;
  return { running: state.running, action: state.action, action_label: state.action ? ACTIONS[state.action].label : null, started_at: state.started_at,
    log: state.log.slice(-12), last: state.last, total_loans: total, sample_loans: sample };
}

function start(action) {
  const a = ACTIONS[action];
  if (!a) throw new LoanError('Unknown action: ' + action);
  if (state.running) throw new LoanError('Something is already running. Wait for it to finish.', 409);
  const sample = db.prepare("SELECT COUNT(*) AS n FROM loans WHERE external_reference = 'DEMO'").get().n;
  if (action !== 'remove' && sample > 0) throw new LoanError('Sample data is already here. Remove it before adding a different set.', 409);
  if (action === 'remove' && sample === 0) throw new LoanError('There is no sample data to remove.', 409);
  state.running = true; state.action = action; state.started_at = new Date().toISOString(); state.log = [];
  const child = spawn(process.execPath, [path.join(ROOT, a.script), ...a.args], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const take = (buf) => String(buf).split('\n').map((l) => l.trim()).filter((l) => l && !/^\[(phase|data|ext)/.test(l) && !/^Seeded default login/.test(l)).forEach((l) => state.log.push(l));
  child.stdout.on('data', take); child.stderr.on('data', take);
  child.on('close', (code) => {
    state.running = false;
    touchCaches();
    const lastLine = [...state.log].reverse().find((l) => /^(Added|Removed|Sample)/.test(l)) || state.log.at(-1) || '';
    state.last = { ok: code === 0, message: code === 0 ? lastLine : 'Did not finish: ' + (state.log.at(-1) || 'unknown error'), at: new Date().toISOString() };
  });
  child.on('error', (e) => { state.running = false; state.last = { ok: false, message: 'Could not start: ' + e.message, at: new Date().toISOString() }; });
  return status();
}

module.exports = { status, start, touchCaches };
