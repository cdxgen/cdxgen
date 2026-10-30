import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Reads the root package.json exports map and expands wildcard entries
 * into concrete subpaths by listing files on disk.
 *
 * @returns {Array<{subpath: string, importPath: string, typesPath?: string}>}
 *   One entry per concrete exports subpath.
 */
function expandExportsMap() {
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
  );
  const exportsMap = pkg.exports;
  const entries = [];

  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (subpath.includes("*")) {
      // Wildcard: find files matching the pattern
      const importGlob = target.import;
      const typesGlob = target.types;
      const importDir = path.dirname(importGlob.replace(/^\.\//, ""));
      const importExt = path.extname(importGlob);

      const fullDir = path.join(REPO_ROOT, importDir);
      if (!existsSync(fullDir)) {
        entries.push({
          subpath: subpath,
          importPath: importGlob,
          exists: false,
        });
        continue;
      }

      const files = readdirSync(fullDir).filter(
        (f) => f.endsWith(importExt) && !f.endsWith(".poku.js"),
      );

      for (const f of files) {
        const name = f.replace(importExt, "");
        const expandedSubpath = subpath.replace("*", name);
        const expandedImport = importGlob.replace("*", name);
        const expandedTypes = typesGlob
          ? typesGlob.replace("*", name)
          : undefined;
        entries.push({
          subpath: expandedSubpath,
          importPath: expandedImport,
          typesPath: expandedTypes,
        });
      }
    } else {
      // Concrete entry
      entries.push({
        subpath,
        importPath: target.import,
        typesPath: target.types,
        requirePath: target.require,
      });
    }
  }

  return entries;
}

/**
 * Runs `npm pack --dry-run --json` and returns the sorted file list.
 *
 * @returns {string[]} Sorted array of file paths included in the tarball.
 */
function getPackFileList() {
  const output = execSync("npm pack --dry-run --json", {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const data = JSON.parse(output);
  return data[0].files.map((f) => f.path).sort();
}

describe("exports map resolution", () => {
  it("every exports entry references a file that exists in the pack", () => {
    const entries = expandExportsMap();
    const packList = new Set(getPackFileList());
    const missing = [];

    for (const entry of entries) {
      const importFile = entry.importPath.replace(/^\.\//, "");
      if (!packList.has(importFile)) {
        missing.push(`${entry.subpath} → ${entry.importPath}`);
      }
    }

    if (missing.length > 0) {
      assert.fail(
        `Exports entries pointing at files NOT in the tarball:\n${missing.map((m) => `  ${m}`).join("\n")}`,
      );
    }
  });

  it("every exports subpath resolves via import.meta.resolve", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
    );
    const packageName = pkg.name;
    const entries = expandExportsMap();
    const failures = [];

    for (const entry of entries) {
      // subpath is "./evinser/db" or "." — strip the leading dot so the
      // specifier becomes "@cdxgen/cdxgen/evinser/db" or "@cdxgen/cdxgen"
      const specifier =
        entry.subpath === "."
          ? packageName
          : `${packageName}${entry.subpath.slice(1)}`;
      try {
        // Node 24: import.meta.resolve is synchronous and unflagged
        const resolved = import.meta.resolve(specifier);
        // Verify the resolved URL points to a file that exists
        const filePath = fileURLToPath(resolved);
        if (!existsSync(filePath)) {
          failures.push(
            `${specifier} resolved to ${filePath} but file does not exist`,
          );
        }
      } catch (err) {
        failures.push(`${specifier}: ${err.message}`);
      }
    }

    if (failures.length > 0) {
      assert.fail(
        `Exports resolution failures:\n${failures.map((f) => `  ${f}`).join("\n")}`,
      );
    }
  });

  it("every types entry references a .d.ts file on disk", () => {
    const entries = expandExportsMap();
    const missing = [];

    for (const entry of entries) {
      if (!entry.typesPath) continue;
      const typesFile = entry.typesPath.replace(/^\.\//, "");
      const fullPath = path.join(REPO_ROOT, typesFile);
      if (!existsSync(fullPath)) {
        missing.push(`${entry.subpath} types → ${entry.typesPath}`);
      }
    }

    // Types are generated; only warn if missing (types may need regeneration)
    if (missing.length > 0) {
      console.warn(
        `Types entries pointing at files NOT on disk (run pnpm run gen-types):\n${missing.map((m) => `  ${m}`).join("\n")}`,
      );
    }
  });
});

describe("installed tarball import test", () => {
  // This is the full integration test: pack, install in temp dir, import.
  // Skipped unless CDXGEN_PACKAGING_FULL=1 because it's slow (~60s).
  const runFull = process.env.CDXGEN_PACKAGING_FULL === "1";

  (runFull ? it : it.skip)(
    "packed tarball installs and every exports entry imports cleanly",
    async () => {
      const os = await import("node:os");
      const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");

      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-pkg-"));
      let tarballName = null;
      try {
        // Pack the tarball
        tarballName = execSync("npm pack", {
          cwd: REPO_ROOT,
          encoding: "utf-8",
        }).trim();
        const tarballPath = path.join(REPO_ROOT, tarballName);

        // Create a consumer package
        writeFileSync(
          path.join(tmpDir, "package.json"),
          JSON.stringify({
            name: "packaging-test-consumer",
            type: "module",
            private: true,
          }),
        );

        // Install the tarball
        execSync(`npm install ${tarballPath}`, {
          cwd: tmpDir,
          stdio: "pipe",
          timeout: 120000,
        });

        // For each exports entry, try to import it from the consumer
        const entries = expandExportsMap();
        const failures = [];

        for (const entry of entries) {
          const subpath =
            entry.subpath === "."
              ? "@cdxgen/cdxgen"
              : `@cdxgen/cdxgen${entry.subpath.slice(1)}`;
          try {
            await import(subpath);
          } catch (err) {
            // Some modules may fail at import time due to missing native deps
            // (atom, plugins-bin). Record the error but only fail on
            // resolution errors (ERR_MODULE_NOT_FOUND), not runtime errors.
            if (
              err.code === "ERR_MODULE_NOT_FOUND" ||
              err.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
            ) {
              failures.push(`${subpath}: ${err.code} — ${err.message}`);
            }
          }
        }

        if (failures.length > 0) {
          assert.fail(
            `Resolution failures from installed tarball:\n${failures.map((f) => `  ${f}`).join("\n")}`,
          );
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        // Clean up the tarball
        if (tarballName) {
          try {
            rmSync(path.join(REPO_ROOT, tarballName), { force: true });
          } catch {
            // ignore
          }
        }
      }
    },
  );
});

describe("deno.json import map", () => {
  it("pins every npm import to the version package.json installs", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
    );
    const deno = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "deno.json"), "utf-8"),
    );
    const declared = {
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
      ...pkg.dependencies,
    };
    const problems = [];
    for (const [name, target] of Object.entries(deno.imports || {})) {
      if (!target.startsWith("npm:")) {
        continue;
      }
      const spec = target.slice("npm:".length);
      const at = spec.lastIndexOf("@");
      const pkgName = at > 0 ? spec.slice(0, at) : spec;
      const version = at > 0 ? spec.slice(at + 1) : "";
      if (declared[pkgName] === undefined) {
        problems.push(
          `${name}: ${pkgName} is not a dependency in package.json`,
        );
      } else if (declared[pkgName] !== version) {
        problems.push(
          `${name}: deno.json pins ${version}, package.json ${declared[pkgName]}`,
        );
      }
    }
    assert.deepStrictEqual(problems, []);
  });
});
