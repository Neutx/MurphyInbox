// The signed-in user's own account: profile, password, two-factor, sessions, trusted senders.
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { body } from '../lib/validate';
import { passwordChangeSchema, profileSchema, pushEndpointSchema, pushSubscriptionSchema, totpSchema, trustedSenderSchema } from '../../shared/schemas';
import { all, first, run } from '../db/db';
import { currentUser, clientIp } from '../auth/middleware';
import { verifyPassword } from '../lib/password';
import { decrypt, encrypt } from '../lib/crypto';
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from '../lib/totp';
import { badRequest, HttpError, notFound } from '../lib/errors';
import { changePassword, type UserRow } from '../services/users';
import { audit } from '../services/audit';
import { pushTo, vapidKeys } from '../services/push';

export const account = new Hono<AppBindings>();

account.patch('/', async (c) => {
  const user = currentUser(c);
  const input = await body(c, profileSchema);
  const prefs = input.preferences ? JSON.stringify({ ...user.preferences, ...input.preferences }).slice(0, 10_000) : null;
  await run(c.env.DB, 'UPDATE users SET name = COALESCE(?, name), preferences = COALESCE(?, preferences) WHERE id = ?', input.name ?? null, prefs, user.id);
  return c.json({ ok: true });
});

// Allowed while a password change is forced (see app.ts).
account.post('/password', async (c) => {
  const user = currentUser(c);
  const { current, next } = await body(c, passwordChangeSchema);
  const row = await first<UserRow>(c.env.DB, 'SELECT * FROM users WHERE id = ?', user.id);
  if (!row) throw notFound();
  if (!row.must_change_password && !(await verifyPassword(current, row.password_hash))) {
    throw new HttpError(400, 'wrong_password', 'Your current password is not correct.');
  }
  if (await verifyPassword(next, row.password_hash)) throw badRequest('Choose a password different from the current one.');
  await changePassword(c.env.DB, user.id, next, c.get('session')?.id);
  await audit(c.env.DB, { userId: user.id, action: 'account.password_changed', ip: clientIp(c) });
  return c.json({ ok: true });
});

account.post('/2fa/setup', async (c) => {
  const user = currentUser(c);
  const secret = newTotpSecret();
  // Stored as pending (not enabled) until a code proves the app is set up.
  await run(c.env.DB, 'UPDATE users SET totp_secret = ? WHERE id = ? AND totp_enabled = 0', await encrypt(c.env, secret), user.id);
  return c.json({ secret, uri: otpauthUri(secret, user.email) });
});

account.post('/2fa/enable', async (c) => {
  const user = currentUser(c);
  const { code } = await body(c, totpSchema);
  const row = await first<UserRow>(c.env.DB, 'SELECT * FROM users WHERE id = ?', user.id);
  if (!row?.totp_secret) throw badRequest('Start two-factor setup first.');
  if (!(await verifyTotp(await decrypt(c.env, row.totp_secret), code))) throw new HttpError(400, 'invalid_code', 'That code is not valid.');
  const codes = newRecoveryCodes();
  const hashes = await Promise.all(codes.map(hashRecoveryCode));
  await run(c.env.DB, 'UPDATE users SET totp_enabled = 1, recovery_codes = ? WHERE id = ?', JSON.stringify(hashes), user.id);
  await audit(c.env.DB, { userId: user.id, action: 'account.2fa_enabled', ip: clientIp(c) });
  return c.json({ recoveryCodes: codes });
});

account.post('/2fa/disable', async (c) => {
  const user = currentUser(c);
  const { current } = await body(c, passwordChangeSchema.pick({ current: true }));
  const row = await first<UserRow>(c.env.DB, 'SELECT * FROM users WHERE id = ?', user.id);
  if (!row || !(await verifyPassword(current, row.password_hash))) throw new HttpError(400, 'wrong_password', 'Your password is not correct.');
  await run(c.env.DB, 'UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL WHERE id = ?', user.id);
  await audit(c.env.DB, { userId: user.id, action: 'account.2fa_disabled', ip: clientIp(c) });
  return c.json({ ok: true });
});

account.get('/sessions', async (c) => {
  const user = currentUser(c);
  const rows = await all<{ id: string; ip: string | null; user_agent: string | null; created_at: number; last_seen_at: number }>(
    c.env.DB,
    'SELECT id, ip, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = ? AND mfa_pending = 0 ORDER BY last_seen_at DESC',
    user.id,
  );
  const current = c.get('session')?.id;
  // Session ids are hashes of the cookie token; exposing a prefix lets the user revoke one.
  return c.json(rows.map((r) => ({ id: r.id.slice(0, 16), ip: r.ip, userAgent: r.user_agent, createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.id === current })));
});

