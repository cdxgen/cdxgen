#!/usr/bin/env node
/**
 * Pre-compile CycloneDX schema validators using ajv/standalone.
 *
 * At runtime, `lib/validator/bomValidator.js` previously called `ajv.compile()`
 * on every validation-capable process start. The compilation takes ~114 ms of
 * codegen per process for the three supported spec versions (1.6, 1.7, 2.0).
 * This script generates the same validator functions at build time so the
 * runtime pays only the cost of a dynamic `import()` (~1 ms).
 *
 * The generated modules are ESM (`.mjs`) and use `export default`. Two small
 * ajv helper functions (`equal`, `ucs2length`) are loaded at runtime via
 * `createRequire`, so ajv remains a runtime dependency. Format validators are
 * looked up in the `cdxgenFormats` map that `runtime.mjs` exports: ajv-formats'
 * full set (still a runtime dependency) plus cdxgen's own `idn-email`, which
 * ajv-formats lacks. ajv/standalone emits every format reference through one
 * `code.formats` expression, so the extra format has to live in that same map.
 *
 * The custom linear-time `uniqueItems` keyword is inlined into the generated
 * code via the keyword's `code` (codegen) interface, so the O(n²) stock
 * implementation is never linked in.
 *
 * The 2.0 schemas under data/ come from the CycloneDX specification draft
 * pinned for epic cdxgen/cdxgen#4589: repository CycloneDX/specification,
 * branch 2.0-dev, commit ea8c3605829d1da13339a0790b6da73548e42a6b, files
 * schema/2.0/cyclonedx-2.0-bundled.schema.json,
 * schema/behavior-taxonomy.schema.json and schema/cryptography-defs.schema.json
 * (copied verbatim; the last one is stored as
 * data/cyclonedx-2.0-cryptography-defs.schema.json so that the 1.7 validator
 * keeps reading the 1.7-era data/cryptography-defs.schema.json). The bundled
 * schema's relative refs resolve to
 * https://cyclonedx.org/schema/behavior-taxonomy.schema.json,
 * https://cyclonedx.org/schema/cryptography-defs.schema.json and
 * https://cyclonedx.org/schema/spdx.schema.json, which is why those are
 * registered under exactly those ids in both this generator and
 * compileSchemaValidator in lib/validator/bomValidator.js. When CycloneDX 2.0
 * is ratified, refresh all three files from the release tag, update the commit
 * named here and re-run this script.
 *
 * Usage:
 *   node contrib/gen-validators.mjs            # generate
 *   node contrib/gen-validators.mjs --check    # fail if output differs from committed
 *
 * Output files:
 *   lib/validator/generated/validate-1.6.mjs
 *   lib/validator/generated/validate-1.7.mjs
 *   lib/validator/generated/validate-2.0.mjs
 *   lib/validator/generated/runtime.mjs
 */

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { isValidIdnEmail } from "../lib/parsers/email.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const Ajv2020 = require("ajv/dist/2020.js");
const { _ } = require("ajv/dist/compile/codegen/index.js");
const standaloneCode = require("ajv/dist/standalone/index.js");
const addFormats = require("ajv-formats");

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const dataDir = join(repoRoot, "data");
const outDir = join(repoRoot, "lib", "validator", "generated");

const AJV_OPTIONS = {
  strict: false,
  logger: false,
  verbose: true,
  code: {
    source: true,
    lines: true,
    optimize: true,
    esm: true,
  },
};

function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return typeof value === "string"
      ? `s${value.length}:${value}`
      : `${typeof value}:${value}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `s${key.length}:${key}=${canonicalize(value[key])}`).join(",")}}`;
}

/**
 * Replace ajv's built-in uniqueItems keyword with a linear-time Set-based
 * version that uses {@link canonicalize} for deep-equality via a canonical
 * hash. Uses the `code` (codegen) interface so ajv/standalone inlines the
 * logic into the generated module.
 */
function useLinearUniqueItems(ajv) {
  ajv.removeKeyword("uniqueItems");
  ajv.addKeyword({
    keyword: "uniqueItems",
    type: "array",
    schemaType: "boolean",
    error: {
      message: "must NOT have duplicate items",
    },
    code(cxt) {
      const { gen, data, schema } = cxt;
      if (!schema) return;
      const canon = gen.scopeValue("func", {
        ref: canonicalize,
        code: _`canonicalize`,
      });
      // Emit the uniqueness check as a raw block so the optimizer cannot
      // elide the assignment, then report through ajv's standard error path.
      const hasDup = gen.name("hasDup");
      gen.code(_`var ${hasDup} = false`);
      gen.code(_`{
var __seen = new Set();
for (var __item of ${data}) {
  var __key = ${canon}(__item);
  if (__seen.has(__key)) { ${hasDup} = true; break; }
  __seen.add(__key);
}
}`);
      gen.if(hasDup, () => {
        cxt.error();
      });
    },
  });
}

/**
 * Register the formats the CycloneDX schemas assert, as `bomValidator.js`
 * does at runtime, and point the generated code at `runtime.mjs`'s
 * `cdxgenFormats` map for all of them.
 */
