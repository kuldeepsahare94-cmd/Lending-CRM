import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Inbox, Send, User, AlertCircle } from 'lucide-react';
import { api } from '../api';

function timeAgo(dateStr) {
  if (!dateStr) return '';
  return dateStr.slice(0, 16).replace('T', ' ');
}

export default function WhatsAppInbox() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState([]);
  const [active, setActive] = useState(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  const loadList = () => api.waListConversations().then(setConversations);
  useEffect(() => { loadList(); }, []);

  useEffect(() => {
    if (!id) { setActive(null); return; }
    api.waGetConversation(id).then((c) => {
      setActive(c);
      if (c.unread_count > 0) api.waMarkConversationRead(id).then(loadList);
    });
  }, [id]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [active]);

  const send = async (e) => {
    e.preventDefault();
    if (!reply.trim()) return;
    setSending(true);
    setError('');
    try {
      await api.waReplyConversation(id, reply);
      setReply('');
      const refreshed = await api.waGetConversation(id);
      setActive(refreshed);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-57px)]">
      <div className="w-72 shrink-0 border-r border-line bg-white overflow-y-auto">
        <div className="p-4 border-b border-line flex items-center gap-2">
          <Inbox className="w-4 h-4 text-good" />
          <h1 className="text-sm font-semibold text-ink">WhatsApp Inbox</h1>
        </div>
        {conversations.map((c) => (
          <button key={c.id} onClick={() => navigate(`/whatsapp/inbox/${c.id}`)}
            className={`w-full text-left px-4 py-3 border-b border-line/60 hover:bg-canvas ${String(c.id) === id ? 'bg-canvas' : ''}`}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-ink truncate">{c.entity_name || c.phone_number}</span>
              {c.unread_count > 0 && <span className="w-2 h-2 rounded-full bg-amber shrink-0" />}
            </div>
            <p className="text-xs text-slate-400 truncate mt-0.5">{c.last_message_preview}</p>
            <p className="text-[10px] text-slate-300 mt-0.5">{c.entity_type ? `${c.entity_type} match` : 'Unmatched number'} · {timeAgo(c.last_message_at)}</p>
          </button>
        ))}
        {conversations.length === 0 && <p className="text-sm text-slate-400 text-center p-6">No conversations yet.</p>}
      </div>

      <div className="flex-1 flex flex-col">
        {!active ? (
          <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">Select a conversation</div>
        ) : (
          <>
            <div className="p-4 border-b border-line bg-white flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-ink flex items-center gap-1.5">
                  <User className="w-4 h-4 text-slate-400" /> {active.entity_name || active.phone_number}
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  {active.phone_number} · via {active.provider_name}
                  {active.entity_type === 'lead' && <> · <Link to={`/leads/${active.entity_id}`} className="text-amber hover:underline">View lead</Link></>}
                  {active.entity_type === 'student' && <> · <Link to={`/students/${active.entity_id}`} className="text-amber hover:underline">View student</Link></>}
                  {!active.entity_type && <span className="text-warn"> · No CRM match found</span>}
                </p>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-canvas">
              {active.messages.map((m) => (
                <div key={m.id} className={`max-w-[70%] rounded-xl px-3 py-2 ${m.direction === 'outbound' ? 'ml-auto bg-ink text-white' : 'bg-white text-ink border border-line'}`}>
                  <p className="text-sm whitespace-pre-wrap">{m.body}</p>
                  <p className={`text-[10px] mt-1 ${m.direction === 'outbound' ? 'text-white/50' : 'text-slate-400'}`}>{timeAgo(m.created_at)} · {m.status}</p>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {error && <div className="bg-red-50 text-warn text-xs px-4 py-2 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}</div>}

            <form onSubmit={send} className="border-t border-line bg-white p-3 flex gap-2">
              <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Type a reply… (only works within the provider's open session window)"
                className="flex-1 border border-line rounded-lg px-3 py-2 text-sm" disabled={sending} />
              <button type="submit" disabled={sending} className="bg-amber text-white p-2 rounded-lg disabled:opacity-50">
                <Send className="w-4 h-4" />
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
