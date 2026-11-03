/**
 * End-to-end checks for the security gates that keep attacker-controlled
 * build files from executing when the operator opts out of dependency
 * installation.
 *
 * The fixtures under test/data/sec-wrapper-gate mimic a malicious project:
 * their `mvnw`/`gradlew`/`mill` wrappers (and the rush/pipenv shims placed on
 * PATH) do nothing but touch a marker file. Scanning them with
 * --no-install-deps (or --lifecycle pre-build) must never create the marker;
 * scanning with the default settings must, which proves the gate itself is
 * what blocks execution and not a broken fixture.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const cdxgenBin = path.join(repoRoot, "bin", "cdxgen.js");
const fixtureRoot = path.join(repoRoot, "test", "data", "sec-wrapper-gate");
const isWin = process.platform === "win32";

function runCdxgen(args, env = {}) {
  // CI=true turns formulation on by default. These checks are about the
  // payload and the install gates, so formulation is off unless a test asks
  // for it, which keeps the output the same in CI and on a workstation.
  const formulationArgs = args.some((arg) => arg.includes("formulation"))
    ? []
    : ["--no-include-formulation"];
  const result = spawnSync(
    process.execPath,
    [cdxgenBin, ...formulationArgs, ...args],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, ...env },
      timeout: 4 * 60 * 1000,
    },
  );
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

function scanWithGate(fixtureDir, extraArgs, marker) {
  return runCdxgen(
    ["-o", "-", "--no-validate", "--no-banner", ...extraArgs, fixtureDir],
    { CDXGEN_SEC_MARKER: marker },
  );
}

describe("crafted .npmrc degrades gracefully instead of crashing", () => {
  it("a scanned project with prototype-key .npmrc still produces a BOM", () => {
    const marker = path.join(tmpdir(), `cdxgen-sec-unused-${process.pid}`);
    const { status, stdout } = scanWithGate(
      path.join(repoRoot, "test", "data", "sec-npmrc-protocrash"),
      ["-t", "js"],
      marker,
    );
    assert.strictEqual(status, 0);
    assert.ok(stdout.trimEnd().endsWith("}"), "a BOM must still be produced");
  });
});

describe("--no-install-deps blocks project-local build tool execution", () => {
  it("maven wrapper is not executed", () => {
    const marker = path.join(tmpdir(), `cdxgen-sec-mvnw-${process.pid}`);
    try {
      const { status } = scanWithGate(
        path.join(fixtureRoot, "maven"),
        ["-t", "java", "--no-install-deps"],
        marker,
      );
      assert.strictEqual(status, 0);
      assert.strictEqual(
        existsSync(marker),
        false,
        "mvnw from the scanned project must not run with --no-install-deps",
      );
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it("maven wrapper is not executed by the formulation probes", () => {
    const marker = path.join(tmpdir(), `cdxgen-sec-mvnw-form-${process.pid}`);
    const outDir = mkdtempSync(path.join(tmpdir(), "cdxgen-sec-form-"));
    try {
      const bomFile = path.join(outDir, "bom.json");
      const { status } = runCdxgen(
        [
          "-t",
          "java",
          "-o",
          bomFile,
          "--no-validate",
          "--no-banner",
          "--no-install-deps",
          "--include-formulation",
          path.join(fixtureRoot, "maven"),
        ],
        { CDXGEN_SEC_MARKER: marker },
      );
      assert.strictEqual(status, 0);
      const bom = JSON.parse(readFileSync(bomFile, "utf-8"));
      assert.ok(bom.formulation?.length, "the formulation section must exist");
      assert.strictEqual(
        existsSync(marker),
        false,
        "formulation must not run mvnw from the scanned project",
      );
    } finally {
      rmSync(marker, { force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("maven wrapper is not executed in pre-build lifecycle either", () => {
    const marker = path.join(tmpdir(), `cdxgen-sec-mvnw-pre-${process.pid}`);
    try {
      const { status } = scanWithGate(
        path.join(fixtureRoot, "maven"),
        ["-t", "java", "--lifecycle", "pre-build"],
        marker,
      );
      assert.strictEqual(status, 0);
      assert.strictEqual(existsSync(marker), false);
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it("gradle wrapper and gradle properties are not executed", () => {
    const marker = path.join(tmpdir(), `cdxgen-sec-gradlew-${process.pid}`);
    try {
      const { status } = scanWithGate(
        path.join(fixtureRoot, "gradle"),
        ["-t", "java", "--no-install-deps"],
        marker,
      );
      assert.strictEqual(status, 0);
      assert.strictEqual(existsSync(marker), false);
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it("mill wrapper is not executed", () => {
    const marker = path.join(tmpdir(), `cdxgen-sec-mill-${process.pid}`);
    try {
      const { status } = scanWithGate(
        path.join(fixtureRoot, "mill"),
        ["-t", "java", "--no-install-deps"],
        marker,
      );
      assert.strictEqual(status, 0);
      assert.strictEqual(existsSync(marker), false);
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it("rush install is not executed", () => {
    const marker = path.join(tmpdir(), `cdxgen-sec-rush-${process.pid}`);
    const shimDir = mkdtempSync(path.join(tmpdir(), "cdxgen-sec-shim-"));
    try {
      const shim = path.join(shimDir, isWin ? "rush.cmd" : "rush");
      writeFileSync(
        shim,
        isWin
          ? '@echo off\r\ntype nul > "%CDXGEN_SEC_MARKER%"\r\nexit /b 0\r\n'
          : '#!/bin/sh\ntouch "$CDXGEN_SEC_MARKER"\nexit 0\n',
        { mode: 0o755, encoding: "utf-8" },
      );
      const { status } = runCdxgen(
        [
          "-t",
          "js",
          "-o",
          "-",
          "--no-validate",
          "--no-banner",
          "--no-install-deps",
          path.join(fixtureRoot, "rush"),
        ],
        {
          CDXGEN_SEC_MARKER: marker,
          PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
        },
      );
      assert.strictEqual(status, 0);
      assert.strictEqual(existsSync(marker), false);
    } finally {
      rmSync(marker, { force: true });
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("pipenv install is not executed", () => {
    const marker = path.join(tmpdir(), `cdxgen-sec-pipenv-${process.pid}`);
    const shimDir = mkdtempSync(path.join(tmpdir(), "cdxgen-sec-shim-"));
    try {
      const shim = path.join(shimDir, isWin ? "pipenv.cmd" : "pipenv");
      writeFileSync(
        shim,
        isWin
          ? '@echo off\r\ntype nul > "%CDXGEN_SEC_MARKER%"\r\nexit /b 0\r\n'
          : '#!/bin/sh\ntouch "$CDXGEN_SEC_MARKER"\nexit 0\n',
        { mode: 0o755, encoding: "utf-8" },
      );
      const { status } = runCdxgen(
        [
          "-t",
          "python",
          "-o",
          "-",
          "--no-validate",
          "--no-banner",
          "--no-install-deps",
          path.join(fixtureRoot, "pipenv"),
        ],
        {
          CDXGEN_SEC_MARKER: marker,
          PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
        },
      );
      assert.strictEqual(status, 0);
      assert.strictEqual(existsSync(marker), false);
    } finally {
      rmSync(marker, { force: true });
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  // Positive controls prove the wrappers would have run without the gate, so
  // the negative assertions above cannot pass because of a broken fixture.
  // The fixtures ship both spellings (POSIX shell scripts and .bat), so the
  // controls run on every platform.
  describe("positive controls", () => {
    it("maven wrapper runs without the gate", () => {
      const marker = path.join(tmpdir(), `cdxgen-sec-mvnw-pos-${process.pid}`);
      try {
        scanWithGate(path.join(fixtureRoot, "maven"), ["-t", "java"], marker);
        assert.strictEqual(
          existsSync(marker),
          true,
          "without --no-install-deps the wrapper is allowed to run",
        );
      } finally {
        rmSync(marker, { force: true });
      }
    });

    it("gradle wrapper runs without the gate", () => {
      const marker = path.join(
        tmpdir(),
        `cdxgen-sec-gradlew-pos-${process.pid}`,
      );
      try {
        scanWithGate(
          path.join(fixtureRoot, "gradle"),
          ["-t", "gradle"],
          marker,
        );
        assert.strictEqual(existsSync(marker), true);
      } finally {
        rmSync(marker, { force: true });
      }
    });

    it("mill wrapper runs without the gate", () => {
      const marker = path.join(tmpdir(), `cdxgen-sec-mill-pos-${process.pid}`);
      try {
        scanWithGate(path.join(fixtureRoot, "mill"), ["-t", "java"], marker);
        assert.strictEqual(existsSync(marker), true);
      } finally {
        rmSync(marker, { force: true });
      }
    });
  });
});
