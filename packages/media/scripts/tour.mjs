// The tour: everything MASK WARS does and how to use each thing, 2:30, 1920×1080, no voice. Ten chapters, each a card
// and then the real page being used, with one line under it for each step. Every picture is the live site filmed
// now, and every number in the words was read off its pages and its API while it was filmed.
//
//   pnpm --filter @maskwars/media tour race-0004 --gpu                # films every page again and renders the film
//   pnpm --filter @maskwars/media tour race-0004 --gpu --take round   # only what a new round changes: its page, the league
//
// With no round named it is the latest round that has ended (the site's /api/races). The film lands in
// out/promo/maskwars-tour.mp4 with a contact sheet beside it (a frame every three seconds); the footage and
// data.json in out/tour/.
//
//   node scripts/tour.mjs [round] [--mask dmytro] [--site https://maskwars.xyz] [--draft] [--no-capture] [--no-render]
//                         [--take round|data,home,watch,race,forge,mask,copy,league,jobs,near,swap,check,market,connect,github]
//                         [--gpu] [--out out/promo/maskwars-tour.mp4] [--music audio/promo-150.mp3] [--stills 3,33.5,140]
//
// --draft       960×540 to out/promo/maskwars-tour-draft.mp4, to look at the cut before the full render.
// --no-capture  render from what out/tour/ already holds.
// --no-render   film only.
// --take        film only these parts again and keep the rest. `round` is data, race and league.
// --stills      those seconds of the film as JPEG in out/promo/tour-stills/, and no film: to look at a card or a line.
// --gpu         draw with the machine's graphics card: the same pixels, about five times faster with the 3D arena.
//
// The film presses pickers, tabs, a sheet that opens and its Close, and nothing else (src/tour/plan.ts `mayPress`):
// no wallet is connected and nothing is signed, sent, hired or posted. About 15 minutes with --gpu: 10 of filming,
// 5 of render. Needs ffmpeg.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finish } from "../src/clip/render.ts";
import { capture, PARTS, ROUND_PARTS } from "../src/tour/capture.ts";
import { CHAPTERS, cut, DURATION, TOUR } from "../src/tour/plan.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const VALUE_FLAGS = ["--mask", "--site", "--take", "--out", "--music", "--stills"];
const flag = (name, d) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : d);
const [round = null] = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(argv[i - 1] ?? ""));
const draft = argv.includes("--draft");
const mask = flag("--mask", "dmytro").toLowerCase();
const site = flag("--site", "https://maskwars.xyz").replace(/\/$/, "");
const music = resolve(root, flag("--music", "audio/promo-150.mp3"));
const out = resolve(root, flag("--out", draft ? "out/promo/maskwars-tour-draft.mp4" : "out/promo/maskwars-tour.mp4"));
const dir = join(root, "out/tour");
const stills = flag("--stills", "").split(",").filter(Boolean).map(Number);
const take = argv.includes("--no-capture") ? [] : [...new Set(flag("--take", PARTS.join(",")).split(",").filter(Boolean).flatMap((p) => (p === "round" ? ROUND_PARTS : [p])))];
const unknown = take.filter((p) => !PARTS.includes(p));
if (unknown.length) {
  console.error(`--take: no such part: ${unknown.join(", ")} (there are round, ${PARTS.join(", ")})`);
  process.exit(2);
}
if (!existsSync(music)) {
  console.error(`no music at ${music}`);
  process.exit(2);
}

