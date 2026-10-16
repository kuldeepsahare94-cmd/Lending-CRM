const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { tools, PermissionError } = require('../services/aiTools');
const { anthropic, MODEL } = require('../services/aiClient');

const SYSTEM_PROMPT = `You are the AI assistant embedded in EduPlace CRM, an admission & placement CRM.
You help staff query data and take actions using ONLY the tools provided — you have no other way
to read or write CRM data, and you must never claim to have done something without calling a tool.

Rules:
- Call at most ONE tool per turn, then wait for its result before deciding the next step.
- For write tools (creating/updating/deleting anything), the system will always pause and ask the
  human to confirm before it actually runs — you don't need to ask "are you sure" yourself, just
  call the tool with your best understanding of what they asked for.
- If a request needs an id you don't have yet (e.g. "mark Priya's fee as paid"), call the relevant
  search tool first to find it, then call the write tool in a follow-up turn.
- If a tool reports a permission error, tell the user plainly they don't have access — don't retry.
- Modules like "Schools", "Coaching Institutes", "Workshops", "Branches", "Tasks", and "Calls" are
  NOT implemented in this CRM. If asked about them, say so plainly and suggest the closest existing
  module (e.g. Placements/interviews for workshop-style events, lead activity notes for call logs).
- Present results as clean, professional summaries — short tables in markdown, key numbers bolded.
  Keep replies concise; this is a busy sales/ops team, not a chat for its own sake.
- All currency is in INR.`;

