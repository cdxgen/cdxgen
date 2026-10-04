import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import { resolvePluginSourceDir } from "./pluginRun.js";

// resolvePluginSourceDir reads the process working directory, so these tests
// chdir into fixtures and restore the original directory on exit.
const originalCwd = process.cwd();
process.on("exit", () => {
  process.chdir(originalCwd);
});

function makeProjectDir(marker) {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-plugin-run-"));
  if (marker) {
    writeFileSync(join(dir, marker), "");
  }
  // process.cwd() resolves symlinks (macOS /var -> /private/var), so the
  // fixture must be compared in resolved form.
  return realpathSync(dir);
}

describe("resolvePluginSourceDir", () => {
  it("keeps a resolution that exists", () => {
    const projectDir = makeProjectDir("Cargo.toml");
    const nested = join(projectDir, "crate");
    mkdirSync(nested);
    try {
      process.chdir(projectDir);
      assert.equal(resolvePluginSourceDir("crate", ["Cargo.toml"]), nested);
      assert.equal(
        resolvePluginSourceDir(projectDir, ["Cargo.toml"]),
        projectDir,
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("falls back to the working directory when the join landed nowhere and it carries the marker", () => {
    // The depscan shape: cwd IS the cargo project, the argument is a
    // repo-root-relative path that does not exist from here.
    const projectDir = makeProjectDir("Cargo.toml");
    try {
      process.chdir(projectDir);
      const errorSpy = console.error;
      const errors = [];
      console.error = (...args) => errors.push(args.join(" "));
      try {
        assert.equal(
          resolvePluginSourceDir("test/data/rusi/repos/reachable-app", [
            "Cargo.toml",
          ]),
          projectDir,
        );
      } finally {
        console.error = errorSpy;
      }
      // The fallback is visible, naming both directories.
      assert.ok(
        errors.some((line) => line.includes("does not exist")),
        `expected a fallback notice, got ${JSON.stringify(errors)}`,
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("keeps the plain resolution when the working directory has no marker", () => {
    const bareDir = makeProjectDir(null);
    try {
      process.chdir(bareDir);
      assert.equal(
        resolvePluginSourceDir("nowhere/at/all", ["Cargo.toml"]),
        join(bareDir, "nowhere/at/all"),
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it("does not fall back for an absolute path that does not exist", () => {
    const projectDir = makeProjectDir("Cargo.toml");
    try {
      process.chdir(projectDir);
      const missing = join(projectDir, "explicitly", "missing");
      assert.equal(resolvePluginSourceDir(missing, ["Cargo.toml"]), missing);
    } finally {
      process.chdir(originalCwd);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
