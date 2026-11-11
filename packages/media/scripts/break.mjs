// One round → THE BREAK: the wordless 15 s clip, 1920×1080, cut on the beat of its music.
//
//   pnpm --filter @maskwars/media break race-0001                 → out/race-0001/break/break.mp4, break-sheet.jpg
//   pnpm --filter @maskwars/media break <id | record.json> [--out <dir>] [--keep] [--bpm <n>] [--music <file>]
//
// It is cut from the round's film (shots/<id>/film/, made by `film`) and from the generated clips in
// shots/<id>/slots/ (crack.mp4, eye.mp4, hero.mp4, flow.mp4): a slot's file takes its shot, and a shot with no file
// plays the footage filmed off the site. Music: the first packages/media/audio/break-*.mp3 and the tempo in the .json
// beside it, else the track of the round's first clip. --music and --bpm name a track and its tempo by hand.
// --keep also copies the clip and the sheet to shots/<id>/break/, where the finished ones are kept.
// Needs ffmpeg. About three minutes.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderBreak } from "../src/break/render.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const here = process.env.INIT_CWD ?? process.cwd();
const argv = process.argv.slice(2);
const VALUE_FLAGS = ["--out", "--bpm", "--music"];
const flag = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const path = (p) => (isAbsolute(p) ? p : resolve(here, p));
const arg = argv.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(argv[i - 1] ?? ""));
if (!arg) {
  console.error("usage: break <race-0001 | s1-0001-d74851 | record.json> [--out dir] [--keep] [--bpm n] [--music file]");
  process.exit(2);
}
const byId = /^(?:race-\d{4}|s\d{1,3}-\d{4}-[0-9a-f]{6})$/.test(arg);
const file = byId ? join(root, "races", `${arg}.json`) : path(arg);
if (!existsSync(file)) {
  console.error(`no race record at ${file}`);
  process.exit(2);
}
const record = JSON.parse(readFileSync(file, "utf8"));
const shots = join(root, "shots", record.id);
const out = flag("--out") ? path(flag("--out")) : join(root, "out", record.id, "break");
const track = flag("--music") ? { file: path(flag("--music")), from: 0, tempo: { bpm: Number(flag("--bpm") ?? 120), offset: 0 }, about: `${flag("--music")}, ${flag("--bpm") ?? 120} BPM as given` } : undefined;

const t = Date.now();
try {
  const r = await renderBreak(record, { shots, out, track, log: (line) => console.log(line) });
  if (flag("--bpm") && !track) console.error("--bpm is read with --music only: the tempo of a track in audio/ is in the json beside it");
  console.log(`${record.id} → ${r.video}`);
  console.log(`  ${r.seconds.toFixed(1)} s, 1920×1080 H.264, ${r.lufs} LUFS, ${r.plan.tempo.bpm} BPM, cuts at ${r.plan.cuts.map((c) => (c / 30).toFixed(2)).join(", ")} s`);
  console.log(`  ${r.sheet}`);
  if (argv.includes("--keep")) {
    const kept = join(shots, "break");
    mkdirSync(kept, { recursive: true });
    copyFileSync(r.video, join(kept, "break.mp4"));
    copyFileSync(r.sheet, join(kept, "break-sheet.jpg"));
    console.log(`  kept in ${kept}`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
console.log(`done in ${((Date.now() - t) / 1000).toFixed(0)} s`);