function addCycloneDxFormats(ajv) {
  addFormats(ajv);
  ajv.addFormat("idn-email", isValidIdnEmail);
  ajv.opts.code.formats = _`cdxgenFormats`;
}

const readJson = (fileName) =>
  JSON.parse(readFileSync(join(dataDir, fileName), "utf-8"));

function generateRuntimeModule() {
  return `// AUTO-GENERATED by contrib/gen-validators.mjs — do not edit.
// Shared runtime helper for the pre-compiled CycloneDX schema validators.
// The linear-time uniqueItems keyword calls this instead of ajv's pairwise
// deep-equal, so the generated validators retain O(n) uniqueness checking.

import { createRequire } from "node:module";

import { isValidIdnEmail } from "../../parsers/email.js";

const require = createRequire(import.meta.url);

// Every format the generated validators check: ajv-formats' full set plus
// idn-email, which ajv-formats lacks (see contrib/gen-validators.mjs).
export const cdxgenFormats = {
  ...require("ajv-formats/dist/formats").fullFormats,
  "idn-email": isValidIdnEmail,
};

export function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return typeof value === "string"
      ? \`s\${value.length}:\${value}\`
      : \`\${typeof value}:\${value}\`;
  }
  if (Array.isArray(value)) {
    return \`[\${value.map(canonicalize).join(",")}]\`;
  }
  const keys = Object.keys(value).sort();
  return \`{\${keys.map((key) => \`s\${key.length}:\${key}=\${canonicalize(value[key])}\`).join(",")}}\`;
}
`;
}

function generateLegacyValidator(specVersion) {
  const schemas = [
    readJson(`bom-${specVersion}.schema.json`),
    readJson("jsf-0.82.schema.json"),
    readJson("spdx.schema.json"),
  ];
  if (specVersion === "1.7") {
    schemas.push(readJson("cryptography-defs.schema.json"));
  }
  const ajv = new Ajv({ ...AJV_OPTIONS, schemas });
  useLinearUniqueItems(ajv);
  addCycloneDxFormats(ajv);
  const validate = ajv.getSchema(
    `http://cyclonedx.org/schema/bom-${specVersion}.schema.json`,
  );
  const code = standaloneCode(ajv, validate);
  return `// AUTO-GENERATED by contrib/gen-validators.mjs — do not edit.
// CycloneDX ${specVersion} schema validator (pre-compiled with ajv/standalone).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { canonicalize, cdxgenFormats } from "./runtime.mjs";
${code}
`;
}

function generateDraft2020Validator() {
  const ajv = new Ajv2020(AJV_OPTIONS);
  useLinearUniqueItems(ajv);
  addCycloneDxFormats(ajv);
  const addBundled = (schema, schemaId) => {
    const bundled = { ...schema };
    delete bundled.$schema;
    bundled.$id = schemaId;
    ajv.addSchema(bundled);
  };
  addBundled(
    readJson("cyclonedx-2.0-cryptography-defs.schema.json"),
    "https://cyclonedx.org/schema/cryptography-defs.schema.json",
  );
  addBundled(
    readJson("behavior-taxonomy.schema.json"),
    "https://cyclonedx.org/schema/behavior-taxonomy.schema.json",
  );
  addBundled(
    readJson("jsf-0.82.schema.json"),
    "https://cyclonedx.org/schema/jsf-0.82.schema.json",
  );
  addBundled(
    readJson("spdx.schema.json"),
    "https://cyclonedx.org/schema/spdx.schema.json",
  );
  const validate = ajv.compile(readJson("cyclonedx-2.0-bundled.schema.json"));
  const code = standaloneCode(ajv, validate);
  return `// AUTO-GENERATED by contrib/gen-validators.mjs — do not edit.
// CycloneDX 2.0 schema validator (pre-compiled with ajv/standalone).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { canonicalize, cdxgenFormats } from "./runtime.mjs";
${code}
`;
}

function main() {
  const checkMode = process.argv.includes("--check");
  mkdirSync(outDir, { recursive: true });

  const outputs = [
    { path: join(outDir, "runtime.mjs"), content: generateRuntimeModule() },
    {
      path: join(outDir, "validate-1.6.mjs"),
      content: generateLegacyValidator("1.6"),
    },
    {
      path: join(outDir, "validate-1.7.mjs"),
      content: generateLegacyValidator("1.7"),
    },
    {
      path: join(outDir, "validate-2.0.mjs"),
      content: generateDraft2020Validator(),
    },
  ];

  let changed = false;
  for (const { path: fpath, content } of outputs) {
    if (checkMode) {
      let existing = "";
      try {
        existing = readFileSync(fpath, "utf-8");
      } catch (_e) {
        // file doesn't exist
      }
      if (existing !== content) {
        console.error(`DRIFT: ${fpath} does not match generated output.`);
        changed = true;
      }
    } else {
      writeFileSync(fpath, content);
      console.log(`Generated ${fpath} (${content.length} bytes)`);
    }
  }
  if (checkMode && changed) {
    console.error(
      "\nGenerated validators are stale. Run: node contrib/gen-validators.mjs",
    );
    process.exit(1);
  }
  if (checkMode) {
    console.log("All generated validators are up to date.");
  }
}

main();
