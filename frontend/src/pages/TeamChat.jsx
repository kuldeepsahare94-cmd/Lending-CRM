/*
 * Full Team Chat — the destination for "Open Full Chat →" in the quick
 * popup (spec section 12: "The popup is QUICK CHAT. The full module is FULL
 * CHAT. Do not merge these two experiences.")
 *
 * This is deliberately a thin page: all the real logic (polling, sending,
 * attachments, groups, broadcasts, sound) already lives in ChatWidget.jsx.
 * Duplicating that here would mean two implementations of the same feature
 * to keep in sync, and any bug fixed in one place but not the other. This
 * page renders the exact same component in variant="page", which swaps the
 * floating-popup chrome for a normal in-page panel and — because there's
 * room for it on a full page — shows the conversation list and the active
 * conversation side by side on wider screens, the way the compact popup
 * deliberately does not.
 */
import { MessageSquare } from 'lucide-react';
import { PageHeader } from '../components/ui';
import ChatWidget from '../components/ChatWidget';

export default function TeamChat() {
  return (
    <div className="w-full flex flex-col" style={{ height: 'calc(100vh - 96px)' }}>
      <PageHeader
        title="Team Chat"
        subtitle="Direct messages, groups, and broadcasts across the team."
        icon={MessageSquare}
        accent="chat"
      />
      <div className="flex-1 min-h-0 mt-5">
        <ChatWidget variant="page" />
      </div>
    </div>
  );
}
