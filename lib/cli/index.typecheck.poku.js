/**
 * Guards the time the TypeScript checker needs for lib/cli/index.js.
 *
 * createMultiXBom used to run one block per ecosystem, each reassigning an
 * untyped `let components = []` with concat. TypeScript's control-flow
 * analysis of that shape doubles with every block, so checking the file took
 * minutes and gigabytes in TypeScript 6 and 7, for editors, for `tsc
 * --checkJs` and for tools such as atom's astgen that type cdxgen's own
 * source (issue #4705). Fixed, the file checks in well under a second, so a
 * generous time limit fails only when the pattern returns.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assert, describe, it, log } from "poku";

const indexFile = join(dirname(fileURLToPath(import.meta.url)), "index.js");
const TIME_LIMIT_MS = 20000;

// TypeScript 7 ships tsc as a native binary behind a node launcher. Running
// the binary itself means the time limit stops the checker on every platform;
// on Windows the launcher runs it as a child that a timeout would leave behind.
const findTsc = async () => {
  let packageDir;
  try {
    const require = createRequire(import.meta.url);
    packageDir = dirname(require.resolve("typescript/package.json"));
  } catch {
    return undefined;
  }
  try {
    const { default: getExePath } = await import(
      pathToFileURL(join(packageDir, "lib", "getExePath.js")).href
    );
    return { command: getExePath(), args: [] };
  } catch {
    // older layouts: fall back to the package's tsc launcher
  }
  try {
    const { bin } = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf-8"),
    );
    const tscBin = typeof bin === "string" ? bin : bin?.tsc;
    return tscBin
      ? { command: process.execPath, args: [join(packageDir, tscBin)] }
      : undefined;
  } catch {
    return undefined;
  }
};

describe("type checking lib/cli/index.js", () => {
  it(`finishes within ${TIME_LIMIT_MS / 1000} seconds with checkJs`, async () => {
    const tsc = await findTsc();
    if (!tsc) {
      log("typescript is not installed; skipping the type check timing test");
      return;
    }
    const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-typecheck-"));
    try {
      const tsconfigFile = join(tmpDir, "tsconfig.json");
      writeFileSync(
        tsconfigFile,
        JSON.stringify({
          files: [indexFile],
          compilerOptions: {
            allowJs: true,
            checkJs: true,
            noEmit: true,
            skipLibCheck: true,
            target: "es2024",
            module: "nodenext",
            types: [],
          },
        }),
      );
      const started = Date.now();
      const result = spawnSync(tsc.command, [...tsc.args, "-p", tsconfigFile], {
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: TIME_LIMIT_MS,
        // tsc does not stop on SIGTERM while it is checking
        killSignal: "SIGKILL",
      });
      const elapsedMs = Date.now() - started;
      // The source is not written for strict checkJs, so tsc reports errors
      // and exits non-zero. Only finishing in time is asserted here.
      const finished =
        result.signal === null &&
        result.status !== null &&
        result.error?.code !== "ETIMEDOUT";
      const checkedIndex =
        result.status === 0 || `${result.stdout}`.includes("index.js");
      if (!finished || !checkedIndex) {
        log(
          `tsc status ${result.status}, signal ${result.signal}, error ${result.error?.message || "none"} after ${elapsedMs} ms`,
        );
        log(`${result.stderr || result.stdout}`.slice(0, 2000));
      }
      assert.ok(finished, "tsc finishes within the time limit");
      assert.ok(checkedIndex, "tsc reports on lib/cli/index.js");
      log(`tsc checked lib/cli/index.js in ${elapsedMs} ms`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
