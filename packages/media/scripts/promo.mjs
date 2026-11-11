// The long film: what MASK WARS is, a round on mainnet step by step, what changed since the first, what comes next.
// 150 s, 1920×1080, cut on the bars of its own track (src/promo/plan.ts).
//
//   node scripts/promo.mjs [--today race-0002] [--first race-0001] [--music audio/promo-150.mp3] [--out out/promo/promo.mp4]
//                          [--stills 0,30,52.5,98,140]
//
// Footage: the live site filmed in its real minute (shots/<today>/live/, scripts/live.mjs), the 3D arena filmed off
// the site replaying the round (shots/<today>/film/, scripts/film.mjs) and pages of the site (shots/promo-1111/site/).
// --stills renders those seconds as JPEG beside the film, for eyes, and skips the film when given alone with --no-video.
// Needs ffmpeg.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finish } from "../src/clip/render.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(root, "../..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const flag = (name, d) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : d;
};
const today = flag("--today", "race-0002");
const first = flag("--first", "race-0001");
const music = resolve(root, flag("--music", "audio/promo-150.mp3"));
const out = resolve(root, flag("--out", "out/promo/promo.mp4"));
const stills = (flag("--stills", "") || "").split(",").filter(Boolean).map(Number);
const video = !argv.includes("--no-video");

const live = join(root, "shots", today, "live");
// --film names another round's reels, for a look at the cut before today's are filmed; never for the film that goes out.
const film = flag("--film", null) ? resolve(flag("--film")) : join(root, "shots", today, "film");
const site = join(root, "shots", "promo-1111", "site");
const FOOTAGE = {
  "race-page": join(live, "race-page-1.mp4"),
  "home-break": join(live, "home-racing-1.mp4"),
  "home-countdown": join(live, "home-countdown.mp4"),
  "home-zero": join(live, "home-zero.mp4"),
  "film-crack": join(film, "crack.mp4"),
  "film-eye": join(film, "eye.mp4"),
  "film-hero": join(film, "hero.mp4"),
  "film-flow": join(film, "flow.mp4"),
  "film-home": join(film, "home.mp4"),
  "site-agents": join(site, "agents.mp4"),
  "site-check": join(site, "check.mp4"),
  "site-wallet": join(site, "wallet.mp4"),
  "site-league": join(site, "league.mp4"),
};
const missing = Object.entries(FOOTAGE).filter(([, f]) => !existsSync(f));
if (missing.length) {
  console.error(`footage missing: ${missing.map(([n, f]) => `${n} (${f})`).join(", ")}`);
  process.exit(2);
}
if (video && !existsSync(music)) {
  console.error(`no music at ${music}`);
  process.exit(2);
}

const pub = mkdtempSync(join(tmpdir(), "maskwars-promo-"));
try {
  mkdirSync(join(pub, "art"));
  mkdirSync(join(pub, "fonts"));
  mkdirSync(join(pub, "footage"));
  for (const f of readdirSync(join(REPO, "brand/art/web")).filter((f) => f.endsWith(".jpg"))) copyFileSync(join(REPO, "brand/art/web", f), join(pub, "art", f));
  copyFileSync(require.resolve("@fontsource-variable/hubot-sans/files/hubot-sans-latin-standard-normal.woff2"), join(pub, "fonts/hubot-sans.woff2"));
  copyFileSync(require.resolve("@fontsource-variable/mona-sans/files/mona-sans-latin-standard-normal.woff2"), join(pub, "fonts/mona-sans.woff2"));
  for (const [name, file] of Object.entries(FOOTAGE)) copyFileSync(file, join(pub, "footage", `${name}.mp4`));
  let musicName = null;
  if (existsSync(music)) {
    musicName = `music${extname(music).toLowerCase()}`;
    copyFileSync(music, join(pub, musicName));
  }

  const record = (id) => JSON.parse(readFileSync(join(root, "races", `${id}.json`), "utf8"));
  const inputProps = { today: record(today), first: record(first), music: musicName };
  const { bundle } = await import("@remotion/bundler");
  const { selectComposition, renderMedia, renderStill } = await import("@remotion/renderer");
  const serveUrl = await bundle({ entryPoint: join(root, "src/clip/Root.tsx"), publicDir: pub });
  const composition = await selectComposition({ serveUrl, id: "Promo", inputProps });
  mkdirSync(dirname(out), { recursive: true });
  for (const s of stills) {
    const file = join(dirname(out), `still-${String(s).replace(".", "_")}.jpg`);
    await renderStill({ serveUrl, composition, inputProps, frame: Math.min(composition.durationInFrames - 1, Math.round(s * composition.fps)), output: file, imageFormat: "jpeg", jpegQuality: 88 });
    console.log(file);
  }
  if (video) {
    const raw = `${out}.raw.mp4`;
    let last = -1;
    await renderMedia({
      serveUrl,
      composition,
      inputProps,
      codec: "h264",
      crf: 16,
      outputLocation: raw,
      onProgress: ({ progress }) => {
        const p = Math.floor(progress * 10);
        if (p !== last) {
          last = p;
          console.log(`render ${p * 10}%`);
        }
      },
    });
    const r = finish(raw, out);
    rmSync(raw, { force: true });
    console.log(`${out} (${(composition.durationInFrames / composition.fps).toFixed(1)} s, ${r.lufs ?? "no"} LUFS)`);
  }
} finally {
  rmSync(pub, { recursive: true, force: true });
}
