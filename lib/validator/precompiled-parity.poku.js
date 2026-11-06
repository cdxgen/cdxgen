/**
 * Equivalence of the pre-compiled schema validators with the runtime-compiled
 * ones.
 *
 * `lib/validator/generated/*.mjs` is built by `contrib/gen-validators.mjs` from
 * the same schemas and the same custom `uniqueItems` keyword that
 * `bomValidator.js` wires up when it compiles at runtime — but through a second
 * code path: the keyword is emitted as generated code rather than executed as a
 * function. Two implementations of one rule can disagree, and a disagreement
 * here is invisible in normal use because whichever path runs is the only one
 * that runs. These tests run both over the same documents and require the same
 * verdict, so the fast path cannot quietly accept a BOM the schema rejects.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { dirNameStr } from "../core/paths.js";
import { isValidIdnEmail } from "../parsers/email.js";

const repoRoot = dirNameStr;
const SPEC_VERSIONS = ["1.6", "1.7", "2.0"];

/**
 * Load the pre-compiled validator for a spec version.
 *
 * @param {string} specVersion
 * @returns {Promise<Function>}
 */
async function precompiledValidator(specVersion) {
  const mod = await import(`./generated/validate-${specVersion}.mjs`);
  return mod.default || mod.validate;
}

/**
 * Compile the validator for a spec version at runtime, the way bomValidator
 * does when the generated module is unavailable.
 *
 * @param {string} specVersion
 * @returns {Promise<Function>}
 */
