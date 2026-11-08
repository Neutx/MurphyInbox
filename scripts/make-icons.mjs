// Renders the app icon (src/web/public/favicon.svg) to the PNG sizes the web app manifest needs.
// Uses Playwright's Chromium (a dev dependency): `npx playwright install chromium` first.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const svg = readFileSync(new URL('../src/web/public/favicon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  // Maskable icons need a safe zone: draw the mark at 80% on the brand background.
  await page.setContent(`<html><body style="margin:0;background:#1665c1;display:grid;place-items:center;height:100vh">
    <div style="width:${Math.round(size * 0.8)}px;height:${Math.round(size * 0.8)}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`);
  await page.screenshot({ path: fileURLToPath(new URL(`../src/web/public/icon-${size}.png`, import.meta.url)) });
  await page.close();
  console.log(`icon-${size}.png`);
}
// Apple touch icon: full-bleed (iOS rounds the corners itself).
{
  const page = await browser.newPage({ viewport: { width: 180, height: 180 } });
  await page.setContent(`<html><body style="margin:0">${svg.replace('<svg ', '<svg width="180" height="180" ').replace(/rx="15"/g, 'rx="0"')}</body></html>`);
  await page.screenshot({ path: fileURLToPath(new URL('../src/web/public/apple-touch-icon.png', import.meta.url)) });
  await page.close();
  console.log('apple-touch-icon.png');
}
await browser.close();
