// Renders the native app icons (desktop/ and android/) from the logo in src/web/public/favicon.svg.
// Uses Playwright's Chromium (a dev dependency): `npx playwright install chromium` first.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const logo = readFileSync(root('src/web/public/favicon.svg'), 'utf8');
// The envelope alone, for monochrome icons (macOS menu bar, Android status bar).
const glyph = (color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 12 40 40"><rect x="15" y="20" width="34" height="24" rx="4.5" fill="none" stroke="${color}" stroke-width="3.6"/><path d="M16.5 22.5 32 34l15.5-11.5" fill="none" stroke="${color}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const sized = (svg) => svg.replace('<svg ', '<svg width="100%" height="100%" ');

const browser = await chromium.launch();
async function render(out, size, svg, inset = 0) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const pad = Math.round(size * inset);
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><div style="box-sizing:border-box;width:${size}px;height:${size}px;padding:${pad}px">${sized(svg)}</div></body></html>`,
  );
  mkdirSync(dirname(root(out)), { recursive: true });
  await page.screenshot({ path: root(out), omitBackground: true });
  await page.close();
  console.log(out);
}

// Desktop. macOS icons sit on Apple's grid: the shape is ~80% of the canvas.
await render('desktop/build/icon.png', 1024, logo, 0.1);
await render('desktop/build/tray.png', 32, logo);
await render('desktop/build/trayTemplate.png', 16, glyph('#000'));
await render('desktop/build/trayTemplate@2x.png', 32, glyph('#000'));

// Android launcher icons (legacy square + round use the same art) and the notification icon.
const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, px] of Object.entries(densities)) {
  await render(`android/app/src/main/res/mipmap-${d}/ic_launcher.png`, px, logo, 0.04);
  await render(`android/app/src/main/res/mipmap-${d}/ic_launcher_round.png`, px, logo.replace(/rx="15"/g, 'rx="32"'), 0.04);
  await render(`android/app/src/main/res/drawable-${d}/ic_notification_icon.png`, Math.round(px / 2), glyph('#fff'));
}
await browser.close();