function toolSchemas() {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

function findTool(name) {
  return tools.find((t) => t.name === name);
}

function logAction(user, conversationId, toolName, module, isWrite, input, resultSummary, status) {
  db.prepare(`
    INSERT INTO ai_action_log (user_id, conversation_id, tool_name, module, is_write, input_json, result_summary, status)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(user.id, conversationId, toolName, module || null, isWrite ? 1 : 0, JSON.stringify(input || {}), (resultSummary || '').slice(0, 500), status);
}

function loadConversation(id, userId) {
  const row = db.prepare('SELECT * FROM ai_conversations WHERE id=? AND user_id=?').get(id, userId);
  if (!row) return null;
  return { ...row, history: JSON.parse(row.history_json || '[]'), pending: row.pending_json ? JSON.parse(row.pending_json) : null };
}

function saveConversation(id, history, pending) {
  db.prepare(`UPDATE ai_conversations SET history_json=?, pending_json=?, updated_at=datetime('now') WHERE id=?`)
    .run(JSON.stringify(history), pending ? JSON.stringify(pending) : null, id);
}

// Runs the model loop starting from `history`, executing read-only tools automatically,
// and stopping to ask for confirmation the moment a write tool is requested.
async function runLoop(user, conversationId, history) {
  if (!anthropic) {
    return { type: 'text', text: "The AI assistant isn't configured yet — ask your admin to set the ANTHROPIC_API_KEY environment variable on the backend." };
  }

  for (let iterations = 0; iterations < 6; iterations++) {
    const response = await anthropic.messages.create({
      model: MODEL, max_tokens: 1024, system: SYSTEM_PROMPT, tools: toolSchemas(), messages: history,
    });
    history.push({ role: 'assistant', content: response.content });

    const toolUse = response.content.find((b) => b.type === 'tool_use');
    if (!toolUse) {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      saveConversation(conversationId, history, null);
      return { type: 'text', text: text || "I don't have a response for that." };
    }

    const tool = findTool(toolUse.name);
    if (!tool) {
      history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'Unknown tool', is_error: true }] });
      continue;
    }

    if (tool.isWrite) {
      // Stop here — persist the pending call and hand it back to the frontend for confirmation.
      const pending = { tool_use_id: toolUse.id, tool_name: tool.name, module: tool.module, input: toolUse.input };
      saveConversation(conversationId, history, pending);
      return {
        type: 'confirmation_required',
        pending,
        summary: `Run "${tool.name}" with: ${JSON.stringify(toolUse.input)}`,
      };
    }

    // Read-only tool — execute immediately and keep looping.
    try {
      const result = await tool.handler(user, toolUse.input || {});
      logAction(user, conversationId, tool.name, tool.module, false, toolUse.input, JSON.stringify(result).slice(0, 300), 'success');
      history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result ?? null) }] });
    } catch (err) {
      const status = err instanceof PermissionError ? 'denied' : 'error';
      logAction(user, conversationId, tool.name, tool.module, false, toolUse.input, err.message, status);
      history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: `Error: ${err.message}`, is_error: true }] });
    }
  }

  saveConversation(conversationId, history, null);
  return { type: 'text', text: "I'm going in circles on that one — could you rephrase or narrow the request?" };
}

// ===== Conversations =====
router.get('/conversations', requirePermission('assistant', 'view'), (req, res) => {
  res.json(db.prepare('SELECT id, title, created_at, updated_at FROM ai_conversations WHERE user_id=? ORDER BY updated_at DESC').all(req.user.id));
});

router.post('/conversations', requirePermission('assistant', 'view'), (req, res) => {
  const info = db.prepare(`INSERT INTO ai_conversations (user_id, title) VALUES (?,?)`).run(req.user.id, req.body.title || 'New chat');
  res.status(201).json({ id: info.lastInsertRowid, title: req.body.title || 'New chat', history: [] });
});

router.get('/conversations/:id', requirePermission('assistant', 'view'), (req, res) => {
  const convo = loadConversation(req.params.id, req.user.id);
  if (!convo) return res.status(404).json({ error: 'Not found' });
  res.json(convo);
});

// ===== Chat turn =====
router.post('/conversations/:id/message', requirePermission('assistant', 'view'), async (req, res) => {
  const convo = loadConversation(req.params.id, req.user.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });
  if (convo.pending) return res.status(409).json({ error: 'There is a pending action awaiting confirmation. Confirm or cancel it first.' });

  const message = (req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message is required' });

  db.prepare(`INSERT INTO ai_messages (conversation_id, role, content) VALUES (?,?,?)`).run(convo.id, 'user', message);
  if (convo.history.length === 0) {
    db.prepare('UPDATE ai_conversations SET title=? WHERE id=?').run(message.slice(0, 60), convo.id);
  }

  const history = [...convo.history, { role: 'user', content: message }];
  try {
    const result = await runLoop(req.user, convo.id, history);
    if (result.type === 'text') {
      db.prepare(`INSERT INTO ai_messages (conversation_id, role, content) VALUES (?,?,?)`).run(convo.id, 'assistant', result.text);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'The assistant hit an error: ' + err.message });
  }
});

// ===== Confirm or cancel a pending write action =====
router.post('/conversations/:id/confirm', requirePermission('assistant', 'view'), async (req, res) => {
  const convo = loadConversation(req.params.id, req.user.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });
  if (!convo.pending) return res.status(400).json({ error: 'Nothing is pending confirmation.' });

  const { approve } = req.body;
  const tool = findTool(convo.pending.tool_name);
  const history = convo.history;

  if (!approve) {
    logAction(req.user, convo.id, tool.name, tool.module, true, convo.pending.input, 'cancelled by user', 'denied');
    history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: convo.pending.tool_use_id, content: 'The user declined to run this action.' }] });
    saveConversation(convo.id, history, null);
    try {
      const result = await runLoop(req.user, convo.id, history);
      if (result.type === 'text') db.prepare(`INSERT INTO ai_messages (conversation_id, role, content) VALUES (?,?,?)`).run(convo.id, 'assistant', result.text);
      return res.json(result);
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  try {
    const result = await tool.handler(req.user, convo.pending.input || {});
    logAction(req.user, convo.id, tool.name, tool.module, true, convo.pending.input, JSON.stringify(result).slice(0, 300), 'success');
    history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: convo.pending.tool_use_id, content: JSON.stringify(result ?? null) }] });
  } catch (err) {
    const status = err instanceof PermissionError ? 'denied' : 'error';
    logAction(req.user, convo.id, tool.name, tool.module, true, convo.pending.input, err.message, status);
    history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: convo.pending.tool_use_id, content: `Error: ${err.message}`, is_error: true }] });
  }

  saveConversation(convo.id, history, null);
  try {
    const result = await runLoop(req.user, convo.id, history);
    if (result.type === 'text') db.prepare(`INSERT INTO ai_messages (conversation_id, role, content) VALUES (?,?,?)`).run(convo.id, 'assistant', result.text);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'The assistant hit an error: ' + err.message });
  }
});

// ===== Audit log (Super Admin / Admin only, via 'users' permission — same bar as managing accounts) =====
router.get('/audit-log', requirePermission('users', 'view'), (req, res) => {
  const rows = db.prepare(`
    SELECT al.*, u.username FROM ai_action_log al JOIN users u ON u.id = al.user_id
    ORDER BY al.created_at DESC LIMIT 200
  `).all();
  res.json(rows);
});

module.exports = router;
