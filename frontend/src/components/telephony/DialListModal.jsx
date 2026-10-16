/*
 * "Auto-dial": make a dial list out of the records ticked in a list.
 *
 * The list is a queue for one agent. On the Auto-dialer page the CRM then
 * calls the people on it one after the other (see pages/Dialer.jsx).
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, ListOrdered, Check } from 'lucide-react';
import { api } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useTelephony } from './telephony';

export const DIAL_LIST_MAX = 2000;

export default function DialListModal({ module = 'leads', ids, noun = 'lead', onClose }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const tel = useTelephony();
  const stamp = new Date().toLocaleString(undefined, { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' });
  const [name, setName] = useState(`${noun[0].toUpperCase()}${noun.slice(1)}s — ${stamp}`);
  const [mode, setMode] = useState('auto');
  const [gap, setGap] = useState(5);
  const [agentId, setAgentId] = useState('');
  const [agents, setAgents] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const manage = !!tel.status?.dial_manage;

  useEffect(() => {
    if (!manage) return;
    api.telephonyAgentsDirectory().then((d) => setAgents(d.agents || [])).catch(() => setAgents([]));
  }, [manage]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const over = Math.max(0, ids.length - DIAL_LIST_MAX);
  const create = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const res = await api.createDialList({ name, module, ids: ids.slice(0, DIAL_LIST_MAX), mode, gap_seconds: gap, user_id: agentId ? Number(agentId) : undefined });
      const left = res.left_out || {};
      if (left.no_number || left.same_number || left.not_yours) setDone(res);
      else navigate(`/dialer/${res.list.id}`);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Auto-dial">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <form onSubmit={create} className="card relative w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 className="t-section flex items-center gap-2"><ListOrdered className="w-4 h-4" style={{ color: 'var(--color-brand)' }} /> Auto-dial {Math.min(ids.length, DIAL_LIST_MAX)} {noun}{ids.length === 1 ? '' : 's'}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-[var(--color-faint)] hover:text-ink p-1 rounded-lg hover:bg-[var(--color-canvas)]"><X className="w-5 h-5" /></button>
        </div>
        {done ? (
          <div className="px-5 py-4 space-y-3">
            <p className="text-sm text-ink flex items-center gap-2"><Check className="w-4 h-4" style={{ color: 'var(--color-success)' }} /> {done.added} put on the list.</p>
            <ul className="t-meta list-disc pl-5 space-y-0.5">
              {done.left_out.no_number > 0 && <li>{done.left_out.no_number} left out: no phone number.</li>}
              {done.left_out.same_number > 0 && <li>{done.left_out.same_number} left out: the same number as another one on the list.</li>}
              {done.left_out.not_yours > 0 && <li>{done.left_out.not_yours} left out: not yours to see.</li>}
            </ul>
            <div className="flex justify-end pt-2"><button type="button" className="btn btn-primary" onClick={() => navigate(`/dialer/${done.list.id}`)}>Open the list</button></div>
          </div>
        ) : (
          <>
            <div className="px-5 py-4 space-y-4">
              {error && <div className="text-xs rounded-lg px-3 py-2" role="alert" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>}
              <div>
                <label className="t-meta font-medium block mb-1" htmlFor="dl-name">Name of the list</label>
                <input id="dl-name" className="input w-full" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
              </div>
              <div role="radiogroup" aria-label="How to dial" className="grid grid-cols-2 gap-2">
                {[['auto', 'Automatic', tel.status?.after_call === 'log' ? 'When a call ends, the next person is called by itself.' : 'After you dispose a call, the next person is called by itself.'],
                  ['preview', 'Preview', 'You see the next person first and press Call when ready.']].map(([key, label, hint]) => (
                  <button key={key} type="button" role="radio" aria-checked={mode === key} onClick={() => setMode(key)}
                    className="text-left rounded-xl border px-3 py-2.5 transition-colors"
                    style={mode === key ? { borderColor: 'var(--color-brand)', background: 'var(--color-brand-soft)' } : { borderColor: 'var(--color-line)' }}>
                    <span className="text-sm font-semibold text-ink block">{label}</span>
                    <span className="t-meta">{hint}</span>
                  </button>
                ))}
              </div>
              {mode === 'auto' && (
                <label className="t-meta flex items-center gap-2">Wait
                  <input type="number" min={0} max={120} className="input" style={{ width: 80 }} value={gap} onChange={(e) => setGap(e.target.value)} aria-label="Seconds between calls" />
                  seconds between calls
                </label>
              )}
              {manage && (
                <div>
                  <label className="t-meta font-medium block mb-1" htmlFor="dl-agent">Who will make these calls</label>
                  <select id="dl-agent" className="input w-full" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                    <option value="">{tel.status?.agent ? 'Me' : 'Choose an agent…'}</option>
                    {(agents || []).filter((a) => a.user_id !== user?.id).map((a) => <option key={a.user_id} value={a.user_id}>{a.name}</option>)}
                  </select>
                </div>
              )}
              <p className="t-meta">
                One call at a time: MCube rings the agent's phone first, then the customer. Records with no phone number are left out.
                {over > 0 ? ` A list holds ${DIAL_LIST_MAX.toLocaleString()} at most: the first ${DIAL_LIST_MAX.toLocaleString()} of your ${ids.length.toLocaleString()} are used.` : ''}
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-line">
              <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={saving || !name.trim()} className="btn btn-primary disabled:opacity-50">{saving ? 'Making the list…' : 'Make the list'}</button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
