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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

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

describe("npm install keeps a git dependency's .npmrc from choosing what runs", () => {
  // For a git dependency with a prepare script npm runs a second `npm install`
  // inside the clone, even with --ignore-scripts, and that npm reads the
  // .npmrc of the dependency's repository. The fixture is such a dependency:
  // its .npmrc names a script from the repository as npm's git command, and
  // sets node-options so that the npm preparing its own git dependency loads
  // a file from that one. Each payload adds a line to the marker file.
  if (isWin) {
    it.skip("the git stand-in of the fixture is a POSIX shell script");
    return;
  }

  function createGitDependencyProject() {
    const root = mkdtempSync(path.join(tmpdir(), "cdxgen-sec-npm-gitdep-"));
    const repoUrl = (name) =>
      `git+${pathToFileURL(path.join(root, name)).href}`;
    const writeRepoFiles = (name, files) => {
      mkdirSync(path.join(root, name));
      for (const [file, content] of Object.entries(files)) {
        writeFileSync(path.join(root, name, file), content, { mode: 0o755 });
      }
    };
    const payloadJs =
      'require("node:fs").appendFileSync(process.env.CDXGEN_SEC_MARKER, "node-options\\n");\n';
    writeRepoFiles("project", {
      "package.json": JSON.stringify({
        name: "sec-npm-gitdep",
        version: "1.0.0",
        dependencies: { dep: repoUrl("dep") },
      }),
    });
    writeRepoFiles("dep", {
      "package.json": JSON.stringify({
        name: "dep",
        version: "1.0.0",
        scripts: { prepare: "exit 0" },
        devDependencies: { leaf: repoUrl("leaf") },
      }),
      ".npmrc": "git=./git.sh\nnode-options=--require=./payload.js\n",
      "git.sh": '#!/bin/sh\necho git >> "$CDXGEN_SEC_MARKER"\nexec git "$@"\n',
    });
    writeRepoFiles("leaf", {
      "package.json": JSON.stringify({
        name: "leaf",
        version: "1.0.0",
        scripts: { prepare: "exit 0" },
      }),
      "payload.js": payloadJs,
    });
    for (const name of ["dep", "leaf"]) {
      for (const gitArgs of [
        ["init", "--quiet"],
        ["add", "--all"],
        [
          "-c",
          "user.name=cdxgen",
          "-c",
          "user.email=cdxgen@example.com",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--quiet",
          "-m",
          "fixture",
        ],
      ]) {
        const result = spawnSync("git", gitArgs, {
          cwd: path.join(root, name),
          encoding: "utf-8",
        });
        if (result.status !== 0) {
          throw new Error(
            `git ${gitArgs.join(" ")} failed in the ${name} fixture: ${result.stderr}`,
          );
        }
      }
    }
    return {
      root,
      projectDir: path.join(root, "project"),
      marker: path.join(root, "marker"),
      env: {
        CDXGEN_SEC_MARKER: path.join(root, "marker"),
        // Keep the clones out of the cache of the machine running the tests.
        NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
      },
    };
  }

  it("neither payload runs during the install of a lockfile-less project", () => {
    const { root, projectDir, marker, env } = createGitDependencyProject();
    try {
      const { status } = runCdxgen(
        ["-t", "js", "-o", "-", "--no-validate", "--no-banner", projectDir],
        env,
      );
      assert.strictEqual(status, 0);
      assert.strictEqual(
        existsSync(path.join(projectDir, "node_modules", "dep")),
        true,
        "the git dependency must still be installed",
      );
      assert.strictEqual(
        existsSync(marker),
        false,
        "the dependency's .npmrc must not pick git or NODE_OPTIONS for npm",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The same install without cdxgen's environment runs both payloads, so the
  // assertion above cannot pass because of a fixture npm has no use for.
  describe("positive controls", () => {
    it("both payloads run under a plain npm install --ignore-scripts", () => {
      const { root, projectDir, marker, env } = createGitDependencyProject();
      try {
        spawnSync(
          "npm",
          [
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-bin-links",
            "--git=git",
          ],
          { cwd: projectDir, env: { ...process.env, ...env } },
        );
        const ran = existsSync(marker) ? readFileSync(marker, "utf-8") : "";
        assert.match(ran, /^git$/m);
        assert.match(ran, /^node-options$/m);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
