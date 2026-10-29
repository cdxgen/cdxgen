import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  check,
  findOnPath,
  installedVersion,
  isOlder,
} from "./check-cdxgen.mjs";
import { isDependencyFile, remind } from "./stale-sbom.mjs";

const scratch = mkdtempSync(path.join(tmpdir(), "cdxgen-hooks-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// A fake npm global install: <prefix>/lib/node_modules/@cdxgen/cdxgen with
// bin/cdxgen.js linked from <prefix>/bin/cdxgen.
function fakeInstall(version) {
  const prefix = mkdtempSync(path.join(scratch, "prefix-"));
  const pkg = path.join(prefix, "lib", "node_modules", "@cdxgen", "cdxgen");
  mkdirSync(path.join(pkg, "bin"), { recursive: true });
  writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "@cdxgen/cdxgen", version }),
  );
  writeFileSync(path.join(pkg, "bin", "cdxgen.js"), "");
  mkdirSync(path.join(prefix, "bin"));
  symlinkSync(
    path.join(pkg, "bin", "cdxgen.js"),
    path.join(prefix, "bin", "cdxgen"),
  );
  return path.join(prefix, "bin");
}

describe("check-cdxgen", () => {
  it("compares versions by major, minor and patch", () => {
    assert.equal(isOlder("13.5.9", "13.6.0"), true);
    assert.equal(isOlder("13.6.0", "13.6.0"), false);
    assert.equal(isOlder("13.10.0", "13.6.0"), false);
    assert.equal(isOlder("13.6.0-beta.1", "13.6.0"), false);
  });

  it("warns when cdxgen is not on PATH", {
    skip: process.platform === "win32",
  }, () => {
    const result = check("13.6.0", { PATH: scratch }, "linux");
    assert.match(result.systemMessage, /not on PATH/);
    assert.equal(result.hookSpecificOutput.hookEventName, "SessionStart");
  });

  it("reads the version next to a linked binary", {
    skip: process.platform === "win32",
  }, () => {
    const bin = fakeInstall("13.4.1");
    assert.equal(
      installedVersion(findOnPath("cdxgen", { PATH: bin }, "linux")),
      "13.4.1",
    );
    assert.match(
      check("13.6.0", { PATH: bin }, "linux").systemMessage,
      /13\.4\.1 is older/,
    );
    assert.equal(check("13.4.1", { PATH: bin }, "linux"), undefined);
  });

  it("stays quiet when the version cannot be read", {
    skip: process.platform === "win32",
  }, () => {
    const dir = mkdtempSync(path.join(scratch, "sea-"));
    writeFileSync(path.join(dir, "cdxgen"), "");
    assert.equal(check("13.6.0", { PATH: dir }, "linux"), undefined);
  });
});

describe("stale-sbom", () => {
  const on = { CLAUDE_PLUGIN_OPTION_LOCKFILE_REMINDER: "true" };

  it("recognises lockfiles and manifests", () => {
    for (const f of [
      "/p/package-lock.json",
      "/p/requirements-dev.txt",
      "/p/app.csproj",
      "/p/go.sum",
    ]) {
      assert.equal(isDependencyFile(f), true, f);
    }
    for (const f of [
      "/p/index.js",
      "/p/README.md",
      "/p/package.json.bak",
      undefined,
    ]) {
      assert.equal(isDependencyFile(f), false, String(f));
    }
  });

  it("does nothing unless the option is on", () => {
    const input = {
      session_id: "s",
      tool_input: { file_path: "/p/package.json" },
    };
    assert.equal(remind(input, {}), undefined);
    assert.equal(
      remind(input, { CLAUDE_PLUGIN_OPTION_LOCKFILE_REMINDER: "false" }),
      undefined,
    );
  });

  it("reminds once per file per session", () => {
    const env = {
      ...on,
      CLAUDE_PLUGIN_DATA: mkdtempSync(path.join(scratch, "data-")),
    };
    const input = {
      session_id: "abc",
      tool_input: { file_path: "/p/pnpm-lock.yaml" },
    };
    assert.match(
      remind(input, env).hookSpecificOutput.additionalContext,
      /pnpm-lock\.yaml changed/,
    );
    assert.equal(remind(input, env), undefined);
    assert.ok(remind({ ...input, session_id: "def" }, env));
    assert.ok(
      remind({ ...input, tool_input: { file_path: "/p/go.mod" } }, env),
    );
  });
});