account.delete('/sessions/:id', async (c) => {
  const user = currentUser(c);
  const prefix = c.req.param('id');
  if (!/^[0-9a-f]{16}$/.test(prefix)) throw badRequest('Invalid session.');
  await run(c.env.DB, 'DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ?', user.id, prefix);
  return c.json({ ok: true });
});

account.post('/sessions/revoke-others', async (c) => {
  const user = currentUser(c);
  await run(c.env.DB, 'DELETE FROM sessions WHERE user_id = ? AND id != ?', user.id, c.get('session')?.id ?? '');
  await audit(c.env.DB, { userId: user.id, action: 'account.sessions_revoked', ip: clientIp(c) });
  return c.json({ ok: true });
});

account.get('/trusted-senders', async (c) => {
  const user = currentUser(c);
  return c.json(await all<{ pattern: string }>(c.env.DB, 'SELECT pattern FROM trusted_senders WHERE user_id = ? ORDER BY pattern', user.id));
});

account.post('/trusted-senders', async (c) => {
  const user = currentUser(c);
  const { pattern } = await body(c, trustedSenderSchema);
  await run(c.env.DB, 'INSERT OR IGNORE INTO trusted_senders (user_id, pattern) VALUES (?, ?)', user.id, pattern.toLowerCase());
  return c.json({ ok: true });
});

account.delete('/trusted-senders/:pattern', async (c) => {
  const user = currentUser(c);
  await run(c.env.DB, 'DELETE FROM trusted_senders WHERE user_id = ? AND pattern = ?', user.id, decodeURIComponent(c.req.param('pattern')));
  return c.json({ ok: true });
});

// Web Push. The public key is what the browser subscribes with; each device posts its subscription.
account.get('/push/key', async (c) => {
  const keys = await vapidKeys(c.env, c.get('settings'));
  return c.json({ publicKey: keys.publicKey });
});

account.get('/push/subscriptions', async (c) => {
  const rows = await all<{ endpoint: string; user_agent: string | null; created_at: number; last_success_at: number | null }>(
    c.env.DB,
    'SELECT endpoint, user_agent, created_at, last_success_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC',
    currentUser(c).id,
  );
  return c.json({ devices: rows.map((r) => ({ endpoint: r.endpoint, userAgent: r.user_agent, createdAt: r.created_at, lastSuccessAt: r.last_success_at })) });
});

// Upsert: the app re-posts its subscription on every start, so a rotated key or a device that
// moved to another account stays correct.
account.post('/push/subscriptions', async (c) => {
  const user = currentUser(c);
  const { endpoint, keys } = await body(c, pushSubscriptionSchema);
  const count = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ? AND endpoint != ?', user.id, endpoint);
  if ((count?.n ?? 0) >= 10) throw badRequest('Notifications are on for 10 devices already. Turn them off on one first.');
  await run(
    c.env.DB,
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
       user_agent = excluded.user_agent, failures = 0`,
    user.id,
    endpoint,
    keys.p256dh,
    keys.auth,
    (c.req.header('User-Agent') ?? '').slice(0, 300) || null,
    Date.now(),
  );
  return c.json({ ok: true });
});

account.post('/push/unsubscribe', async (c) => {
  const { endpoint } = await body(c, pushEndpointSchema);
  await run(c.env.DB, 'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, currentUser(c).id);
  return c.json({ ok: true });
});

account.post('/push/test', async (c) => {
  const { endpoint } = await body(c, pushEndpointSchema);
  const subs = await all<{ id: number; endpoint: string; p256dh: string; auth: string }>(
    c.env.DB,
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? AND endpoint = ?',
    currentUser(c).id,
    endpoint,
  );
  if (!subs.length) throw notFound('Notifications are not on for this device.');
  const sent = await pushTo(c.env, c.get('settings'), subs, {
    kind: 'test',
    title: 'MurphyInbox',
    body: 'Notifications work on this device.',
    url: '/mail',
    tag: 'test',
  });
  if (!sent) throw new HttpError(502, 'push_failed', 'The push service did not accept the notification. Turn notifications off and on again.');
  return c.json({ ok: true });
});
