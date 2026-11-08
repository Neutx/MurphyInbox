// README screenshots (assets/screens) with realistic demo mail. Runs only with OI_SCREENSHOTS=1, after
// app.spec.ts has set up the instance (files run in name order with one worker).
import { expect, test, type Page } from '@playwright/test';

const APP = 'http://localhost:5174';
test.skip(process.env.OI_SCREENSHOTS !== '1', 'Set OI_SCREENSHOTS=1 to refresh the README screenshots.');

async function deliver(from: string, fromName: string, subject: string, body: string, opts: { html?: string; attach?: string; id?: string; extra?: string } = {}) {
  const id = opts.id ?? `${Math.random().toString(36).slice(2)}@${from.split('@')[1]}`;
  const head = [
    `From: ${fromName} <${from}>`,
    'To: Sam Owner <admin@example.com>',
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${id}>`,
    `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${from.split('@')[1]}; dmarc=pass header.from=${from.split('@')[1]}; spf=pass smtp.mailfrom=${from}`,
    ...(opts.extra ? [opts.extra] : []),
    'MIME-Version: 1.0',
  ];
  let raw: string;
  if (opts.attach || opts.html) {
    raw = [
      ...head,
      'Content-Type: multipart/mixed; boundary="m"',
      '',
      '--m',
      `Content-Type: ${opts.html ? 'text/html' : 'text/plain'}; charset=utf-8`,
      '',
      opts.html ?? body,
      ...(opts.attach ? ['--m', `Content-Type: application/pdf; name="${opts.attach}"`, `Content-Disposition: attachment; filename="${opts.attach}"`, 'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQKJcfsj6IK'] : []),
      '--m--',
      '',
    ].join('\n');
  } else raw = [...head, 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\n');
  await fetch(`${APP}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=admin@example.com`, { method: 'POST', body: raw.replace(/\r?\n/g, '\r\n') });
}

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('#email').fill('admin@example.com');
  await page.locator('#password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Mail traffic')).toBeVisible();
}

test('README screenshots', async ({ page }) => {
  test.setTimeout(180_000);
  await deliver('nora@northwind.test', 'Nora Patel', 'Contract renewal for 2027', 'Hi Sam,\n\nAttached is the renewal draft. The main change is the support tier.\n\nCould you review by Friday?\n\nThanks,\nNora', { attach: 'Renewal-2027.pdf' });
  await deliver('github@notifications.test', 'GitHub', '[MurphyInbox] Release v1.1.0 published', 'A new release is available: v1.1.0, with Windows, macOS and Android apps.');
  await deliver('alex@studio.test', 'Alex Rivera', 'Design review notes', 'Loved the new inbox layout. Two small things on the composer spacing; details inside.');
  await deliver('billing@cloud.test', 'Cloud Billing', 'Your October invoice', 'Your invoice for October is ready. Total: 0.00 USD (free plan).');
  await deliver(
    'hello@weekly.test',
    'The Weekly Dev',
    'Edge databases, Rust in the browser, and more',
    '',
    {
      html: '<table width="600" style="font-family:Arial"><tr><td style="padding:24px"><h1 style="color:#4338ca">The Weekly Dev #42</h1><p>Edge databases are having a moment. Here is what changed this week, and what it means for your apps.</p><h2>Rust in the browser</h2><p>The WebAssembly component model lands in more runtimes.</p><p><a href="https://weekly.test">Read online</a></p></td></tr></table>',
      extra: 'List-Unsubscribe: <https://weekly.test/unsubscribe>\nList-Unsubscribe-Post: List-Unsubscribe=One-Click',
    },
  );
  await deliver('maya@acme.test', 'Maya Chen', 'Team offsite in December', 'Hi all,\n\nWe are planning the offsite for the second week of December. Please vote for the location by Wednesday.\n\nMaya');

  const shot = (name: string) => page.screenshot({ path: `assets/screens/${name}.png` });
  const theme = (t: 'light' | 'dark' | 'system') => page.evaluate((v) => localStorage.setItem('oi.theme', JSON.stringify(v)), t);
  await login(page);

  // Mail, light: a thread with an attachment open beside the list.
  await page.goto('/mail/all/inbox');
  await page.getByText('Contract renewal for 2027').click();
  await page.waitForTimeout(1200);
  await shot('mail-light');

  // Composer and command palette.
  await page.goto('/mail/all/inbox?compose=nora@northwind.test');
  await page.waitForTimeout(1200);
  await page.getByLabel('Subject').fill('Re: Contract renewal for 2027');
  await page.locator('[contenteditable="true"]').first().click();
  await page.keyboard.type('Thanks Nora, the new support tier looks right. Signed copy attached by Friday.');
  await page.waitForTimeout(400);
  await shot('mail-composer');
  await page.goto('/mail/all/inbox');
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /Jump to/ }).click();
  await page.getByPlaceholder('Type a command or search…').fill('offsite');
  await page.waitForTimeout(800);
  await shot('mail-command-palette');

  // Admin.
  await page.goto('/admin');
  await page.waitForTimeout(1500);
  await shot('admin-overview-light');
  for (const [path, name] of [['/admin/users', 'admin-users'], ['/admin/domains', 'admin-domains'], ['/admin/integrations', 'admin-integrations']]) {
    await page.goto(path);
    await page.waitForTimeout(1200);
    await shot(name);
  }

  // Settings: theme, accent color and per-device notifications.
  await page.context().grantPermissions(['notifications']);
  await page.goto('/settings/appearance');
  await page.waitForTimeout(1000);
  await page.getByRole('radio', { name: 'Teal' }).click();
  await page.waitForTimeout(400);
  await shot('settings-appearance');
  await page.getByRole('radio', { name: 'Murphy Blue' }).click();

  // Dark mode.
  await theme('dark');
  await page.goto('/mail/all/inbox');
  await page.waitForTimeout(800);
  await page.getByText('Edge databases, Rust in the browser').click();
  await page.waitForTimeout(1200);
  await shot('mail-dark');
  await page.goto('/admin');
  await page.waitForTimeout(1500);
  await shot('admin-overview-dark');
  await page.goto('/admin/mailflow');
  await page.waitForTimeout(1200);
  await shot('admin-mail-flow-dark');

  // Phone (the installable app).
  await theme('light');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/mail/all/inbox');
  await page.waitForTimeout(1200);
  await shot('mobile-inbox');
  await page.getByText('Contract renewal for 2027').click();
  await page.waitForTimeout(1200);
  await shot('mobile-thread');
  await theme('system');
});
