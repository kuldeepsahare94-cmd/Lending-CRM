// Generative AI Actions (master prompt section 27) — distinct from the chat
// assistant's tool-use loop in routes/assistant.js: these are single-shot,
// structured generations scoped to one record (or the dashboard), not a
// back-and-forth conversation. Reuses the same Anthropic client
// (services/aiClient.js) and degrades the same way the assistant does when
// ANTHROPIC_API_KEY isn't set — a clear message, not a crash.

const express = require('express');
const router = express.Router();
const rawDb = require('../db');
const { AsyncLocalStorage } = require('async_hooks');
const access = require('../services/recordAccess');
const { requirePermission } = require('../middleware/auth');
const { anthropic, MODEL } = require('../services/aiClient');

// Who sees which records (Settings → Roles → Can see) holds here too: for the
// length of a request `db` is the database as the person asking may read it,
// so a record of somebody else's is "not found" and totals count only theirs.
const viewer = new AsyncLocalStorage();
const db = new Proxy(rawDb, {
  get(target, prop) {
    const source = viewer.getStore() || target;
    const v = source[prop];
    return typeof v === 'function' ? v.bind(source) : v;
  },
});
router.use((req, res, next) => viewer.run(access.scopedDb(req.user), next));

function unavailable(res) {
  return res.status(503).json({ error: "AI actions aren't configured yet — ask your admin to set the ANTHROPIC_API_KEY environment variable on the backend." });
}

// Asks for JSON-only output and parses it, tolerating a model that wraps
// the JSON in a code fence despite being asked not to (cheap insurance,
// costs nothing when the model behaves).
async function generateJson(systemPrompt, userPrompt) {
  const response = await anthropic.messages.create({
    model: MODEL, max_tokens: 1024, system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const cleaned = text.replace(/```json\s*|```\s*/g, '').trim();
  return JSON.parse(cleaned);
}

async function generateText(systemPrompt, userPrompt) {
  const response = await anthropic.messages.create({
    model: MODEL, max_tokens: 600, system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function saveAsNote(relatedModule, relatedRecordId, title, body, userId) {
  db.prepare(`INSERT INTO notes (title, body, related_module, related_record_id, created_by) VALUES (?,?,?,?,?)`)
    .run(title, body, relatedModule, relatedRecordId, userId);
}

// ---------------------------------------------------------------------------
// Opportunities: deal summary + risk analysis + next best action, one call.
// ---------------------------------------------------------------------------
router.post('/opportunities/:id/analyze', requirePermission('opportunities', 'view'), async (req, res) => {
  if (!anthropic) return unavailable(res);
  const opp = db.prepare(`
    SELECT o.*, a.account_name, s.name AS stage_name FROM opportunities o
    LEFT JOIN accounts a ON a.id = o.account_id LEFT JOIN module_pipeline_stages s ON s.id = o.stage_id
    WHERE o.id=?
  `).get(req.params.id);
  if (!opp) return res.status(404).json({ error: 'Not found' });

  const activities = db.prepare(`
    SELECT 'call' type, call_subject title, created_at FROM calls WHERE related_module='opportunities' AND related_record_id=?
    UNION ALL SELECT 'meeting', meeting_title, created_at FROM meetings WHERE related_module='opportunities' AND related_record_id=?
    UNION ALL SELECT 'note', body, created_at FROM notes WHERE related_module='opportunities' AND related_record_id=?
    ORDER BY created_at DESC LIMIT 10
  `).all(req.params.id, req.params.id, req.params.id);

  const daysSinceUpdate = Math.floor((Date.now() - new Date(opp.updated_at).getTime()) / 86400000);
  const context = `Deal: ${opp.opportunity_name}\nAccount: ${opp.account_name || 'none'}\nStage: ${opp.stage_name || 'unknown'}\nAmount: ${opp.amount} ${opp.currency}\nProbability: ${opp.probability ?? 'not set'}%\nExpected close: ${opp.expected_close_date || 'not set'}\nDays since last update: ${daysSinceUpdate}\nRecent activity (most recent first): ${activities.map((a) => `${a.type}: ${a.title}`).join('; ') || 'none logged'}`;

  try {
    const result = await generateJson(
      'You are a sales analyst inside a CRM. Given a deal\'s data, respond with ONLY a JSON object: {"summary": "2-3 sentence plain-language summary", "risk_level": "low"|"medium"|"high", "risk_factors": ["short phrase", ...], "next_best_action": "one specific, concrete next step"}. No markdown, no commentary outside the JSON.',
      context
    );
    if (req.body.save_as_note) saveAsNote('opportunities', opp.id, 'AI deal analysis', `${result.summary}\n\nRisk: ${result.risk_level}\nNext step: ${result.next_best_action}`, req.user.id);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'AI analysis failed: ' + e.message });
  }
});

// ---------------------------------------------------------------------------
// Tickets: summary + suggested priority/category + a draft response.
// ---------------------------------------------------------------------------
router.post('/tickets/:id/analyze', requirePermission('tickets', 'view'), async (req, res) => {
  if (!anthropic) return unavailable(res);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const replies = db.prepare('SELECT is_internal, body FROM ticket_replies WHERE ticket_id=? ORDER BY created_at').all(req.params.id);

  const context = `Subject: ${ticket.subject}\nCurrent priority: ${ticket.priority}\nCurrent category: ${ticket.category || 'none'}\nDescription: ${ticket.description || 'none provided'}\nConversation so far:\n${replies.map((r) => `[${r.is_internal ? 'internal note' : 'customer-visible'}] ${r.body}`).join('\n') || '(no replies yet)'}`;

  try {
    const result = await generateJson(
      'You are a support triage assistant inside a CRM. Given a ticket\'s data, respond with ONLY a JSON object: {"summary": "1-2 sentence summary", "suggested_priority": "Low"|"Medium"|"High"|"Critical", "suggested_category": "short category label", "suggested_response": "a draft customer-facing reply, professional and concise"}. No markdown, no commentary outside the JSON.',
      context
    );
    if (req.body.save_as_note) saveAsNote('tickets', ticket.id, 'AI ticket analysis', `${result.summary}\n\nSuggested priority: ${result.suggested_priority}\nSuggested category: ${result.suggested_category}`, req.user.id);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'AI analysis failed: ' + e.message });
  }
});

// ---------------------------------------------------------------------------
// Calls & Meetings: summarize + extract action items (shared handler, since
// both are "notes about a conversation" with the same shape of output).
// ---------------------------------------------------------------------------
function summarizeConversationRoute(moduleApiName, table, notesColumn, titleColumn) {
  return async (req, res) => {
    if (!anthropic) return unavailable(res);
    const record = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id);
    if (!record) return res.status(404).json({ error: 'Not found' });
    const notesText = record[notesColumn] || record.notes || record.description || '(no notes recorded)';
    const context = `${titleColumn}: ${record[titleColumn]}\nNotes: ${notesText}`;

    try {
      const result = await generateJson(
        'You summarize a CRM call or meeting record. Respond with ONLY a JSON object: {"summary": "2-3 sentence summary", "action_items": ["short actionable phrase", ...]}. If there are no clear action items, return an empty array. No markdown, no commentary outside the JSON.',
        context
      );
      if (req.body.create_tasks && Array.isArray(result.action_items)) {
        const insertTask = db.prepare(`INSERT INTO tasks (task_title, related_module, related_record_id, created_by) VALUES (?,?,?,?)`);
        result.action_items.forEach((item) => insertTask.run(item, moduleApiName, record.id, req.user.id));
      }
      res.json(result);
    } catch (e) {
      res.status(502).json({ error: 'AI analysis failed: ' + e.message });
    }
  };
}
router.post('/calls/:id/summarize', requirePermission('calls', 'view'), summarizeConversationRoute('calls', 'calls', 'notes', 'call_subject'));
router.post('/meetings/:id/summarize', requirePermission('meetings', 'view'), summarizeConversationRoute('meetings', 'meetings', 'meeting_notes', 'meeting_title'));

