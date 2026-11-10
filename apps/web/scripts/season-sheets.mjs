// Before and after, side by side: three sheets per state of the round, from two runs of season-shots.mjs.
//   <state>-home-desk    the home page on desk 1440: the 3D arena, and the flat first frame
//   <state>-home-phones  the same on phone 375 and small phone 360×640
//   <state>-pages        the race page and a mask's page, desk and phone
// Usage: node apps/web/scripts/season-sheets.mjs <before dir> <after dir> [out dir]
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES } from './season-scenes.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const [BEFORE, AFTER, OUT = join(here, '..', 'shots', 'season')] = process.argv.slice(2);
if (!BEFORE || !AFTER) throw new Error('usage: season-sheets.mjs <before dir> <after dir> [out dir]');
mkdirSync(OUT, { recursive: true });

const uri = (dir, file) => (existsSync(join(dir, file)) ? `data:image/jpeg;base64,${readFileSync(join(dir, file)).toString('base64')}` : null);
/** A picture before and the same picture after, each under its label. */
const pair = (label, file, width) => [
  { label: `Before · ${label}`, src: uri(BEFORE, file), tone: 'before', width },
  { label: `After · ${label}`, src: uri(AFTER, file), tone: 'after', width },
];

/** One sheet: a title and rows of pictures. */
function sheet(title, rows) {
  const row = (cells) =>
    `<div class="row">${cells
      .map(({ label, src, tone, width }) => `<figure><figcaption class="${tone}">${label}</figcaption>${src ? `<img src="${src}" style="width:${width}px">` : `<div class="none" style="width:${width}px">not shot</div>`}</figure>`)
      .join('')}</div>`;
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:20px 20px 24px;background:#06050c;color:#eef1ff;font:600 15px system-ui,sans-serif;width:max-content}
    h1{margin:0 0 14px;font:800 20px system-ui,sans-serif;letter-spacing:.02em}
    .row{display:flex;gap:14px;margin-top:16px}
    figure{margin:0}figcaption{margin:0 0 6px;font-size:13px;letter-spacing:.08em;text-transform:uppercase}
    .before{color:rgba(238,241,255,.62)}.after{color:#00ec97}
    img{display:block;border:1px solid rgba(238,241,255,.1)}.none{display:grid;place-items:center;height:120px;border:1px dashed rgba(238,241,255,.2)}
  </style><h1>${title}</h1>${rows.map(row).join('')}`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function write(name, html) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.locator('body').screenshot({ path: join(OUT, `${name}.jpg`), type: 'jpeg', quality: 80 });
  console.log(`${name}.jpg`);
}

for (const s of SCENES) {
  const n = s.name;
  const title = `${n[0]}. ${s.title}`;
  await write(`${n}-home-desk`, sheet(`${title} · home, desk 1440`, [pair('3D arena', `${n}-home-3d-desk.jpg`, 720), pair('first frame, and all there is without WebGL', `${n}-home-flat-desk.jpg`, 720)]));
  await write(
    `${n}-home-phones`,
    sheet(`${title} · home, phone 375 and small phone 360×640`, [
      [...pair('3D, 375', `${n}-home-3d-phone.jpg`, 320), ...pair('first frame, 375', `${n}-home-flat-phone.jpg`, 320)],
      [...pair('3D, 360×640', `${n}-home-3d-small.jpg`, 320), ...pair('first frame, 360×640', `${n}-home-flat-small.jpg`, 320)],
    ]),
  );
  await write(
    `${n}-pages`,
    sheet(`${title} · the race and a mask`, [
      pair('race, desk', `${n}-race-desk.jpg`, 720),
      pair('mask, desk', `${n}-mask-desk.jpg`, 720),
      [...pair('race, phone', `${n}-race-phone.jpg`, 320), ...pair('mask, phone', `${n}-mask-phone.jpg`, 320)],
    ]),
  );
}
await browser.close();
