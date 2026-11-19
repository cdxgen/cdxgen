// Stand-in executables for tests that check whether cdxgen starts a tool.
//
// A stand-in appends its arguments to a marker file and exits. On Windows it
// is a .cmd script, which cmd.exe finds through PATHEXT, so it only stands in
// for tools that cdxgen spawns with `shell: true` there (mvn, dotnet, pod,
// cargo, and swift in pregen). Call sites that spawn without a shell (poetry,
// pdm, lein, and swift during BOM generation and evidence) need a real
// executable on Windows, so their tests run on POSIX hosts only.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

export const isWin = process.platform === "win32";

/**
 * Write a stand-in for `name` into `binDir`.
 *
 * @param {string} binDir Directory to put first on PATH
 * @param {string} name Tool name without extension
 * @param {string} marker File each run appends its arguments to
 * @param {Object} [opts]
 * @param {number} [opts.exitCode] Exit status of the stand-in (default 1)
 * @param {string} [opts.stdout] Text the stand-in prints
 * @returns {string} Path of the stand-in
 */
export function writeStandInTool(binDir, name, marker, opts = {}) {
  const exitCode = opts.exitCode ?? 1;
  if (isWin) {
    const tool = join(binDir, `${name}.cmd`);
    const lines = ["@echo off", `echo %* >> "${marker}"`];
    if (opts.stdout !== undefined) {
      lines.push(`echo ${opts.stdout}`);
    }
    lines.push(`exit /b ${exitCode}`, "");
    writeFileSync(tool, lines.join("\r\n"));
    return tool;
  }
  const tool = join(binDir, name);
  const lines = ["#!/bin/sh", `printf '%s\\n' "$*" >> ${JSON.stringify(marker)}`];
  if (opts.stdout !== undefined) {
    lines.push(`printf '%s\\n' ${JSON.stringify(opts.stdout)}`);
  }
  lines.push(`exit ${exitCode}`, "");
  writeFileSync(tool, lines.join("\n"));
  chmodSync(tool, 0o755);
  return tool;
}

/**
 * The argument lines a stand-in recorded, or an empty list when it never ran.
 *
 * @param {string} marker Marker file of the stand-in
 * @returns {string[]} One entry per run
 */
export function standInRuns(marker) {
  try {
    return readFileSync(marker, "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (_err) {
    return [];
  }
}
