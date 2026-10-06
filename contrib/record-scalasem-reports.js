#!/usr/bin/env node
// Records the scalasem reports under test/data/scalasem from compiled Scala projects, with the
// machine specific paths replaced so the recordings are the same on every machine.
//
//   node contrib/record-scalasem-reports.js <projects dir> [name...]
//
// Each name is a project directory under <projects dir> and becomes test/data/scalasem/<name>.json.
// Without names, every report already recorded there is recorded again. SCALASEM_CMD picks the
// scalasem script; the installed atom-parsetools one is the default.
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const [projectsArg, ...names] = process.argv.slice(2);
if (!projectsArg) {
  console.error(
    "usage: node contrib/record-scalasem-reports.js <projects dir> [name...]",
  );
  process.exit(2);
}
const projectsDir = resolve(projectsArg);
const outDir = resolve("test", "data", "scalasem");
const scalasem =
  process.env.SCALASEM_CMD ||
  resolve("node_modules", "@appthreat", "atom-parsetools", "scalasem.js");
const recorded = names.length
  ? names
  : readdirSync(outDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));

// Library jars live in a Coursier cache or a local Maven repository; only the part below the
// cache root is kept.
const neutralJarPath = (path) =>
  String(path)
    .replaceAll("\\", "/")
    .replace(/^.*\/v1\/https\//, "~/.cache/coursier/v1/https/")
    .replace(/^.*\/\.m2\/repository\//, "~/.m2/repository/");

const scratch = mkdtempSync(join(tmpdir(), "scalasem-record-"));
try {
  for (const name of recorded) {
    const project = join(projectsDir, name);
    const outFile = join(scratch, `${name}.json`);
    // The form atom runs: no flags, so the build tool supplies the inventory and the compiler.
    execFileSync(process.execPath, [scalasem, project, outFile], {
      stdio: "ignore",
    });
    const report = JSON.parse(readFileSync(outFile, "utf-8"));
    report._meta.projectPath = `/src/${name}`;
    for (const module of report.modules || []) {
      module.classpath = (module.classpath || []).map((entry) => ({
        ...entry,
        path: neutralJarPath(entry.path),
      }));
    }
    const text = JSON.stringify(report);
    for (const local of [projectsDir, project, homedir()]) {
      if (text.includes(local)) {
        throw new Error(`${name}: the report still names ${local}`);
      }
    }
    writeFileSync(join(outDir, `${name}.json`), `${text}\n`);
    console.log(`${name}: ${report._meta.counts?.files ?? 0} files`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
