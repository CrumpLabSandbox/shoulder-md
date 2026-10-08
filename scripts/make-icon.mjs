#!/usr/bin/env node
// Builds the Mac app icon from one of the SVGs in build/icons/.
//   node scripts/make-icon.mjs build/icons/a-s-with-conscience.svg
// Writes build/icon.png (1024 px, used in development) and build/icon.icns (used by the
// packaged app). Needs macOS (sips, iconutil) and the dev dependencies (Chromium via Playwright).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const source = process.argv[2];
if (!source) {
  console.error('usage: make-icon.mjs <icon.svg>');
  process.exit(2);
}
const out = path.resolve('build');
const png = path.join(out, 'icon.png');
const iconset = path.join(out, 'icon.iconset');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(
  `<body style="margin:0;background:transparent">${readFileSync(source, 'utf8').replace('<svg ', '<svg width="1024" height="1024" ')}</body>`,
);
await page.screenshot({ path: png, omitBackground: true });
await browser.close();

rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = size * scale;
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
    execFileSync('sips', ['-z', String(px), String(px), png, '--out', path.join(iconset, name)], {
      stdio: 'ignore',
    });
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(out, 'icon.icns')]);
rmSync(iconset, { recursive: true, force: true });
console.log(`Wrote build/icon.png and build/icon.icns from ${source}`);