const data = take.length ? await capture({ round, mask, site, dir, parts: take, gpu: argv.includes("--gpu"), log: (l) => console.log(l) }) : JSON.parse(readFileSync(join(dir, "data.json"), "utf8"));
if (round && data.round !== round) {
  console.error(`out/tour holds round ${data.round}: film ${round} first (--take round)`);
  process.exit(2);
}
const parts = cut(data);
if (data.race.phase !== "broken" && data.race.phase !== "held") console.warn(`round ${data.round} is still on (${data.race.phase}): the film says so. Film it again once the round has ended (--take round).`);
for (const ch of CHAPTERS) {
  const said = parts.filter((p) => p.kind === "reel" && p.no === ch.no).flatMap((p) => p.lines.map((l) => l.head));
  console.log(`${String(ch.no).padStart(2, "0")} ${ch.tag}: ${said.join(" · ")}`);
}
if (argv.includes("--no-render")) process.exit(0);

const REELS = [...new Set(parts.filter((p) => p.kind === "reel").map((p) => p.reel))];
const missing = ["home", ...REELS].filter((f) => !existsSync(join(dir, `${f}.mp4`)));
if (missing.length) {
  console.error(`footage missing in ${dir}: ${missing.join(", ")}`);
  process.exit(2);
}

/** The stills were asked for and are made: there is no film to render. */
class Stills extends Error {}
const pub = mkdtempSync(join(tmpdir(), "maskwars-tour-"));
try {
  mkdirSync(join(pub, "fonts"));
  mkdirSync(join(pub, "tour"));
  copyFileSync(require.resolve("@fontsource-variable/hubot-sans/files/hubot-sans-latin-standard-normal.woff2"), join(pub, "fonts/hubot-sans.woff2"));
  copyFileSync(require.resolve("@fontsource-variable/mona-sans/files/mona-sans-latin-standard-normal.woff2"), join(pub, "fonts/mona-sans.woff2"));
  for (const f of ["home", ...REELS]) copyFileSync(join(dir, `${f}.mp4`), join(pub, "tour", `${f}.mp4`));
  // A chapter's card stands over the first frame of its first reel.
  for (const p of parts) if (p.kind === "card") execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(dir, `${p.poster}.mp4`), "-frames:v", "1", "-q:v", "3", join(pub, "tour", `${p.poster}.jpg`)]);
  // The track whole, as it is: the film is as long as the track.
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", music, "-ar", "48000", join(pub, "music.wav")]);

  const inputProps = { data, music: "music.wav" };
  const { bundle } = await import("@remotion/bundler");
  const { selectComposition, renderMedia, renderStill } = await import("@remotion/renderer");
  const serveUrl = await bundle({ entryPoint: join(root, "src/clip/Root.tsx"), publicDir: pub });
  const composition = await selectComposition({ serveUrl, id: TOUR.id, inputProps });
  mkdirSync(dirname(out), { recursive: true });
  if (stills.length) mkdirSync(join(dirname(out), "tour-stills"), { recursive: true });
  for (const s of stills) {
    const output = join(dirname(out), "tour-stills", `${s.toFixed(2).padStart(6, "0")}.jpg`);
    await renderStill({ serveUrl, composition, inputProps, frame: Math.min(DURATION - 1, Math.round(s * TOUR.fps)), imageFormat: "jpeg", jpegQuality: 92, output });
    console.log(output);
  }
  if (stills.length) throw new Stills();
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
  console.log(`${out} (${(DURATION / TOUR.fps).toFixed(2)} s, ${r.lufs ?? "no"} LUFS)`);

  // The contact sheet: a frame every three seconds from the first second, six across in the film's order, for eyes
  // before anything is posted.
  const sheet = out.replace(/\.mp4$/, "-sheet.jpg");
  const every = 3 * TOUR.fps;
  const cells = Math.ceil((DURATION - TOUR.fps) / every);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", out, "-vf", `select='not(mod(n-${TOUR.fps}\\,${every}))',scale=640:360,tile=6x${Math.ceil(cells / 6)}:color=0x06050c`, "-fps_mode", "vfr", "-frames:v", "1", "-q:v", "2", sheet]);
  console.log(sheet);
} catch (e) {
  if (!(e instanceof Stills)) throw e;
} finally {
  rmSync(pub, { recursive: true, force: true });
}