// ---------------------------------------------------------------------------
// Dashboard: ask a free-form question about current CRM performance,
// grounded in the same numbers the CRM Overview dashboard shows (Phase 14).
// ---------------------------------------------------------------------------
router.post('/dashboard/ask', requirePermission('opportunities', 'view'), async (req, res) => {
  if (!anthropic) return unavailable(res);
  const question = (req.body.question || '').trim();
  if (!question) return res.status(400).json({ error: 'question is required' });

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';
  const cards = {
    open_opportunities: db.prepare(`SELECT COUNT(*) c FROM opportunities o LEFT JOIN module_pipeline_stages s ON s.id=o.stage_id WHERE COALESCE(s.is_won,0)=0 AND COALESCE(s.is_lost,0)=0`).get().c,
    pipeline_value: db.prepare(`SELECT COALESCE(SUM(o.amount),0) s FROM opportunities o LEFT JOIN module_pipeline_stages st ON st.id=o.stage_id WHERE COALESCE(st.is_won,0)=0 AND COALESCE(st.is_lost,0)=0`).get().s,
    won_this_month: db.prepare(`SELECT COALESCE(SUM(o.amount),0) s FROM opportunities o JOIN module_pipeline_stages st ON st.id=o.stage_id WHERE st.is_won=1 AND date(o.updated_at) >= date(?)`).get(monthStart).s,
    open_tickets: db.prepare(`SELECT COUNT(*) c FROM tickets WHERE status NOT IN ('Resolved','Closed')`).get().c,
    overdue_tasks: db.prepare(`SELECT COUNT(*) c FROM tasks WHERE status != 'Completed' AND due_date IS NOT NULL AND date(due_date) < date(?)`).get(today).c,
  };
  const by_stage = db.prepare(`
    SELECT s.name stage, COUNT(o.id) count, COALESCE(SUM(o.amount),0) total FROM module_pipeline_stages s
    JOIN module_pipelines p ON p.id=s.pipeline_id AND p.is_default=1 JOIN modules m ON m.id=p.module_id AND m.api_name='opportunities'
    LEFT JOIN opportunities o ON o.stage_id=s.id GROUP BY s.id ORDER BY s.sort_order
  `).all();

  const context = `Current CRM snapshot:\n${JSON.stringify({ cards, by_stage }, null, 2)}\n\nQuestion: ${question}`;
  try {
    const answer = await generateText(
      'You are a sales analyst answering a question about a CRM\'s current data snapshot, which is provided as JSON. Answer in 2-4 sentences of plain text, grounded only in the numbers given — do not invent figures not present in the snapshot. If the snapshot doesn\'t contain what\'s needed to answer, say so plainly.',
      context
    );
    res.json({ answer });
  } catch (e) {
    res.status(502).json({ error: 'AI analysis failed: ' + e.message });
  }
});

module.exports = router;
