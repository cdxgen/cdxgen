// Validate every JSON document in a directory with the runtime-compiled
// validator and print {"accepted": [...], "rejected": [...]} (file names).
// Spawned as a script file rather than with `-e`: Deno runs `-e` code as a
// classic script, where import statements are a syntax error, and resolves
// npm imports only for an entry point inside the project.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { validateBom } from "../lib/validator/bomValidator.js";

const [dir, prefix = ""] = process.argv.slice(2);
const accepted = [];
const rejected = [];
for (const name of readdirSync(dir).sort()) {
  if (!name.startsWith(prefix) || !name.endsWith(".json")) {
    continue;
  }
  const bom = JSON.parse(readFileSync(join(dir, name), "utf-8"));
  ((await validateBom(bom, { deep: false })) ? accepted : rejected).push(name);
}
console.log(JSON.stringify({ accepted, rejected }));
