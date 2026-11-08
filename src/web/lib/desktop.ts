// The Windows/macOS app (desktop/) loads this web app and exposes window.murphyDesktop. Electron has
// no browser push service, so there notifications come from the mail check the app already runs
// (data.ts useMailSync), shown with the system's native notifications.
import { get } from './api';
import { ownAddresses } from './mail';
import { storageGet, storageSet } from './utils';
import type { Mailbox, ThreadSummary } from './types';

interface DesktopBridge {
  platform: string;
  focus: () => void;
  setBadge: (count: number) => void;
}

declare global {
  interface Window {
    murphyDesktop?: DesktopBridge;
  }
}

export const desktop = (): DesktopBridge | undefined => window.murphyDesktop;

const KEY = 'oi.desktopNotify';
export const desktopNotifyOn = () => storageGet(KEY, true) && Notification.permission === 'granted';

export async function setDesktopNotify(on: boolean): Promise<boolean> {
  if (on && Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') return false;
  storageSet(KEY, on);
  return on;
}

let seen: Map<number, number> | null = null; // thread id -> lastMessageAt already notified about

function open(url: string) {
  desktop()?.focus();
  window.history.pushState({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function showDesktopNotification(title: string, body: string, url: string, tag?: string): void {
  const n = new Notification(title, { body, tag, icon: '/icon-192.png' });
  n.onclick = () => open(url);
}

// Called after every mail check. The first call only records what's there.
export async function desktopMailCheck(mailboxes: Mailbox[]): Promise<void> {
  const bridge = desktop();
  if (!bridge) return;
  bridge.setBadge(mailboxes.reduce((n, m) => n + (m.unread.inbox ?? 0), 0));
  if (!desktopNotifyOn()) return;
  const { threads } = await get<{ threads: ThreadSummary[] }>('/threads?mailbox=all&view=inbox');
  const first = seen === null;
  const prev = seen ?? new Map<number, number>();
  seen = new Map(threads.map((t) => [t.id, t.lastMessageAt]));
  if (first) return;
  const fresh = threads.filter((t) => t.unreadCount > 0 && (prev.get(t.id) ?? 0) < t.lastMessageAt);
  // Nothing to say while you're looking at the app.
  if (!fresh.length || (document.hasFocus() && !document.hidden)) return;
  const own = ownAddresses(mailboxes);
  if (fresh.length > 3) {
    showDesktopNotification('MurphyInbox', `${fresh.length} new conversations in your inbox`, '/mail/all/inbox', 'new-mail');
    return;
  }
  for (const t of fresh) {
    const from = t.participants.find((p) => !own.has(p.address.toLowerCase())) ?? t.participants[0];
    showDesktopNotification((from?.name || from?.address || 'New mail').slice(0, 80), `${t.subject || '(no subject)'}\n${t.snippet}`.slice(0, 240), `/mail/${t.mailboxId}/inbox/${t.id}`, `thread-${t.id}`);
  }
}
