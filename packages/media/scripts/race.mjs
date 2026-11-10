// One race → everything for X: the 16:9 clip, a card per post, the thread draft. Nothing is published.
//
//   pnpm --filter @maskwars/media race race-0003                 races/race-0003.json → out/race-0003/
//   pnpm --filter @maskwars/media race <record.json> [--out <dir>] [--music <file> | --silent] [--no-clip]
//
// Music: --music, else the file in apps/web/public/audio/, else a silent clip. Needs ffmpeg for the clip.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRace } from "../src/race/make.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// pnpm runs this in the package; paths the person typed are read from where they typed them.
const here = process.env.INIT_CWD ?? process.cwd();
const argv = process.argv.slice(2);
const flag = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const arg = argv.find((a, i) => !a.startsWith("--") && !["--out", "--music"].includes(argv[i - 1] ?? ""));
if (!arg) {
  console.error("usage: race <race-id | record.json> [--out dir] [--music file | --silent] [--no-clip]");
  process.exit(2);
}
const file = /^race-\d{4}$/.test(arg) ? join(root, "races", `${arg}.json`) : isAbsolute(arg) ? arg : resolve(here, arg);
if (!existsSync(file)) {
  console.error(`no race record at ${file}`);
  process.exit(2);
}
const record = JSON.parse(readFileSync(file, "utf8"));
const out = flag("--out") ? resolve(here, flag("--out")) : join(root, "out", record.id ?? "race");
const music = argv.includes("--silent") ? null : flag("--music") ? resolve(here, flag("--music")) : undefined;

const t = Date.now();
let r;
try {
  r = await makeRace(record, { out, music, clip: !argv.includes("--no-clip") });
} catch (e) {
  // A record that does not read, a thread that may not go out, no ffmpeg: say which, not where in the code.
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
console.log(`${r.id} → ${r.out}`);
for (const f of r.files.filter((f) => !f.startsWith("frames/"))) console.log(`  ${f}`);
if (r.clip) {
  const sound = r.clip.audio
    ? `music ${r.clip.music}, ${r.clip.lufs} LUFS`
    : argv.includes("--silent")
      ? "silent, as asked"
      : "silent: no music in apps/web/public/audio/ yet";
  console.log(`  clip: ${r.clip.seconds.toFixed(1)} s, 1920×1080 H.264, ${sound}`);
}
console.log(`done in ${((Date.now() - t) / 1000).toFixed(0)} s`);
