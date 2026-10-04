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

import {
  cwdNamedByRelativeSource,
  resolvePluginSourceDir,
  resolveSourcePathArgument,
} from "./pluginRun.js";

// resolvePluginSourceDir reads the process working directory, so these tests
// chdir into fixtures and restore the original directory on exit.
const originalCwd = process.cwd();
process.on("exit", () => {
  process.chdir(originalCwd);
});

function makeProjectDir(marker, relative) {
  // process.cwd() resolves symlinks (macOS /var -> /private/var), so the
  // fixture must be compared in resolved form.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cdxgen-plugin-run-")));
  const dir = relative ? join(root, ...relative.split("/")) : root;
  mkdirSync(dir, { recursive: true });
  if (marker) {
    writeFileSync(join(dir, marker), "");
  }
  return { root, dir };
}

describe("resolvePluginSourceDir", () => {
  it("keeps a resolution that exists", () => {
    const { root, dir: projectDir } = makeProjectDir("Cargo.toml");
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the working directory when the join landed nowhere and it carries the marker", () => {
    // The depscan shape: cwd IS the cargo project, the argument is a
    // repo-root-relative path that does not exist from here.
    const { root, dir: projectDir } = makeProjectDir(
      "Cargo.toml",
      "test/data/rusi/repos/reachable-app",
    );
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the plain resolution when the working directory has no marker", () => {
    const { root, dir: bareDir } = makeProjectDir(null);
    try {
      process.chdir(bareDir);
      assert.equal(
        resolvePluginSourceDir("nowhere/at/all", ["Cargo.toml"]),
        join(bareDir, "nowhere/at/all"),
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fall back for an absolute path that does not exist", () => {
    const { root, dir: projectDir } = makeProjectDir("Cargo.toml");
    try {
      process.chdir(projectDir);
      const missing = join(projectDir, "explicitly", "missing");
      assert.equal(resolvePluginSourceDir(missing, ["Cargo.toml"]), missing);
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not redirect a mistyped argument to an unrelated project in the working directory", () => {
    // cwd is SOME cargo project, but the argument does not name it; analysing
    // the cwd would attach another project's evidence to this BOM.
    const { root, dir: projectDir } = makeProjectDir("Cargo.toml", "other-app");
    try {
      process.chdir(projectDir);
      assert.equal(
        resolvePluginSourceDir("test/data/rusi/repos/reachable-app", [
          "Cargo.toml",
        ]),
        join(projectDir, "test/data/rusi/repos/reachable-app"),
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fall back when the named working directory lacks the marker", () => {
    const { root, dir } = makeProjectDir(null, "repos/app");
    try {
      process.chdir(dir);
      assert.equal(
        resolvePluginSourceDir("repos/app", ["Cargo.toml"]),
        join(dir, "repos/app"),
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cwdNamedByRelativeSource", () => {
  const cwd = join(tmpdir(), "repo", "test", "data", "app");
  it("matches only when the argument is the trailing segments of the cwd", () => {
    assert.equal(cwdNamedByRelativeSource("test/data/app", cwd), cwd);
    assert.equal(cwdNamedByRelativeSource("./data/app/", cwd), cwd);
    assert.equal(cwdNamedByRelativeSource("app", cwd), cwd);
    assert.equal(cwdNamedByRelativeSource("data/other", cwd), undefined);
    // A partial segment is not a match: "pp" is not the directory "app".
    assert.equal(cwdNamedByRelativeSource("pp", cwd), undefined);
  });
  it("never matches absolute, empty, dot or parent-relative arguments", () => {
    assert.equal(cwdNamedByRelativeSource(cwd, cwd), undefined);
    assert.equal(cwdNamedByRelativeSource("", cwd), undefined);
    assert.equal(cwdNamedByRelativeSource(".", cwd), undefined);
    assert.equal(cwdNamedByRelativeSource("../data/app", cwd), undefined);
    assert.equal(cwdNamedByRelativeSource(undefined, cwd), undefined);
  });
});

describe("resolveSourcePathArgument", () => {
  it("rewrites the doubled-directory shape to the working directory", () => {
    const { root, dir } = makeProjectDir("Cargo.toml", "test/data/app");
    try {
      assert.deepEqual(resolveSourcePathArgument("test/data/app", dir), {
        path: dir,
        rewritten: true,
        missing: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("keeps an argument that exists, and flags one that does not", () => {
    const { root } = makeProjectDir(null, "test/data/app");
    try {
      assert.deepEqual(resolveSourcePathArgument("test/data/app", root), {
        path: "test/data/app",
        rewritten: false,
        missing: false,
      });
      assert.deepEqual(resolveSourcePathArgument("no/such/dir", root), {
        path: "no/such/dir",
        rewritten: false,
        missing: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
