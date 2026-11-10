// Builds the sandbox runner and the training targets: `pnpm --filter @maskwars/race build:runner`.
import { buildRunner } from "../src/build.ts";

await buildRunner({ log: (line) => console.log(line) });
console.log("runner ready");
