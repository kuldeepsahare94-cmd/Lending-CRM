import { useEffect, useRef, useState } from 'react';
import { Sparkles, X, Send, Check, XCircle, Plus } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';

// Renders the model's markdown-ish reply (bold **text** and simple pipe tables)
// without pulling in a full markdown library — keeps the bundle light.
function AssistantText({ text }) {
  const lines = text.split('\n');
  const html = lines.map((line, i) => {
    const bolded = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    if (line.trim().startsWith('|')) {
      return <div key={i} className="font-mono text-xs whitespace-pre" dangerouslySetInnerHTML={{ __html: bolded }} />;
    }
    return <p key={i} className="text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: bolded || '&nbsp;' }} />;
  });
  return <div className="space-y-0.5">{html}</div>;
}

function ConfirmCard({ pending, onDecide, deciding }) {
  return (
    <div className="border border-amber/40 bg-amber-soft rounded-lg p-3 text-sm">
      <p className="font-medium text-ink mb-1">Confirm this action?</p>
      <p className="text-xs text-slate-600 mb-1"><span className="font-medium">{pending.tool_name.replace(/_/g, ' ')}</span></p>
      <pre className="text-[11px] bg-white/70 rounded px-2 py-1.5 overflow-x-auto mb-2">{JSON.stringify(pending.input, null, 2)}</pre>
      <div className="flex gap-2">
        <button disabled={deciding} onClick={() => onDecide(true)}
          className="flex items-center gap-1 text-xs font-medium bg-good text-white px-3 py-1.5 rounded-lg disabled:opacity-50">
          <Check className="w-3.5 h-3.5" /> Confirm
        </button>
        <button disabled={deciding} onClick={() => onDecide(false)}
          className="flex items-center gap-1 text-xs font-medium border border-line px-3 py-1.5 rounded-lg disabled:opacity-50">
          <XCircle className="w-3.5 h-3.5" /> Cancel
        </button>
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  "Give today's summary",
  "Show today's leads",
  "Show pending follow-ups",
  "Show students with pending fees",
  "Which counsellor converted the most leads this month?",
];

export default function AssistantWidget() {
  const can = usePermissions();
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]); // {role, text} | {role:'pending', pending}
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, open]);

  // Other screens (the Dashboard's "Ask AI") open this same assistant rather
  // than a second one, optionally with a question to ask straight away.
  const sendRef = useRef(null);
  useEffect(() => {
    const onOpen = async (e) => {
      setOpen(true);
      const prompt = e.detail?.prompt;
      if (prompt && sendRef.current) sendRef.current(prompt);
      else if (!conversationId) {
        try { const convo = await api.createConversation(); setConversationId(convo.id); } catch { /* shown on first send */ }
      }
    };
    window.addEventListener('icrm:open-assistant', onOpen);
    return () => window.removeEventListener('icrm:open-assistant', onOpen);
  }, [conversationId]);

  if (!can('assistant', 'view')) return null;

  const startConversation = async () => {
    const convo = await api.createConversation();
    setConversationId(convo.id);
    setMessages([]);
    return convo.id;
  };

  const toggle = async () => {
    if (!open && !conversationId) await startConversation();
    setOpen((s) => !s);
  };

  const applyResult = (result) => {
    if (result.type === 'confirmation_required') {
      setMessages((m) => [...m, { role: 'pending', pending: result.pending }]);
    } else {
      setMessages((m) => [...m, { role: 'assistant', text: result.text }]);
    }
  };

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content || loading) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text: content }]);
    setLoading(true);
    try {
      let cid = conversationId;
      if (!cid) cid = await startConversation();
      const result = await api.sendAssistantMessage(cid, content);
      applyResult(result);
    } catch (err) {
      setMessages((m) => [...m, { role: 'assistant', text: `Error: ${err.message}` }]);
    } finally {
      setLoading(false);
    }
  };

  sendRef.current = send;

  const decide = async (approve) => {
    setDeciding(true);
    try {
      const result = await api.confirmAssistantAction(conversationId, approve);
      setMessages((m) => m.filter((x) => x.role !== 'pending'));
      applyResult(result);
    } catch (err) {
      setMessages((m) => [...m, { role: 'assistant', text: `Error: ${err.message}` }]);
    } finally {
      setDeciding(false);
    }
  };

  const newChat = async () => { await startConversation(); };

  return (
    <>
      <button onClick={toggle}
        className="fixed bottom-20 md:bottom-6 right-5 z-40 w-12 h-12 rounded-full bg-ink text-white shadow-lg flex items-center justify-center hover:bg-ink-light">
        {open ? <X className="w-5 h-5" /> : <Sparkles className="w-5 h-5" />}
      </button>

      {open && (
        <div className="fixed bottom-36 md:bottom-24 right-5 z-40 w-[92vw] max-w-sm h-[70vh] max-h-[560px] bg-white border border-line rounded-2xl shadow-2xl flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-line bg-ink text-white">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber" />
              <span className="text-sm font-semibold">CRM Assistant</span>
            </div>
            <button onClick={newChat} title="New chat" className="text-white/60 hover:text-white">
              <Plus className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div>
                <p className="text-sm text-slate-500 mb-3">Ask me anything about your leads, admissions, payments, or placements.</p>
                <div className="flex flex-col gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => send(s)} className="text-left text-xs bg-canvas hover:bg-line/40 rounded-lg px-3 py-2 text-slate-600">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => {
              if (m.role === 'pending') return <ConfirmCard key={i} pending={m.pending} onDecide={decide} deciding={deciding} />;
              return (
                <div key={i} className={`max-w-[88%] rounded-xl px-3 py-2 ${m.role === 'user' ? 'ml-auto bg-ink text-white' : 'bg-canvas text-ink'}`}>
                  {m.role === 'user' ? <p className="text-sm">{m.text}</p> : <AssistantText text={m.text} />}
                </div>
              );
            })}
            {loading && <div className="text-xs text-slate-400 px-1">Thinking…</div>}
            <div ref={bottomRef} />
          </div>

          <form onSubmit={(e) => { e.preventDefault(); send(); }} className="border-t border-line p-3 flex gap-2">
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about leads, payments, reports…"
              className="flex-1 border border-line rounded-lg px-3 py-2 text-sm" disabled={loading} />
            <button type="submit" disabled={loading} className="bg-amber text-white p-2 rounded-lg disabled:opacity-50">
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      )}
    </>
  );
}
