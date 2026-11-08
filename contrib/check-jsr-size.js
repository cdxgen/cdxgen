#!/usr/bin/env node
// check-jsr-size.js: fail when the JSR package would be too large to publish.
//
// JSR rejects a package version whose unpacked files add up to more than
// 20 MiB, and it only says so at upload time, after the npm package for the
// same tag has already been published. This script asks `deno publish
// --dry-run` which files it would upload, adds up their sizes on disk, and
// fails above a budget set below the registry limit so that growth shows up
// in a pull request instead of during a release.
//
// Usage:
//   node contrib/check-jsr-size.js            // exit 1 when over budget
//   node contrib/check-jsr-size.js --top 20   // also list the 20 largest files
//
// Exit codes:
//   0 - within budget
//   1 - over budget
//   2 - deno is missing or the dry run failed

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const MIB = 1024 * 1024;
// https://jsr.io/docs/troubleshooting#package-too-large
const JSR_LIMIT = 20 * MIB;
const BUDGET = 18 * MIB;

const topArg = process.argv.indexOf("--top");
const topCount =
  topArg > -1 ? Number.parseInt(process.argv[topArg + 1], 10) || 10 : 0;

const result = spawnSync(
  "deno",
  ["publish", "--dry-run", "--allow-dirty", "--no-check"],
  {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 64 * MIB,
  },
);
if (result.error || result.status !== 0) {
  console.error(
    `deno publish --dry-run failed: ${result.error?.message || result.stderr}`,
  );
  process.exit(2);
}

// The dry run lists each file as "   file:///abs/path (12.3KB)" on stderr.
const files = [];
for (const line of `${result.stderr}\n${result.stdout}`.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("file://")) {
    continue;
  }
  const sizeStart = trimmed.lastIndexOf(" (");
  const fileUrl = sizeStart > -1 ? trimmed.slice(0, sizeStart) : trimmed;
  const filePath = fileURLToPath(fileUrl);
  files.push({ filePath, size: statSync(filePath).size });
}
if (!files.length) {
  console.error("deno publish --dry-run listed no files.");
  process.exit(2);
}

const total = files.reduce((sum, f) => sum + f.size, 0);
const mib = (bytes) => `${(bytes / MIB).toFixed(2)} MiB`;
console.log(
  `JSR package: ${files.length} files, ${mib(total)} (budget ${mib(BUDGET)}, registry limit ${mib(JSR_LIMIT)})`,
);
if (topCount > 0 || total > BUDGET) {
  const largest = [...files]
    .sort((a, b) => b.size - a.size)
    .slice(0, topCount || 10);
  for (const { filePath, size } of largest) {
    console.log(
      `  ${mib(size).padStart(10)}  ${path.relative(REPO_ROOT, filePath)}`,
    );
  }
}
if (total > BUDGET) {
  console.error(
    "The JSR package is over budget. Exclude files that JSR users do not need under publish.exclude in deno.json and in jsr.json.",
  );
  process.exit(1);
}