async function runtimeValidator(specVersion) {
  const { default: Ajv } = await import("ajv");
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const { default: addFormats } = await import("ajv-formats");
  const dataDir = join(repoRoot, "data");
  const readJson = (f) => JSON.parse(readFileSync(join(dataDir, f), "utf-8"));
  const options = { strict: false, logger: false, verbose: true };

  const canonicalize = (value) => {
    if (value === null || typeof value !== "object") {
      return typeof value === "string"
        ? `s${value.length}:${value}`
        : `${typeof value}:${value}`;
    }
    if (Array.isArray(value)) {
      return `[${value.map(canonicalize).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `s${k.length}:${k}=${canonicalize(value[k])}`).join(",")}}`;
  };
  const useLinearUniqueItems = (ajv) => {
    ajv.removeKeyword("uniqueItems");
    ajv.addKeyword({
      keyword: "uniqueItems",
      type: "array",
      schemaType: "boolean",
      errors: false,
      error: { message: "must NOT have duplicate items" },
      validate: (schema, data) => {
        if (schema === false || !Array.isArray(data) || data.length < 2) {
          return true;
        }
        const seen = new Set();
        for (const item of data) {
          const key = canonicalize(item);
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
        }
        return true;
      },
    });
  };

  if (specVersion === "2.0") {
    const ajv = new Ajv2020(options);
    useLinearUniqueItems(ajv);
    addFormats(ajv);
    ajv.addFormat("idn-email", isValidIdnEmail);
    for (const [file, id] of [
      [
        "cyclonedx-2.0-cryptography-defs.schema.json",
        "https://cyclonedx.org/schema/cryptography-defs.schema.json",
      ],
      [
        "behavior-taxonomy.schema.json",
        "https://cyclonedx.org/schema/behavior-taxonomy.schema.json",
      ],
      [
        "jsf-0.82.schema.json",
        "https://cyclonedx.org/schema/jsf-0.82.schema.json",
      ],
      ["spdx.schema.json", "https://cyclonedx.org/schema/spdx.schema.json"],
    ]) {
      const bundled = { ...readJson(file) };
      delete bundled.$schema;
      bundled.$id = id;
      ajv.addSchema(bundled);
    }
    return ajv.compile(readJson("cyclonedx-2.0-bundled.schema.json"));
  }
  const schemas = [
    readJson(`bom-${specVersion}.schema.json`),
    readJson("jsf-0.82.schema.json"),
    readJson("spdx.schema.json"),
  ];
  if (specVersion === "1.7") {
    schemas.push(readJson("cryptography-defs.schema.json"));
  }
  const ajv = new Ajv({ ...options, schemas });
  useLinearUniqueItems(ajv);
  addFormats(ajv);
  ajv.addFormat("idn-email", isValidIdnEmail);
  return ajv.getSchema(
    `http://cyclonedx.org/schema/bom-${specVersion}.schema.json`,
  );
}

/** Collect the committed golden BOMs as a real-world corpus. */
function goldenBoms() {
  const boms = [];
  const repotests = join(repoRoot, "test", "repotests");
  let projects = [];
  try {
    projects = readdirSync(repotests, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (_e) {
    return boms;
  }
  for (const project of projects) {
    const expectedDir = join(repotests, project, "expected");
    let files = [];
    try {
      files = readdirSync(expectedDir).filter((f) => f.endsWith(".json"));
    } catch (_e) {
      continue;
    }
    for (const f of files) {
      try {
        const bom = JSON.parse(readFileSync(join(expectedDir, f), "utf-8"));
        if (bom?.bomFormat === "CycloneDX") {
          boms.push({ label: `${project}/${f}`, bom });
        }
      } catch (_e) {
        // A golden that is not parseable is another test's problem.
      }
    }
  }
  return boms;
}

/** A minimal BOM that both validators must accept. */
function baseBom(specVersion) {
  const dependencies = [
    { ref: "pkg:npm/app@1.0.0", dependsOn: ["pkg:npm/left-pad@1.3.0"] },
    { ref: "pkg:npm/left-pad@1.3.0", dependsOn: [] },
  ];
  const serialNumber = "urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79";
  if (specVersion !== "2.0") {
    return {
      bomFormat: "CycloneDX",
      specVersion,
      serialNumber,
      version: 1,
      metadata: {
        timestamp: "2026-08-04T00:00:00Z",
        component: {
          "bom-ref": "pkg:npm/app@1.0.0",
          type: "application",
          name: "app",
          version: "1.0.0",
          purl: "pkg:npm/app@1.0.0",
        },
      },
      components: [
        {
          "bom-ref": "pkg:npm/left-pad@1.3.0",
          type: "library",
          name: "left-pad",
          version: "1.3.0",
          purl: "pkg:npm/left-pad@1.3.0",
        },
      ],
      dependencies,
    };
  }
  // The 2.0 draft: specFormat root, one inventory with a subject, purls as
  // identifiers asserted by a declared party
  // (#/$defs/cyclonedx-component-2.0/$defs/identifiers).
  const identifiers = (purl) => [
    {
      party: "party-cdxgen",
      identities: [{ scheme: "purl", value: purl }],
    },
  ];
  return {
    specFormat: "CycloneDX",
    specVersion,
    serialNumber,
    version: 1,
    metadata: { timestamp: "2026-08-04T00:00:00Z" },
    definitions: {
      parties: [
        {
          refId: "party-cdxgen",
          roles: [{ role: "asserter" }],
          system: { kind: "automation", label: "cdxgen" },
        },
      ],
    },
    inventories: [
      {
        refId: "inventory-pkg:npm/app@1.0.0",
        subject: {
          refId: "pkg:npm/app@1.0.0",
          type: "application",
          name: "app",
          version: "1.0.0",
          identifiers: identifiers("pkg:npm/app@1.0.0"),
        },
        components: [
          {
            refId: "pkg:npm/left-pad@1.3.0",
            type: "library",
            name: "left-pad",
            version: "1.3.0",
            identifiers: identifiers("pkg:npm/left-pad@1.3.0"),
          },
        ],
      },
    ],
    dependencies,
  };
}

/** The document's top-level component list, whichever shape it uses. */
function bomEntries(bom) {
  return bom.components ?? bom.inventories[0].components;
}

describe("pre-compiled schema validators", () => {
  it("agree with the runtime-compiled validators on the golden corpus", async () => {
    const boms = goldenBoms();
    assert.ok(
      boms.length > 5,
      `expected a golden corpus to compare against, found ${boms.length}`,
    );
    const runtimeCache = new Map();
    const precompiledCache = new Map();
    let compared = 0;
    for (const { label, bom } of boms) {
      const specVersion = String(bom.specVersion);
      if (!SPEC_VERSIONS.includes(specVersion)) {
        continue;
      }
      if (!runtimeCache.has(specVersion)) {
        runtimeCache.set(specVersion, await runtimeValidator(specVersion));
        precompiledCache.set(
          specVersion,
          await precompiledValidator(specVersion),
        );
      }
      const runtime = runtimeCache.get(specVersion);
      const precompiled = precompiledCache.get(specVersion);
      assert.strictEqual(
        precompiled(bom),
        runtime(bom),
        `${label}: pre-compiled and runtime validators disagree`,
      );
      compared += 1;
    }
    assert.ok(compared > 5, `expected to compare BOMs, compared ${compared}`);
  });

  for (const specVersion of SPEC_VERSIONS) {
    it(`agree on accepting and rejecting documents for ${specVersion}`, async () => {
      const precompiled = await precompiledValidator(specVersion);
      const runtime = await runtimeValidator(specVersion);

      const duplicateComponents = baseBom(specVersion);
      bomEntries(duplicateComponents).length = 0;
      const firstEntry = structuredClone(baseBom(specVersion));
      bomEntries(duplicateComponents).push(
        ...bomEntries(firstEntry),
        ...bomEntries(firstEntry),
      );

      const duplicateDependsOn = baseBom(specVersion);
      duplicateDependsOn.dependencies[0].dependsOn = [
        "pkg:npm/left-pad@1.3.0",
        "pkg:npm/left-pad@1.3.0",
      ];

      const nestedDuplicate = baseBom(specVersion);
      bomEntries(nestedDuplicate)[0].components = [
        { type: "library", name: "inner", version: "1.0.0" },
        { type: "library", name: "inner", version: "1.0.0" },
      ];

      const distinctNested = baseBom(specVersion);
      bomEntries(distinctNested)[0].components = [
        { type: "library", name: "inner", version: "1.0.0" },
        { type: "library", name: "inner", version: "1.0.1" },
      ];

      const wrongType = baseBom(specVersion);
      bomEntries(wrongType)[0].type = "not-a-component-type";

      const missingRequired = baseBom(specVersion);
      delete bomEntries(missingRequired)[0].name;

      // `idn-email` is registered by cdxgen itself (ajv-formats lacks it), on
      // both paths; the generated code reaches it through runtime.mjs.
      const withContact = (email) => {
        const bom = baseBom(specVersion);
        bom.metadata.authors = [{ name: "ops", email }];
        return bom;
      };

      const cases = [
        ["valid baseline", baseBom(specVersion), true],
        ["duplicate components", duplicateComponents, false],
        ["duplicate dependsOn refs", duplicateDependsOn, false],
        ["duplicate nested components", nestedDuplicate, false],
        ["distinct nested components", distinctNested, true],
        ["invalid component type", wrongType, false],
        ["component missing name", missingRequired, false],
        ["valid contact email", withContact("ops@acme.example"), true],
        ["IDN contact email", withContact("δοκιμή@παράδειγμα.δοκιμή"), true],
        ["invalid contact email", withContact("plainly not an email"), false],
        ["contact email without a domain", withContact("ops@"), false],
      ];

      for (const [label, bom, expected] of cases) {
        const runtimeResult = runtime(bom);
        const precompiledResult = precompiled(bom);
        assert.strictEqual(
          precompiledResult,
          runtimeResult,
          `${specVersion} ${label}: pre-compiled=${precompiledResult} runtime=${runtimeResult}`,
        );
        assert.strictEqual(
          precompiledResult,
          expected,
          `${specVersion} ${label}: expected ${expected}`,
        );
      }
    });
  }
});
