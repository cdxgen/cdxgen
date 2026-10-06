import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import esmock from "esmock";
import { safeExistsSync } from "../core/fs.js";
import { assert, describe, it } from "poku";

import { normalizeDosaiServiceMap } from "../inventory/dosai.js";
import { mergeServices } from "../inventory/depsUtils.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { validateBom } from "../validator/bomValidator.js";

import {
  analyzeScalaProject,
  isScalasemLanguage,
  resolveScalasemCommand,
  scalasemDisabled,
  scalasemMetadataProperties,
  scalasemOutputFile,
} from "./scalasem.js";

const v2Report = {
  _meta: {
    schemaVersion: "scalasem/2",
    tool: "scalasem",
    projectPath: "/src/app",
    generatedFrom: ["tasty"],
    compilers: [{ version: "3.3.7", source: "sbt" }],
    platforms: ["jvm"],
    counts: { files: 4, calls: 110 },
    diagnostics: [{ code: "unreadable-tasty", count: 2 }],
  },
  config: { routes: [] },
  modules: [],
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stubDir = mkdtempSync(join(tmpdir(), "scalasem-poku-"));

// One file per stub: tests run concurrently and rewrite their stubs.
let stubCount = 0;
function writeStub(body) {
  stubCount += 1;
  const stub = join(stubDir, `scalasem-stub-${stubCount}.js`);
  writeFileSync(stub, body);
  return stub;
}

function quiet(fn) {
  const original = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = original;
  }
}

it("recognises every scala project type", () => {
  for (const language of ["scala", "scala3", "sbt", "mill", "scala-cli"]) {
    assert.ok(isScalasemLanguage(language), language);
  }
  assert.ok(!isScalasemLanguage("java"));
  assert.ok(!isScalasemLanguage(undefined));
});

it("resolves the report output path beside the evinse output", () => {
  const bomDir = mkdtempSync(join(tmpdir(), "scalasem-out-"));
  try {
    assert.strictEqual(
      scalasemOutputFile({
        semanticsSlicesFile: "/abs/report.json",
        output: join(bomDir, "bom.evinse.json"),
      }),
      "/abs/report.json",
    );
    assert.strictEqual(
      scalasemOutputFile({
        semanticsSlicesFile: "semantics.slices.json",
        output: join(bomDir, "bom.evinse.json"),
      }),
      join(bomDir, "semantics.slices.json"),
    );
    assert.strictEqual(
      scalasemOutputFile({
        semanticsSlicesFile: "semantics.slices.json",
        output: bomDir,
      }),
      join(bomDir, "semantics.slices.json"),
    );
  } finally {
    rmSync(bomDir, { recursive: true, force: true });
  }
});

