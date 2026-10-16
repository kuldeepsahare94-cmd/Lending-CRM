/*
 * Internal team chat.
 *
 * A header icon opens a slide-over panel: everyone in the CRM down the left,
 * the conversation on the right.
 *
 * WHY POLLING, NOT WEBSOCKETS
 * The backend is a single Express process deployed behind managed proxies
 * (Render today, nginx on the VPS next). Long-lived connections are the first
 * thing those buffer or drop, and a socket server also needs sticky sessions
 * the moment there is more than one instance. A 5-second poll costs one cheap
 * query, works through anything, and for internal team chat in a small
 * company the latency is not noticeable. It backs off to 20s when the tab is
 * hidden so an idle tab is nearly free. Swapping in SSE or a socket later
 * only changes this file and the /poll route.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  MessageSquare, X, Search, Paperclip, Send, Users, Megaphone, ArrowLeft,
  Check, CheckCheck, Trash2, Bell, BellOff, FileText, Plus, Reply, Minus, Maximize2,
  Volume2, VolumeX, Play,
} from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { avatarGradientFor, initialsOf } from '../theme/avatarColors';
import { TONES, getTone, setTone, playTone } from './chatSounds';

// How often new messages are checked. The server answers one request at a
// time, so every check briefly delays whatever you clicked; they are spaced
// out when the chat panel is closed (the badge can wait a few seconds) and
// kept quick while you are in a conversation.
const POLL_OPEN_MS = 4000;
const POLL_CLOSED_MS = 12000;
const POLL_HIDDEN_MS = 30000;
// How long a popup stays. Seven seconds was long enough to miss entirely if
// you happened to be looking at another part of the screen.
const TOAST_MS = 12000;

function timeOf(ts) {
  if (!ts) return '';
  // SQLite datetime('now') is UTC without a zone marker; without the Z the
  // browser reads it as local time and every message looks hours old.
  const d = new Date(/Z|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : `${ts.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function bytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function Avatar({ name, online, size = 38 }) {
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div className="rounded-full flex items-center justify-center text-white font-semibold"
        style={{ width: size, height: size, background: avatarGradientFor(name), fontSize: size * 0.36 }}>
        {initialsOf(name)}
      </div>
      {online !== undefined && (
        <span
          title={online ? 'Online' : 'Offline'}
          className="absolute bottom-0 right-0 rounded-full border-2 border-white"
          style={{ width: size * 0.3, height: size * 0.3, background: online ? 'var(--color-success)' : '#94A3B8' }}
        />
      )}
    </div>
  );
}

function Attachment({ att }) {
  const isImage = String(att.mime_type || '').startsWith('image/') && att.mime_type !== 'image/svg+xml';
  const [src, setSrc] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Images have to be fetched with the auth header and shown from a blob URL
  // — a plain <img src> sends no Authorization header, so it would just 401.
  useEffect(() => {
    if (!isImage) return undefined;
    let revoked = false;
    let objectUrl = null;
    api.chatAttachmentBlob(att.id)
      .then((r) => { if (!revoked) { objectUrl = r.url; setSrc(r.url); } })
      .catch((e) => !revoked && setError(e.message));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);   // don't leak blobs
    };
  }, [att.id, isImage]);

  // Documents open on click, for the same reason: fetch with the header, then
  // hand the browser a blob.
  const open = async () => {
    setBusy(true); setError('');
    try {
      const { url, filename } = await api.chatAttachmentBlob(att.id);
      const a = document.createElement('a');
      a.href = url;
      // PDFs and images are worth previewing; anything else downloads.
      if (/pdf$/i.test(att.mime_type || '')) a.target = '_blank';
      else a.download = filename || att.file_name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (isImage) {
    return (
      <div className="mt-1.5">
        {src
          ? <button type="button" onClick={open} className="block">
              <img src={src} alt={att.file_name} className="rounded-lg max-h-56 border border-line" />
            </button>
          : <div className="rounded-lg border border-line bg-white/60 px-3 py-6 text-xs text-[var(--color-muted)] text-center">
              {error || 'Loading image…'}
            </div>}
      </div>
    );
  }

  return (
    <>
      <button type="button" onClick={open} disabled={busy}
        className="w-full flex items-center gap-2 mt-1.5 bg-white/70 border border-line rounded-lg px-2.5 py-2 hover:bg-white text-left disabled:opacity-60">
        <FileText className="w-4 h-4 shrink-0 text-[var(--color-muted)]" />
        <span className="min-w-0">
          <span className="block text-xs font-medium text-ink truncate">{att.file_name}</span>
          <span className="block text-[11px] text-[var(--color-muted)]">
            {busy ? 'Opening…' : bytes(att.size_bytes)}
          </span>
        </span>
      </button>
      {error && <p className="text-[11px] text-warn mt-1">{error}</p>}
    </>
  );
}

function MessageBubble({ m, isGroup, onDelete, onReply, onJumpTo }) {
  const mine = m.mine;
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'} group`}>
      <div className={`max-w-[78%] rounded-2xl px-3 py-2 ${
        mine ? 'bg-[var(--color-brand)] text-white' : 'bg-[var(--color-canvas)] text-ink border border-line'
      }`}>
        {isGroup && !mine && (
          <div className="text-[11px] font-semibold mb-0.5" style={{ color: 'var(--color-brand)' }}>{m.sender_name}</div>
        )}

        {/* The message being replied to, quoted above this one. Clicking it
            scrolls back to the original. */}
        {m.reply_to && !m.deleted && (
          <button type="button" onClick={() => onJumpTo(m.reply_to.id)}
            className={`block w-full text-left rounded-lg px-2 py-1 mb-1 border-l-2 ${
              mine ? 'bg-white/15 border-white/50' : 'bg-white/70 border-[var(--color-brand)]'
            }`}>
            <span className={`block text-[10px] font-semibold ${mine ? 'text-white/90' : 'text-[var(--color-brand)]'}`}>
              {m.reply_to.mine ? 'You' : m.reply_to.sender_name}
            </span>
            <span className={`block text-[11px] truncate ${mine ? 'text-white/75' : 'text-[var(--color-muted)]'}`}>
              {m.reply_to.body}
            </span>
          </button>
        )}

        {m.deleted ? (
          <p className="text-sm italic opacity-70">Message deleted</p>
        ) : (
          <>
            {m.body && <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>}
            {m.attachments.map((a) => <Attachment key={a.id} att={a} />)}
            {m.ref && (
              <a href={`/records/${m.ref.module}/${m.ref.record_id}`}
                className={`block mt-1.5 text-xs underline ${mine ? 'text-white/90' : 'text-[var(--color-brand)]'}`}>
                {m.ref.label || `${m.ref.module} #${m.ref.record_id}`}
              </a>
            )}
          </>
        )}

        <div className={`flex items-center gap-1 justify-end mt-0.5 text-[10px] ${mine ? 'text-white/70' : 'text-[var(--color-muted)]'}`}>
          {m.edited_at && <span>edited</span>}
          <span>{timeOf(m.created_at)}</span>
          {/* One tick sent, two ticks seen — the plain "seen / not seen".
              In a group the tooltip names who has actually read it. */}
          {mine && !m.deleted && (
            m.seen_by_all
              ? <CheckCheck className="w-3.5 h-3.5" aria-label="Seen" />
              : <Check className="w-3.5 h-3.5" aria-label="Sent, not seen yet" />
          )}
          {mine && !m.deleted && isGroup && m.seen_by.length > 0 && (
            <span title={`Seen by ${m.seen_by.map((s) => s.name).join(', ')}`}>{m.seen_by.length}</span>
          )}
          {!m.deleted && (
            <button onClick={() => onReply(m)} title="Reply to this message"
              className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5">
              <Reply className="w-3 h-3" />
            </button>
          )}
          {mine && !m.deleted && (
            <button onClick={() => onDelete(m)} title="Delete message"
              className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5">
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- new group
function NewGroupModal({ users, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError('Give the group a name.');
    setBusy(true); setError('');
    try { onCreated(await api.chatCreateGroup(name.trim(), picked)); } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <div className="absolute inset-0 z-10 bg-white flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
        <button onClick={onClose}><ArrowLeft className="w-4 h-4 text-[var(--color-muted)]" /></button>
        <h3 className="text-sm font-semibold text-ink">New group</h3>
      </div>
      <form onSubmit={submit} className="flex-1 flex flex-col min-h-0">
        <div className="p-4 border-b border-line">
          <input autoFocus value={name} onChange={(e) => { setName(e.target.value); setError(''); }}
            placeholder="Group name — e.g. Sales Team"
            className="border border-line rounded-lg px-3 py-2 text-sm w-full" />
          <p className="text-xs text-[var(--color-muted)] mt-1.5">{picked.length} member(s) selected</p>
          {error && <p className="text-xs text-warn mt-1.5">{error}</p>}
        </div>
        <div className="flex-1 overflow-y-auto">
          {users.map((u) => (
            <label key={u.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-canvas cursor-pointer">
              <input type="checkbox" checked={picked.includes(u.id)} onChange={() => toggle(u.id)} className="w-4 h-4" />
              <Avatar name={u.full_name || u.username} online={!!u.online} size={30} />
              <span className="text-sm text-ink">{u.full_name || u.username}</span>
            </label>
          ))}
        </div>
        <div className="p-3 border-t border-line">
          <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary w-full disabled:opacity-50">
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </div>
      </form>
    </div>
  );
}

// --------------------------------------------------------------- broadcast
function BroadcastModal({ users, onClose, onSent }) {
  const [picked, setPicked] = useState([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const submit = async (e) => {
    e.preventDefault();
    if (!picked.length) return setError('Select at least one person.');
    if (!body.trim()) return setError('Type a message.');
    setBusy(true); setError('');
    try { onSent(await api.chatBroadcast(picked, { body: body.trim() })); } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <div className="absolute inset-0 z-10 bg-white flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
        <button onClick={onClose}><ArrowLeft className="w-4 h-4 text-[var(--color-muted)]" /></button>
        <h3 className="text-sm font-semibold text-ink">Send to several people</h3>
      </div>
      <form onSubmit={submit} className="flex-1 flex flex-col min-h-0">
        <div className="px-4 py-3 border-b border-line">
          <p className="text-xs text-[var(--color-muted)]">
            Each person gets this in their own private chat — they won&apos;t see each other&apos;s replies.
            For a shared conversation, make a group instead.
          </p>
          {error && <p className="text-xs text-warn mt-1.5">{error}</p>}
        </div>
        <div className="flex-1 overflow-y-auto">
          {users.map((u) => (
            <label key={u.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-canvas cursor-pointer">
              <input type="checkbox" checked={picked.includes(u.id)} onChange={() => toggle(u.id)} className="w-4 h-4" />
              <Avatar name={u.full_name || u.username} online={!!u.online} size={30} />
              <span className="text-sm text-ink">{u.full_name || u.username}</span>
            </label>
          ))}
        </div>
        <div className="p-3 border-t border-line space-y-2">
          <textarea value={body} onChange={(e) => { setBody(e.target.value); setError(''); }} rows={3}
            placeholder="Your message…" className="border border-line rounded-lg px-3 py-2 text-sm w-full" />
          <button type="submit" disabled={busy} className="btn btn-primary w-full disabled:opacity-50">
            {busy ? 'Sending…' : `Send to ${picked.length || 0} people`}
          </button>
        </div>
      </form>
    </div>
  );
}

// ================================================================= widget
// variant "popup" (default): the compact header icon + floating popup.
// variant "page": the same panel rendered inline, filling its container —
// used by pages/TeamChat.jsx for "Open Full Chat". Same state, same
// polling, same send/receive logic either way; only the outer chrome
// differs, which is why this stayed one file instead of two.
export default function ChatWidget({ variant = 'popup' }) {
  const isPage = variant === 'page';
  const { user } = useAuth();
  const navigate = useNavigate();
  const canChat = !!user?.permissions?.chat?.view;

  const [open, setOpen] = useState(isPage);
  const [users, setUsers] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState([]);
  const [unread, setUnread] = useState(0);
  const [search, setSearch] = useState('');
  const [view, setView] = useState('list');          // list | group | broadcast
  const [tab, setTab] = useState('all');              // all | unread | groups — filters the conversation list only
  const [toasts, setToasts] = useState([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  // Which message the composer is replying to, and whether the panel is
  // shrunk to a bar so the CRM is fully usable while staying reachable.
  const [replyTo, setReplyTo] = useState(null);
  const [minimised, setMinimised] = useState(false);

  // Notification tone. Read once from localStorage; the ref is what the
  // polling loop reads, because that loop is set up with stale closures and
  // would otherwise keep playing whatever tone was selected when it started.
  const [tone, setToneState] = useState(() => getTone(user?.id));
  const toneRef = useRef(tone);
  const [soundMenu, setSoundMenu] = useState(false);
  useEffect(() => { toneRef.current = tone; }, [tone]);
  const chooseTone = (id) => {
    setToneState(id);
    setTone(user?.id, id);
    playTone(id);          // hear it immediately — that is the whole point
  };

  const cursor = useRef(0);
  const messageRefs = useRef({});
  const bottomRef = useRef(null);
  const scrollRef = useRef(null);
  // Set the moment a different conversation is selected, cleared once its
  // first paint has been pinned to the bottom. See the scroll effect below.
  const jumpInstantly = useRef(true);
  const activeIdRef = useRef(null);
  const openRef = useRef(false);
  const minimisedRef = useRef(false);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => { minimisedRef.current = minimised; }, [minimised]);

  const active = useMemo(() => conversations.find((c) => c.id === activeId) || null, [conversations, activeId]);

  // ---------------------------------------------------------------- poll
  const tick = useCallback(async () => {
    if (!canChat) return;
    try {
      const res = await api.chatPoll(cursor.current, activeIdRef.current);
      cursor.current = res.cursor;
      setConversations(res.conversations);
      setUnread(res.total_unread);

      // Refresh the read ticks on messages already rendered.
      if (res.receipts) {
        const { conversation_id: rc, seen_by_all_upto, others_count } = res.receipts;
        setMessages((prev) => prev.map((m) => (
          m.conversation_id === rc && m.mine && !m.seen_by_all
            ? { ...m, seen_by_all: others_count > 0 && m.id <= seen_by_all_upto }
            : m
        )));
      }

      if (res.messages.length) {
        const openId = activeIdRef.current;
        // Messages for the thread on screen append straight in.
        const forOpen = res.messages.filter((m) => m.conversation_id === openId);
        if (forOpen.length) {
          setMessages((prev) => {
            const seen = new Set(prev.map((p) => p.id));
            return [...prev, ...forOpen.filter((m) => !seen.has(m.id))];
          });
          api.chatMarkRead(openId).catch(() => {});
        }
        // Anything else raises a popup, unless that conversation is muted.
        // A popup is for something you cannot already see. That means a
        // different conversation, a closed panel — or a minimised one, which
        // is open but shows no messages at all, so a new message there would
        // otherwise arrive completely silently.
        const visible = openRef.current && !minimisedRef.current;
        const elsewhere = res.messages.filter((m) => m.conversation_id !== openId || !visible);
        const mutedIds = new Set(res.conversations.filter((c) => c.muted).map((c) => c.id));
        const notify = elsewhere.filter((m) => !mutedIds.has(m.conversation_id));
        if (notify.length) {
          // One tone per poll, not one per message: three messages arriving
          // together should sound like one notification, not a burst.
          playTone(toneRef.current);
          setToasts((t) => [...t, ...notify.slice(-3)].slice(-3));
          notify.slice(-3).forEach((m) => {
            setTimeout(() => setToasts((t) => t.filter((x) => x.id !== m.id)), TOAST_MS);
          });
        }
      }
    } catch { /* transient — the next tick retries */ }
  }, [canChat]);

  useEffect(() => {
    if (!canChat) return undefined;
    // First check a moment after the page loads, so the page's own data is
    // answered first (the server handles one request at a time).
    const first = setTimeout(tick, 1500);
    let timer;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => { await tick(); schedule(); },
        document.hidden ? POLL_HIDDEN_MS : (openRef.current && !minimisedRef.current ? POLL_OPEN_MS : POLL_CLOSED_MS));
    };
    schedule();
    const onVis = () => { if (!document.hidden) { tick(); schedule(); } };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearTimeout(first); clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [canChat, tick]);

  useEffect(() => {
    if (open && canChat) api.chatUsers().then(setUsers).catch(() => {});
  }, [open, canChat]);

  useEffect(() => {
    setReplyTo(null);
    jumpInstantly.current = true;
    if (!activeId) { setMessages([]); return; }
    api.chatMessages(activeId).then((m) => {
      setMessages(m);
      api.chatMarkRead(activeId).then(tick).catch(() => {});
    }).catch((e) => setError(e.message));
  }, [activeId, tick]);

  // Where the message list sits when you open a conversation.
  //
  // It has to open on the NEWEST message — that is the one you came to read.
  // The first version scrolled with `scrollIntoView({ behavior: 'smooth' })`
  // keyed on messages.length, which failed on open for two reasons: a smooth
  // scroll is animated, and from a standing start at the top of a long history
  // it either visibly crawls down or gets cancelled by the next render; and it
  // ran in useEffect, i.e. after the browser had already painted the top of
  // the list.
  //
  // So: useLayoutEffect (before paint, so there is no flash of the oldest
  // message) and a direct scrollTop assignment (instant, no animation) for the
  // initial load. Smooth scrolling is kept only for messages that arrive while
  // you are watching — there it reads as movement rather than a jump.
  //
  // The re-pins on a timer cover attachments: an image or PDF thumbnail has no
  // height until it loads, so the container grows a moment after the first
  // paint and the bottom moves down under us.
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box) return undefined;

    if (jumpInstantly.current) {
      jumpInstantly.current = false;
      const pin = () => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; };
      pin();
      const timers = [requestAnimationFrame(pin)];
      const t1 = setTimeout(pin, 150);
      const t2 = setTimeout(pin, 500);
      return () => { timers.forEach(cancelAnimationFrame); clearTimeout(t1); clearTimeout(t2); };
    }

    // A new message arrived. Only follow it if the reader is already at the
    // bottom — yanking someone away from history they scrolled up to read is
    // worse than a missed message, and the unread badge covers that case.
    const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    if (distanceFromBottom < 160) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    return undefined;
  }, [messages]);

  // Re-opening or restoring the panel remounts the list with the same messages
  // array, so the effect above does not re-run. Pin again here, otherwise a
  // conversation you close and reopen comes back at the top.
  useLayoutEffect(() => {
    if (!open || minimised) return undefined;
    // Pin directly rather than setting jumpInstantly — that flag is only
    // cleared by the messages effect, so setting it here left it armed, and
    // the next arriving message then yanked the view to the bottom even for
    // someone scrolled up reading history.
    const pin = () => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; };
    pin();
    const frame = requestAnimationFrame(pin);
    const t = setTimeout(pin, 150);
    return () => { cancelAnimationFrame(frame); clearTimeout(t); };
  }, [open, minimised]);

  // Escape closes the panel — the usual way out now that clicking the page
  // no longer dismisses it (the page is deliberately still interactive).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // First Escape tucks it away, a second closes it.
      if (replyTo) setReplyTo(null);
      else if (!minimised) setMinimised(true);
      else setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, minimised, replyTo]);

  // -------------------------------------------------------------- actions
  const openWith = async (u) => {
    try {
      const conv = await api.chatOpenDirect(u.id);
      setConversations((c) => (c.some((x) => x.id === conv.id) ? c : [conv, ...c]));
      setActiveId(conv.id);
      setView('list');
    } catch (e) { setError(e.message); }
  };

  const send = async (e) => {
    e?.preventDefault();
    if (!activeId || (!draft.trim() && files.length === 0) || sending) return;
    setSending(true); setError('');
    try {
      const msg = await api.chatSend(activeId, { body: draft.trim(), files, replyToId: replyTo?.id });
      setMessages((m) => [...m, msg]);
      setDraft(''); setFiles([]); setReplyTo(null);
      tick();
    } catch (err) { setError(err.message); } finally { setSending(false); }
  };

  const removeMessage = async (m) => {
    if (!window.confirm('Delete this message?')) return;
    try {
      await api.chatDeleteMessage(m.id);
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, deleted: true, body: null, attachments: [] } : x)));
    } catch (e) { setError(e.message); }
  };

  const toggleMute = async () => {
    if (!active) return;
    try { await api.chatMute(active.id, !active.muted); tick(); } catch (e) { setError(e.message); }
  };

  // Clicking a quote scrolls to the original and flashes it, so a reply in a
  // long thread can be traced back.
  const jumpTo = (id) => {
    const el = messageRefs.current[id];
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-2', 'ring-[var(--color-brand)]', 'rounded-2xl');
    setTimeout(() => el.classList.remove('ring-2', 'ring-[var(--color-brand)]', 'rounded-2xl'), 1400);
  };

  const openToast = (t) => {
    setActiveId(t.conversation_id);
    setOpen(true);
    setMinimised(false);
    setToasts((x) => x.filter((y) => y.id !== t.id));
  };

  // Hiding the icon is right when someone genuinely lacks the permission, but
  // it also makes "the backend hasn't been redeployed" look identical to
  // "the feature doesn't exist". Say which, once, in the console.
  useEffect(() => {
    if (user && !canChat) {
      const hasChatKey = user.permissions && 'chat' in user.permissions;
      console.info(
        hasChatKey
          ? '[chat] Hidden: your role does not have chat view permission (Roles & Permissions -> chat).'
          : '[chat] Hidden: this backend has no chat permission yet — it has not been redeployed with the chat migration.',
      );
    }
  }, [user, canChat]);

  if (!canChat) return null;

  // "Everyone" (people with no conversation yet) is for starting a new chat,
  // which only makes sense in the All tab — Unread/Groups filter EXISTING
  // conversations, they don't have an equivalent among people you haven't
  // messaged yet.
  const filteredUsers = tab === 'all'
    ? users.filter((u) => (u.full_name || u.username).toLowerCase().includes(search.toLowerCase()))
    : [];
  const filteredConvs = conversations
    .filter((c) => (c.title || '').toLowerCase().includes(search.toLowerCase()))
    .filter((c) => (tab === 'unread' ? c.unread > 0 : tab === 'groups' ? c.type === 'group' : true));

  return (
    <>
      {/* Header trigger — a dedicated page has no icon to click, it IS the panel */}
      {!isPage && (
      <button onClick={() => setOpen((o) => !o)} title="Team chat"
        className="relative w-10 h-10 rounded-xl flex items-center justify-center hover:bg-[var(--color-brand-soft)] transition-colors">
        <MessageSquare className="w-[18px] h-[18px] text-[var(--color-brand)]" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[17px] h-[17px] px-1 rounded-full text-[10px] font-bold
            text-white flex items-center justify-center" style={{ background: 'var(--color-danger)' }}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      )}

      {/* Pop-up notifications and the panel are portalled to <body>: the
          header they are declared inside is `sticky z-30`, which creates a
          stacking context that would otherwise trap them beneath the
          assistant launcher. */}
      {createPortal((
        <div className="fixed bottom-24 right-4 z-[80] space-y-2 w-80 pointer-events-none">
        {toasts.map((t) => (
          <button key={t.id} onClick={() => openToast(t)}
            className="pointer-events-auto w-full text-left bg-white border border-line rounded-xl shadow-lg p-3 flex gap-2.5 hover:border-[var(--color-brand)]">
            <Avatar name={t.sender_name} size={34} />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-ink">{t.sender_name}</span>
              <span className="block text-xs text-[var(--color-muted)] truncate">
                {t.body || (t.attachments?.length ? 'Sent an attachment' : '')}
              </span>
            </span>
          </button>
        ))}
        </div>
      ), document.body)}

      {/* Minimised: a small bar in the corner. Polling, unread counts and
          popups all keep working — this is only a change of size, so people
          can leave chat running while they work. */}
      {!isPage && open && minimised && createPortal((
        <button
          type="button"
          onClick={() => setMinimised(false)}
          className="fixed bottom-4 right-[76px] z-[80] flex items-center gap-2.5 bg-white border border-line
                     shadow-lg rounded-full pl-3 pr-4 py-2.5 hover:border-[var(--color-brand)]"
        >
          <MessageSquare className="w-4 h-4 text-[var(--color-brand)]" />
          <span className="text-sm font-medium text-ink">
            {active ? active.title : 'Team Chat'}
          </span>
          {unread > 0 && (
            <span className="min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold text-white
              flex items-center justify-center" style={{ background: 'var(--color-danger)' }}>
              {unread > 99 ? '99+' : unread}
            </span>
          )}
          <Maximize2 className="w-3.5 h-3.5 text-[var(--color-muted)]" />
        </button>
      ), document.body)}

      {/* Same panel either way — only whether it's portalled to <body> as a
          floating popup, or left right where it is as a normal page block,
          differs by variant. */}
      {open && !minimised && (isPage ? (v) => v : (children) => createPortal(children, document.body))((
        <>
          {/* No dimming backdrop and no full-screen click-catcher: the point
              of a team chat is to keep it open WHILE working. On phones it
              still takes the full screen — a 380px popup makes no sense on a
              6" display — but at sm: and up this is the compact, single-pane
              "quick chat" popup: list OR conversation, never both side by
              side, the same way the mobile layout already worked below sm:.
              The CRM stays fully usable behind this. Close with the X, the
              header icon, or Escape.
              In page mode there's no portal, no fixed positioning, and no
              backdrop at all — it's a normal block inside the page, and (on
              a wide enough screen) both panes show side by side the way the
              popup deliberately does NOT, because a full page has the room. */}
          <aside
            role="dialog"
            aria-label="Team chat"
            className={isPage
              ? 'relative w-full h-full bg-white overflow-hidden flex flex-col sm:flex-row rounded-2xl border border-[var(--color-line)]'
              : `fixed z-[76] bg-white overflow-hidden flex flex-col rounded-2xl border border-[var(--color-line)]
                 left-3 right-3 bottom-3 max-h-[72vh]
                 sm:inset-auto sm:left-auto sm:bottom-auto sm:right-[18px] sm:top-[72px]
                 sm:w-[380px] sm:h-[560px] sm:max-h-[70vh]`}
            style={isPage ? undefined : { boxShadow: '0 12px 35px rgba(23,35,60,0.14)' }}>
            {/* ---------------- left: people and conversations ---------------- */}
            <div className={isPage
              ? `${activeId ? 'hidden sm:flex' : 'flex'} flex-col w-full sm:w-[300px] sm:border-r sm:border-line min-h-0 relative`
              : `${activeId ? 'hidden' : 'flex'} flex-col w-full min-h-0 relative`}>
              <div className="flex items-center justify-between px-4 py-3 border-b border-line">
                <h2 className="text-base font-semibold text-ink">Team Chat</h2>
                <div className="flex items-center gap-1">
                  {/* Notification tone. Lives here rather than in Settings
                      because it is chosen in the moment a sound annoys you,
                      and each option previews on click so it can be picked by
                      ear instead of by name. */}
                  <div className="relative">
                    <button onClick={() => setSoundMenu((s) => !s)} title="Notification tone"
                      className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-canvas">
                      {tone === 'silent'
                        ? <VolumeX className="w-4 h-4 text-[var(--color-muted)]" />
                        : <Volume2 className="w-4 h-4 text-[var(--color-muted)]" />}
                    </button>
                    {soundMenu && (
                      <>
                        <div className="fixed inset-0 z-[78]" onClick={() => setSoundMenu(false)} />
                        <div className="absolute left-0 top-9 z-[79] w-56 bg-white border border-line rounded-xl shadow-xl py-1">
                          <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                            Notification tone
                          </p>
                          {TONES.map((t) => (
                            <button
                              key={t.id}
                              onClick={() => chooseTone(t.id)}
                              className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-canvas ${
                                tone === t.id ? 'bg-canvas' : ''
                              }`}
                            >
                              <span className="w-4 flex-shrink-0">
                                {tone === t.id && <Check className="w-3.5 h-3.5 text-[var(--color-brand)]" />}
                              </span>
                              <span className="flex-1 min-w-0">
                                <span className="block text-sm text-ink">{t.label}</span>
                                <span className="block text-[11px] text-[var(--color-muted)]">{t.hint}</span>
                              </span>
                              {t.id !== 'silent' && (
                                <Play className="w-3 h-3 text-[var(--color-muted)] flex-shrink-0" />
                              )}
                            </button>
                          ))}
                          <p className="px-3 pt-1.5 pb-1 text-[10px] text-[var(--color-muted)] border-t border-line mt-1">
                            Your choice only — it applies to this browser and no one else.
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                  <button onClick={() => setView('broadcast')} title="Send to several people"
                    className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-canvas">
                    <Megaphone className="w-4 h-4 text-[var(--color-muted)]" />
                  </button>
                  <button onClick={() => setView('group')} title="New group"
                    className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-canvas">
                    <Plus className="w-4 h-4 text-[var(--color-muted)]" />
                  </button>
                  {!isPage && (<>
                  <button onClick={() => setMinimised(true)} title="Minimise"
                    className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-canvas">
                    <Minus className="w-4 h-4 text-[var(--color-muted)]" />
                  </button>
                  <button onClick={() => setOpen(false)} title="Close"
                    className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-canvas">
                    <X className="w-4 h-4 text-[var(--color-muted)]" />
                  </button>
                  </>)}
                </div>
              </div>

              <div className="flex items-center gap-1 px-3 pt-2.5 pb-1">
                {[['all', 'All'], ['unread', 'Unread'], ['groups', 'Groups']].map(([id, label]) => (
                  <button key={id} onClick={() => setTab(id)}
                    className={`px-2.5 h-8 rounded-lg text-xs font-medium transition-colors ${
                      tab === id
                        ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)]'
                        : 'text-[var(--color-muted)] hover:bg-canvas'
                    }`}>
                    {label}
                  </button>
                ))}
              </div>

              <div className="px-3 py-2 border-b border-line">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)]" />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people…"
                    className="w-full border border-[var(--color-line)] rounded-[10px] pl-8 pr-3 h-10 text-xs bg-[var(--color-canvas)]
                               focus:outline-none focus:border-[var(--color-brand)] focus:bg-white" />
                </div>
              </div>

              <div className="flex-1 overflow-y-auto min-h-0">
                {filteredConvs.length > 0 && (
                  <div className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-muted)]">Conversations</div>
                )}
                {filteredConvs.map((c) => (
                  <button key={c.id} onClick={() => setActiveId(c.id)}
                    className={`w-full text-left pl-[9px] pr-3 py-3 flex items-center gap-2.5 border-l-[3px] ${
                      activeId === c.id
                        ? 'bg-[var(--color-brand-soft)] border-l-[var(--color-brand)]'
                        : 'border-l-transparent hover:bg-[var(--color-brand-faint)]'
                    }`}>
                    {c.type === 'group'
                      ? <div className="w-[38px] h-[38px] rounded-full flex items-center justify-center shrink-0 text-white"
                          style={{ background: avatarGradientFor(c.title || 'group') }}><Users className="w-4 h-4" /></div>
                      : <Avatar name={c.title} online={c.online} />}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-ink truncate">{c.title}</span>
                        {c.last_message && <span className="text-[10px] text-[var(--color-muted)] shrink-0">{timeOf(c.last_message.created_at)}</span>}
                      </span>
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-xs text-[var(--color-muted)] truncate">
                          {c.last_message ? `${c.type === 'group' && c.last_message.sender_id !== user.id ? `${c.last_message.sender_name}: ` : ''}${c.last_message.body}` : 'No messages yet'}
                        </span>
                        {c.unread > 0 && (
                          // Purple here (calmer, brand-coloured), not the red
                          // used on the header icon — that badge is the "you
                          // haven't looked at all" alert; this one is a count
                          // inside chat you're already looking at.
                          <span className="min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold text-white
                            flex items-center justify-center shrink-0" style={{ background: 'var(--color-brand)' }}>{c.unread}</span>
                        )}
                      </span>
                    </span>
                  </button>
                ))}

                <div className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-muted)]">
                  Everyone ({filteredUsers.filter((u) => u.online).length} online)
                </div>
                {filteredUsers.map((u) => (
                  <button key={u.id} onClick={() => openWith(u)}
                    className="w-full text-left px-3 py-2 flex items-center gap-2.5 hover:bg-canvas">
                    <Avatar name={u.full_name || u.username} online={!!u.online} size={32} />
                    <span className="min-w-0">
                      <span className="block text-sm text-ink truncate">{u.full_name || u.username}</span>
                      <span className="block text-[11px] text-[var(--color-muted)]">{u.online ? 'Online' : 'Offline'}</span>
                    </span>
                  </button>
                ))}
                {filteredUsers.length === 0 && filteredConvs.length === 0 && (
                  <p className="text-xs text-[var(--color-muted)] text-center py-8">No one matches “{search}”.</p>
                )}
              </div>

              {!isPage && (
                <div className="px-4 py-2.5 border-t border-[var(--color-line-soft)] text-center shrink-0">
                  <button onClick={() => { setOpen(false); navigate('/chat'); }}
                    className="text-[13px] font-semibold" style={{ color: 'var(--color-brand)' }}>
                    Open Full Chat →
                  </button>
                </div>
              )}

              {view === 'group' && (
                <NewGroupModal users={users} onClose={() => setView('list')}
                  onCreated={(c) => { setView('list'); setActiveId(c.id); tick(); }} />
              )}
              {view === 'broadcast' && (
                <BroadcastModal users={users} onClose={() => setView('list')}
                  onSent={() => { setView('list'); tick(); }} />
              )}
            </div>

            {/* ---------------- right: the conversation ---------------- */}
            <div className={isPage
              ? `${activeId ? 'flex' : 'hidden sm:flex'} flex-col flex-1 min-w-0 min-h-0`
              : `${activeId ? 'flex' : 'hidden'} flex-col flex-1 min-w-0 min-h-0`}>
              {!active ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
                  <div className="w-12 h-12 rounded-full flex items-center justify-center mb-3"
                    style={{ background: 'var(--color-brand-soft)' }}>
                    <MessageSquare className="w-5 h-5" style={{ color: 'var(--color-brand)' }} />
                  </div>
                  <p className="text-sm font-medium text-ink">Select a conversation</p>
                  <p className="text-xs text-[var(--color-muted)] mt-0.5">Choose a teammate to start chatting.</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2.5 px-4 py-3 border-b border-line">
                    <button onClick={() => setActiveId(null)} title="Back to conversations"
                      className={isPage ? 'sm:hidden' : ''}>
                      <ArrowLeft className="w-4 h-4 text-[var(--color-muted)]" />
                    </button>
                    {active.type === 'group'
                      ? <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-white"
                          style={{ background: avatarGradientFor(active.title || 'group') }}><Users className="w-4 h-4" /></div>
                      : <Avatar name={active.title} online={active.online} />}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-ink truncate">{active.title}</div>
                      <div className="text-[11px] text-[var(--color-muted)]">
                        {active.type === 'group'
                          ? `${active.member_count} members · ${active.members.filter((m) => m.online).length} online`
                          : (active.online ? 'Online' : 'Offline')}
                      </div>
                    </div>
                    <button onClick={toggleMute} title={active.muted ? 'Unmute' : 'Mute notifications'}
                      className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-canvas">
                      {active.muted ? <BellOff className="w-4 h-4 text-[var(--color-muted)]" /> : <Bell className="w-4 h-4 text-[var(--color-muted)]" />}
                    </button>
                    {!isPage && (<>
                    <button onClick={() => setMinimised(true)} title="Minimise"
                      className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-canvas">
                      <Minus className="w-4 h-4 text-[var(--color-muted)]" />
                    </button>
                    <button onClick={() => setOpen(false)} title="Close"
                      className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-canvas">
                      <X className="w-4 h-4 text-[var(--color-muted)]" />
                    </button>
                    </>)}
                  </div>

                  <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-2" style={{ background: 'var(--color-canvas)' }}>
                    {messages.length === 0 && (
                      <p className="text-xs text-[var(--color-muted)] text-center py-8">
                        No messages yet — say hello.
                      </p>
                    )}
                    {messages.map((m) => (
                      <div key={m.id} ref={(el) => { messageRefs.current[m.id] = el; }}>
                        <MessageBubble
                          m={m}
                          isGroup={active.type === 'group'}
                          onDelete={removeMessage}
                          onReply={setReplyTo}
                          onJumpTo={jumpTo}
                        />
                      </div>
                    ))}
                    <div ref={bottomRef} />
                  </div>

                  {error && <p className="text-xs text-warn px-4 py-1.5 bg-red-50 border-t border-red-200">{error}</p>}

                  {files.length > 0 && (
                    <div className="px-4 py-2 border-t border-line flex gap-2 flex-wrap">
                      {files.map((f, i) => (
                        <span key={i} className="text-xs bg-canvas border border-line rounded-lg px-2 py-1 flex items-center gap-1.5">
                          {f.name}
                          <button onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}><X className="w-3 h-3" /></button>
                        </span>
                      ))}
                    </div>
                  )}

                  {replyTo && (
                    <div className="flex items-start gap-2 px-3 py-2 border-t border-line bg-[var(--color-canvas)]">
                      <div className="w-0.5 self-stretch rounded" style={{ background: 'var(--color-brand)' }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-semibold" style={{ color: 'var(--color-brand)' }}>
                          Replying to {replyTo.mine ? 'yourself' : replyTo.sender_name}
                        </div>
                        <div className="text-xs text-[var(--color-muted)] truncate">
                          {replyTo.body || (replyTo.attachments?.length ? 'Attachment' : '')}
                        </div>
                      </div>
                      <button type="button" onClick={() => setReplyTo(null)} title="Cancel reply"
                        className="shrink-0 text-[var(--color-muted)] hover:text-ink">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}

                  <form onSubmit={send} className="flex items-end gap-2 px-3 py-2.5 border-t border-line">
                    <label className="w-9 h-9 rounded-lg flex items-center justify-center hover:bg-canvas cursor-pointer shrink-0"
                      title="Attach image, PDF or document">
                      <Paperclip className="w-4 h-4 text-[var(--color-muted)]" />
                      <input type="file" multiple className="hidden"
                        accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
                        onChange={(e) => { setFiles([...e.target.files].slice(0, 5)); e.target.value = ''; }} />
                    </label>
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                      rows={1} placeholder="Write a message…  (Enter to send, Shift+Enter for a new line)"
                      className="flex-1 border border-[var(--color-line)] rounded-[10px] px-3 py-2 text-sm resize-none max-h-32
                                 bg-[var(--color-canvas)] focus:outline-none focus:border-[var(--color-brand)] focus:bg-white" />
                    <button type="submit" disabled={sending || (!draft.trim() && !files.length)}
                      className="w-10 h-10 rounded-lg flex items-center justify-center text-white disabled:opacity-40 shrink-0"
                      style={{ background: 'var(--color-brand)' }}>
                      <Send className="w-4 h-4" />
                    </button>
                  </form>
                </>
              )}
            </div>
          </aside>
        </>
      ), document.body)}
    </>
  );
}
