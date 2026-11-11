// One round → its film: the real site, replaying the round, shot frame by frame at 1920×1080, 30 frames a second.
//
//   pnpm --filter @maskwars/media film race-0001                    races/race-0001.json → shots/race-0001/film/
//   pnpm --filter @maskwars/media film <id | record.json> [--answers <file>] [--only home,crack] [--out <dir>]
//                                                          [--every <n>] [--base <url>]
//
// The 3D arena at the break and the payout (the home page as it is, and four film cameras on the same scene), the
// league, the winner's page and the round's page. No network is needed: the site replays the round's record. With
// --answers it replays the chain's own answers instead (pnpm --filter @maskwars/arena record --out <file>, with
// MASKWARS_NETWORK set). --every 6 is a rehearsal: every sixth frame to out/<id>/film/frames/, no reels.
// Needs ffmpeg. About 15 minutes on a machine with no GPU.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const here = process.env.INIT_CWD ?? process.cwd();
const argv = process.argv.slice(2);
const VALUE_FLAGS = ["--answers", "--only", "--out", "--every", "--base"];
const flag = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const path = (p) => (isAbsolute(p) ? p : resolve(here, p));
const arg = argv.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(argv[i - 1] ?? ""));
if (!arg) {
  console.error("usage: film <race-0001 | s1-0001-d74851 | record.json> [--answers file] [--only shot,shot] [--out dir] [--every n] [--base url]");
  process.exit(2);
}
const byId = /^(?:race-\d{4}|s\d{1,3}-\d{4}-[0-9a-f]{6})$/.test(arg);
const file = byId ? join(root, "races", `${arg}.json`) : path(arg);
if (!existsSync(file)) {
  console.error(`no race record at ${file}`);
  process.exit(2);
}
const record = JSON.parse(readFileSync(file, "utf8"));
// The site, the arena reader and the film all read one network, named before any of them loads.
process.env.MASKWARS_NETWORK = record.network;
const { filmRound } = await import("../src/film/film.ts");

const t = Date.now();
try {
  const out = flag("--out") ? path(flag("--out")) : join(root, "shots", record.id, "film");
  const m = await filmRound(record, {
    out,
    work: join(root, "out", record.id, "film"),
    answers: flag("--answers") ? path(flag("--answers")) : undefined,
    only: flag("--only")?.split(","),
    every: flag("--every") ? Number(flag("--every")) : undefined,
    base: flag("--base"),
    log: (line) => console.log(line),
  });
  console.log(`${m.round} → ${out}`);
  for (const s of m.shots) console.log(`  ${s.name}.mp4  ${s.frames} frames, ${(s.frames / m.fps).toFixed(1)} s${s.rate === 1 ? "" : `, slow motion ×${s.rate}`}  ${JSON.stringify(s.marks)}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
console.log(`done in ${((Date.now() - t) / 1000).toFixed(0)} s`);
