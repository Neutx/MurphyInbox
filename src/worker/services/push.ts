// Push notifications for new inbox mail, sent to every device of every member of the mailbox.
// Cost per message: one D1 read, one subrequest per device, a handful of native crypto calls.
import type { Env } from '../env';
import { loadSettings, type AppSettings } from '../db/settings';
import { all, first, placeholders, run } from '../db/db';
import { decryptJson, encryptJson } from '../lib/crypto';
import { generateVapidKeys, sendPush, type PushTarget, type VapidKeys } from '../lib/webpush';
import { log, logError } from '../lib/log';

// Free-plan Workers allow 50 subrequests per invocation; inbound mail uses a few of its own.
const MAX_DEVICES_PER_MESSAGE = 20;
// A device that keeps failing (not a clean 404/410) is dropped after this many attempts in a row.
const MAX_FAILURES = 10;

// The instance's VAPID key pair, created on first use. Two isolates racing both try to insert; the
// first wins and both read back the same row.
export async function vapidKeys(env: Env, settings: AppSettings): Promise<VapidKeys> {
  if (settings.pushVapidEnc) return decryptJson<VapidKeys>(env, settings.pushVapidEnc);
  const fresh = await encryptJson(env, await generateVapidKeys());
  await run(env.DB, "INSERT INTO settings (key, value, updated_at) VALUES ('push.vapid', ?, ?) ON CONFLICT (key) DO NOTHING", fresh, Date.now());
  const stored = await first<{ value: string }>(env.DB, "SELECT value FROM settings WHERE key = 'push.vapid'");
  await loadSettings(env.DB, true);
  return decryptJson<VapidKeys>(env, stored?.value ?? fresh);
}

// Push services want a contact: the app's URL, or the owner's address.
async function vapidSubject(env: Env, settings: AppSettings): Promise<string> {
  if (settings.appUrl?.startsWith('https://')) return settings.appUrl;
  const owner = await first<{ email: string }>(env.DB, "SELECT email FROM users WHERE role = 'owner' ORDER BY id LIMIT 1");
  return `mailto:${owner?.email ?? 'postmaster@localhost'}`;
}

interface SubscriptionRow extends PushTarget {
  id: number;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  kind?: 'mail' | 'test';
}

export async function pushTo(env: Env, settings: AppSettings, subs: SubscriptionRow[], payload: PushPayload): Promise<number> {
  if (!subs.length) return 0;
  const keys = await vapidKeys(env, settings);
  const subject = await vapidSubject(env, settings);
  const ok: number[] = [];
  const gone: number[] = [];
  const failed: number[] = [];
  await Promise.all(
    subs.slice(0, MAX_DEVICES_PER_MESSAGE).map(async (s) => {
      try {
        const r = await sendPush(s, payload, keys, subject);
        if (r.gone) gone.push(s.id);
        else if (r.status >= 200 && r.status < 300) ok.push(s.id);
        else {
          failed.push(s.id);
          log('push.rejected', { status: r.status, host: new URL(s.endpoint).host });
        }
      } catch (e) {
        failed.push(s.id);
        logError('push.failed', e, { host: new URL(s.endpoint).host });
      }
    }),
  );
  const stmts: D1PreparedStatement[] = [];
  if (ok.length) stmts.push(env.DB.prepare(`UPDATE push_subscriptions SET last_success_at = ?, failures = 0 WHERE id IN (${placeholders(ok.length)})`).bind(Date.now(), ...ok));
  if (gone.length) stmts.push(env.DB.prepare(`DELETE FROM push_subscriptions WHERE id IN (${placeholders(gone.length)})`).bind(...gone));
  if (failed.length) {
    stmts.push(env.DB.prepare(`UPDATE push_subscriptions SET failures = failures + 1 WHERE id IN (${placeholders(failed.length)})`).bind(...failed));
    stmts.push(env.DB.prepare('DELETE FROM push_subscriptions WHERE failures >= ?').bind(MAX_FAILURES));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return ok.length;
}

export async function notifyNewMail(
  env: Env,
  settings: AppSettings,
  m: { mailboxId: number; threadId: number; fromName: string; fromAddress: string; subject: string; snippet: string },
): Promise<void> {
  const subs = await all<SubscriptionRow>(
    env.DB,
    `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
       JOIN mailbox_members mm ON mm.user_id = s.user_id
       JOIN users u ON u.id = s.user_id
      WHERE mm.mailbox_id = ? AND u.status = 'active'
      ORDER BY s.last_success_at DESC`,
    m.mailboxId,
  );
  if (!subs.length) return;
  const subject = m.subject.trim() || '(no subject)';
  await pushTo(env, settings, subs, {
    kind: 'mail',
    title: (m.fromName || m.fromAddress).slice(0, 80),
    body: `${subject}${m.snippet ? `\n${m.snippet}` : ''}`.slice(0, 240),
    url: `/mail/${m.mailboxId}/inbox/${m.threadId}`,
    tag: `thread-${m.threadId}`,
  });
}