it("reuses a matching report newer than the input BOM", () => {
  const work = mkdtempSync(join(tmpdir(), "scalasem-reuse-"));
  const projectDir = join(work, "app");
  mkdirSync(projectDir);
  try {
    const exitStub = writeStub("process.exit(9);");
    const reportFile = join(work, "semantics.slices.json");
    const bomFile = join(work, "bom.json");
    writeFileSync(
      reportFile,
      JSON.stringify({ ...v2Report, _meta: { ...v2Report._meta, projectPath: projectDir } }),
    );
    writeFileSync(bomFile, "{}");
    const older = new Date(Date.now() - 60_000);
    utimesSync(bomFile, older, older);
    const options = {
      input: bomFile,
      semanticsSlicesFile: reportFile,
      output: join(work, "bom.evinse.json"),
      scalasemCommand: exitStub,
    };
    const reused = quiet(() => analyzeScalaProject(projectDir, options));
    assert.strictEqual(reused.report._meta.schemaVersion, "scalasem/2");
    // A report from another project is regenerated, and the failure to write
    // one shows up as a diagnostic instead of silence.
    const otherProject = join(work, "other");
    mkdirSync(otherProject);
    const other = quiet(() => analyzeScalaProject(otherProject, options));
    assert.strictEqual(other.report, undefined);
    const codes = other.metadataProperties
      .filter((property) => property.name.startsWith("cdx:scalasem:diagnostic"))
      .map((property) => property.name);
    assert.ok(codes.length > 0, JSON.stringify(codes));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

it("returns a version 1 slice beside the fresh report without overwriting it", () => {
  const work = mkdtempSync(join(tmpdir(), "scalasem-v1-"));
  const projectDir = join(work, "app");
  mkdirSync(projectDir);
  try {
    const sliceFile = join(work, "semantics.slices.json");
    const bomFile = join(work, "bom.json");
    const v1Slice = {
      "src/main/scala/App.scala": { usedTypes: ["jwt.core.Jwt"] },
    };
    writeFileSync(sliceFile, JSON.stringify(v1Slice));
    writeFileSync(bomFile, "{}");
    const newer = new Date(Date.now() + 60_000);
    utimesSync(sliceFile, newer, newer);
    const v1Stub = writeStub(
      `require("node:fs").writeFileSync(process.argv[3], JSON.stringify(${JSON.stringify(
        v2Report,
      ).replace("/src/app", projectDir)}));`,
    );
    const analysis = quiet(() =>
      analyzeScalaProject(projectDir, {
        input: bomFile,
        semanticsSlicesFile: sliceFile,
        output: join(work, "bom.evinse.json"),
        scalasemCommand: v1Stub,
      }),
    );
    assert.ok(analysis.report._meta);
    assert.deepStrictEqual(analysis.v1Slice, v1Slice);
    assert.deepStrictEqual(
      JSON.parse(readFileSync(sliceFile, "utf-8")),
      v1Slice,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

it("reports a failing analyzer as diagnostics, not silence", () => {
  const work = mkdtempSync(join(tmpdir(), "scalasem-fail-"));
  const projectDir = join(work, "app");
  mkdirSync(projectDir);
  try {
    const bomFile = join(work, "bom.json");
    writeFileSync(bomFile, "{}");
    const failStub = writeStub("process.exit(3);");
    const analysis = quiet(() =>
      analyzeScalaProject(projectDir, {
        input: bomFile,
        semanticsSlicesFile: join(work, "semantics.slices.json"),
        output: join(work, "bom.evinse.json"),
        scalasemCommand: failStub,
      }),
    );
    assert.strictEqual(analysis.report, undefined);
    const codes = analysis.metadataProperties
      .filter((property) => property.name.startsWith("cdx:scalasem:diagnostic"))
      .map((property) => property.name);
    assert.ok(
      codes.includes("cdx:scalasem:diagnostic:scalasem-no-report"),
      JSON.stringify(codes),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

it("maps report metadata onto cdx:scalasem properties", () => {
  const properties = scalasemMetadataProperties(v2Report);
  const byName = Object.fromEntries(
    properties.map((property) => [property.name, property.value]),
  );
  assert.strictEqual(byName["cdx:scalasem:schemaVersion"], "scalasem/2");
  assert.strictEqual(byName["cdx:scalasem:factsSource"], "tasty");
  assert.strictEqual(byName["cdx:scalasem:compilerSource"], "sbt");
  assert.strictEqual(byName["cdx:scalasem:scalaVersions"], "3.3.7");
  assert.strictEqual(byName["cdx:scalasem:platforms"], "jvm");
  assert.strictEqual(byName["cdx:scalasem:filesAnalyzed"], "4");
  assert.strictEqual(byName["cdx:scalasem:degraded"], "true");
  assert.strictEqual(byName["cdx:scalasem:diagnostic:unreadable-tasty"], "2");
});

it("reads the command override and the disable switch through the environment", () => {
  const previousCommand = process.env.SCALASEM_CMD;
  const previousDisable = process.env.CDXGEN_SCALASEM_DISABLE;
  try {
    process.env.SCALASEM_CMD = "/opt/scalasem.js";
    assert.strictEqual(resolveScalasemCommand(), "/opt/scalasem.js");
    assert.ok(!scalasemDisabled({}));
    process.env.CDXGEN_SCALASEM_DISABLE = "true";
    assert.ok(scalasemDisabled({}));
    process.env.CDXGEN_SCALASEM_DISABLE = "0";
    assert.ok(!scalasemDisabled({}));
    assert.ok(scalasemDisabled({ noScalasem: true }));
  } finally {
    if (previousCommand === undefined) {
      delete process.env.SCALASEM_CMD;
    } else {
      process.env.SCALASEM_CMD = previousCommand;
    }
    if (previousDisable === undefined) {
      delete process.env.CDXGEN_SCALASEM_DISABLE;
    } else {
      process.env.CDXGEN_SCALASEM_DISABLE = previousDisable;
    }
  }
});

rmSync(stubDir, { recursive: true, force: true });
