// The demo film: one story in 71 s, 1920×1080, no voice. A person forges a mask, it lines up for the daily round, the
// round runs by itself, a mask breaks the vault and the contract pays, forge yours. Every picture is the live site and
// every number is the round's own, read from the site's API into one file.
//
//   pnpm --filter @maskwars/media demo race-0004
//
// That one command films everything again for that round (its page, the league, the mask, the forge, the home page),
// renders the film to out/promo/maskwars-demo.mp4 and lays a contact sheet beside it. About 12 minutes on a machine
// with no GPU: 8 of filming, 3 of render.
//
//   node scripts/demo.mjs <round> [--mask dmytro] [--site https://maskwars.xyz] [--draft] [--no-capture]
//                                 [--take data,stills,forge,home] [--gpu] [--out out/promo/maskwars-demo.mp4]
//
// --draft       960×540 to out/promo/maskwars-demo-draft.mp4, to look at the cut before the full render.
// --no-capture  render from what out/demo/<round>/ already holds.
// --take        film only these parts again and keep the rest: `--take data,stills` after a round ends re-reads its
//               numbers and its pages and keeps the forge and the home page reels.
// --gpu         draw the home page's 3D arena with the machine's graphics card: the same pixels, faster.
//
// The words come from src/demo/plan.ts `story()`: they follow the round's data (who won, in how long, what it took,
// whether the person's mask was in it, or that the vault held), so nothing is typed in by hand for a round.
// Footage and data.json land in out/demo/<round>/. Needs ffmpeg.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finish } from "../src/clip/render.ts";
import { capture, PARTS } from "../src/demo/capture.ts";
import { DEMO, DURATION, MUSIC_CUT, story } from "../src/demo/plan.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const VALUE_FLAGS = ["--mask", "--site", "--take", "--out", "--music"];
const flag = (name, d) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : d);
const [id] = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(argv[i - 1] ?? ""));
if (!id) {
  console.error("usage: demo <round, e.g. race-0004> [--mask dmytro] [--draft] [--no-capture] [--take data,stills,forge,home] [--gpu]");
  process.exit(2);
}
const draft = argv.includes("--draft");
const mask = flag("--mask", "dmytro").toLowerCase();
const site = flag("--site", "https://maskwars.xyz").replace(/\/$/, "");
const music = resolve(root, flag("--music", "audio/promo-150.mp3"));
const out = resolve(root, flag("--out", draft ? "out/promo/maskwars-demo-draft.mp4" : "out/promo/maskwars-demo.mp4"));
const dir = join(root, "out/demo", id);
const take = argv.includes("--no-capture") ? [] : flag("--take", PARTS.join(",")).split(",").filter(Boolean);
const unknown = take.filter((p) => !PARTS.includes(p));
if (unknown.length) {
  console.error(`--take: no such part: ${unknown.join(", ")} (there are ${PARTS.join(", ")})`);
  process.exit(2);
}
if (!existsSync(music)) {
  console.error(`no music at ${music}`);
  process.exit(2);
}

const HOME_SECONDS = 6;
const data = take.length
  ? await capture({ id, mask, site, dir, parts: take, gpu: argv.includes("--gpu"), homeSeconds: HOME_SECONDS, log: (l) => console.log(l) })
  : JSON.parse(readFileSync(join(dir, "data.json"), "utf8"));
const told = story(data);
if (told.outcome === "open") console.warn(`round ${id} is still on (${data.race.phase}): the film says so. Render it again once the round has ended.`);
console.log(`round ${told.roundNo}: ${told.result.head}${told.result.sub ? `, ${told.result.sub}` : ""} · ${told.after.map((a) => a.head).join(" · ")} · ${told.league.head} ${told.top.head}`);

const FOOTAGE = ["home.mp4", "forge.mp4", "race.jpg", "league.jpg", "mask.jpg", "near.jpg", "near-open.jpg", "connect.jpg", "home.jpg"];
const missing = FOOTAGE.filter((f) => !existsSync(join(dir, f)));
if (missing.length) {
  console.error(`footage missing in ${dir}: ${missing.join(", ")}`);
  process.exit(2);
}

const pub = mkdtempSync(join(tmpdir(), "maskwars-demo-"));
try {
  mkdirSync(join(pub, "fonts"));
  mkdirSync(join(pub, "demo"));
  copyFileSync(require.resolve("@fontsource-variable/hubot-sans/files/hubot-sans-latin-standard-normal.woff2"), join(pub, "fonts/hubot-sans.woff2"));
  copyFileSync(require.resolve("@fontsource-variable/mona-sans/files/mona-sans-latin-standard-normal.woff2"), join(pub, "fonts/mona-sans.woff2"));
  for (const f of FOOTAGE) copyFileSync(join(dir, f), join(pub, "demo", f));
  // The track as the film cuts it: the pieces end to end, a hundredth of a second of crossfade at each join.
  const pieces = MUSIC_CUT.map(([a, b], i) => `[0:a]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=N/SR/TB[p${i}]`);
  const joins = MUSIC_CUT.slice(1).map((_, i) => `[${i === 0 ? "p0" : `j${i - 1}`}][p${i + 1}]acrossfade=d=0.01:c1=tri:c2=tri[j${i}]`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", music, "-filter_complex", [...pieces, ...joins].join(";"), "-map", `[j${MUSIC_CUT.length - 2}]`, "-ar", "48000", join(pub, "music.wav")]);

  const inputProps = { data, music: "music.wav" };
  const { bundle } = await import("@remotion/bundler");
  const { selectComposition, renderMedia } = await import("@remotion/renderer");
  const serveUrl = await bundle({ entryPoint: join(root, "src/clip/Root.tsx"), publicDir: pub });
  const composition = await selectComposition({ serveUrl, id: DEMO.id, inputProps });
  mkdirSync(dirname(out), { recursive: true });
  const raw = `${out}.raw.mp4`;
  let last = -1;
  await renderMedia({
    serveUrl,
    composition,
    inputProps,
    codec: "h264",
    crf: draft ? 23 : 16,
    scale: draft ? 0.5 : 1,
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
  const seconds = DURATION / DEMO.fps;
  console.log(`${out} (${seconds.toFixed(2)} s, ${r.lufs ?? "no"} LUFS)`);

  // The contact sheet: a frame every three seconds from the first second, six across in the film's order, for eyes
  // before anything is posted. From 1 s, three seconds apart, a frame never falls on a beat: none is a cut's flash.
  const sheet = out.replace(/\.mp4$/, "-sheet.jpg");
  const every = 3 * DEMO.fps;
  const cells = Math.ceil((DURATION - DEMO.fps) / every);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", out, "-vf", `select='not(mod(n-${DEMO.fps}\\,${every}))',scale=640:360,tile=6x${Math.ceil(cells / 6)}:color=0x06050c`, "-fps_mode", "vfr", "-frames:v", "1", "-q:v", "2", sheet]);
  console.log(sheet);
} finally {
  rmSync(pub, { recursive: true, force: true });
}
