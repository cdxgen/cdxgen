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
import { isValidDate, isValidDateTime, isValidUri } from "./formats.js";
import { withCanonicalKeys } from "./uniqueItems.js";

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
  const validate = mod.default || mod.validate;
  // Called the way validateBom() calls it, so the keys that stand in for long
  // values are compared with the plain serialisation of runtimeValidator().
  return (bom) => withCanonicalKeys(() => validate(bom));
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

      // Long enough for the pre-compiled path to compare keys instead of text.
      const longNestedDuplicate = baseBom(specVersion);
      bomEntries(longNestedDuplicate)[0].components = [
        { type: "library", name: "inner", description: "x".repeat(1000) },
        { type: "library", name: "inner", description: "x".repeat(1000) },
      ];

      const longDistinctNested = baseBom(specVersion);
      bomEntries(longDistinctNested)[0].components = [
        { type: "library", name: "inner", description: `${"x".repeat(999)}a` },
        { type: "library", name: "inner", description: `${"x".repeat(999)}b` },
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

      const withTimestamp = (timestamp) => {
        const bom = baseBom(specVersion);
        bom.metadata.timestamp = timestamp;
        return bom;
      };

      const cases = [
        ["valid baseline", baseBom(specVersion), true],
        [
          "timestamp with a positive offset",
          withTimestamp("2026-08-04T05:30:00+05:30"),
          true,
        ],
        [
          "timestamp with fractional seconds",
          withTimestamp("2026-08-04T00:00:00.123456Z"),
          true,
        ],
        [
          "timestamp on a leap second",
          withTimestamp("2016-12-31T23:59:60Z"),
          true,
        ],
        [
          "timestamp on a leap second with an offset",
          withTimestamp("2017-01-01T05:29:60+05:30"),
          true,
        ],
        [
          "timestamp on a false leap second",
          withTimestamp("2026-08-04T12:00:60Z"),
          false,
        ],
        [
          "timestamp without an offset",
          withTimestamp("2026-08-04T00:00:00"),
          false,
        ],
        [
          "timestamp on a day that does not exist",
          withTimestamp("2026-02-29T00:00:00Z"),
          false,
        ],
        [
          "timestamp with an hour of 24",
          withTimestamp("2026-08-04T24:00:00Z"),
          false,
        ],
        ["duplicate components", duplicateComponents, false],
        ["duplicate dependsOn refs", duplicateDependsOn, false],
        ["duplicate nested components", nestedDuplicate, false],
        ["distinct nested components", distinctNested, true],
        ["duplicate long nested components", longNestedDuplicate, false],
        ["distinct long nested components", longDistinctNested, true],
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

/**
 * `formats.js` replaces the ajv-formats checks the generated validators used
 * to call. Each case names the verdict the RFC gives, and where ajv-formats
 * (the reference loaded here) is lenient on purpose it is listed separately.
 */
describe("in-repo string formats", () => {
  /** @returns {Promise<Record<string, Function>>} The ajv-formats reference */
  async function referenceFormats() {
    const { default: addFormats } = await import("ajv-formats");
    const { default: Ajv } = await import("ajv");
    const ajv = new Ajv({ strict: false, logger: false });
    addFormats(ajv);
    const check = (name) => (value) => {
      const validate = ajv.compile({ type: "string", format: name });
      return validate(value);
    };
    return {
      date: check("date"),
      "date-time": check("date-time"),
      uri: check("uri"),
    };
  }

  const uriCases = [
    ["https://example.com/a/b?q=1#frag", true],
    ["http://[2001:db8::7]:8080/path", true],
    ["http://[::1]/", true],
    ["http://[v1.fe80::a+en1]/", true],
    ["ldap://[2001:db8::7]/c=GB?objectClass?one", true],
    ["http://user:pa%20ss@host.example:80/x", true],
    ["urn:isbn:0451450523", true],
    ["mailto:someone@example.com", true],
    ["file:///etc/hosts", true],
    ["pkg:npm/%40scope/name@1.0.0", true],
    ["http://example.com/%E2%82%AC", true],
    ["HTTP://EXAMPLE.COM/%e2%82%ac", true],
    ["http://example.com/a%2", false],
    ["http://example.com/a%zz", false],
    ["http://example.com/a b", false],
    ["http://[::1/", false],
    ["http://[:::1]/", false],
    ["http://[fe80::1%25eth0]/", false],
    ["http://example.com:80a/", false],
    ["http://exa mple.com/", false],
    ["http://example.com/#a#b", false],
    ["1http://example.com", false],
    ["//example.com/path", false],
    ["/relative/path", false],
    ["relative/path", false],
    ["../up", false],
    ["#fragment", false],
    ["", false],
  ];

  const ajvLenientUris = new Set(["http://example.com:80a/"]);

  const dateTimeCases = [
    ["2026-08-04T00:00:00Z", true],
    ["2026-08-04t00:00:00z", true],
    ["2026-08-04T00:00:00.5Z", true],
    ["2026-08-04T23:59:59-08:00", true],
    ["2026-08-04T05:30:00+05:30", true],
    ["2016-12-31T23:59:60Z", true],
    ["2016-12-31T15:59:60-08:00", true],
    ["2017-01-01T05:29:60+05:30", true],
    ["2016-12-31T23:58:60Z", false],
    ["2016-12-31T22:59:60Z", false],
    ["2024-02-29T00:00:00Z", true],
    ["2023-02-29T00:00:00Z", false],
    ["2026-13-01T00:00:00Z", false],
    ["2026-00-10T00:00:00Z", false],
    ["2026-08-04T24:00:00Z", false],
    ["2026-08-04T00:60:00Z", false],
    ["2026-08-04T00:00:61Z", false],
    ["2026-08-04T00:00:00", false],
    ["2026-08-04T00:00:00.Z", false],
    ["2026-08-04T00:00:00+24:00", false],
    ["2026-08-04T00:00:00+05:60", false],
    ["2026-08-04", false],
    ["not a timestamp", false],
    ["", false],
  ];

  it("accept and reject URIs as RFC 3986 does", async () => {
    const reference = await referenceFormats();
    for (const [value, expected] of uriCases) {
      assert.strictEqual(isValidUri(value), expected, `uri ${value}`);
      // ajv-formats takes `"` in a path and a malformed port; the RFC rejects
      // both, so those cases are not compared with it.
      if (ajvLenientUris.has(value)) {
        continue;
      }
      assert.strictEqual(
        isValidUri(value),
        reference.uri(value),
        `uri ${value}: in-repo and ajv-formats disagree`,
      );
    }
  });

  it("accept and reject date-times as RFC 3339 does", async () => {
    const reference = await referenceFormats();
    for (const [value, expected] of dateTimeCases) {
      assert.strictEqual(
        isValidDateTime(value),
        expected,
        `date-time ${value}`,
      );
      assert.strictEqual(
        isValidDateTime(value),
        reference["date-time"](value),
        `date-time ${value}: in-repo and ajv-formats disagree`,
      );
    }
  });

  it("accept and reject dates as RFC 3339 does", async () => {
    const reference = await referenceFormats();
    for (const [value, expected] of [
      ["2026-08-04", true],
      ["2024-02-29", true],
      ["2100-02-29", false],
      ["2000-02-29", true],
      ["2026-04-31", false],
      ["2026-8-4", false],
      ["20260804", false],
      ["", false],
    ]) {
      assert.strictEqual(isValidDate(value), expected, `date ${value}`);
      assert.strictEqual(isValidDate(value), reference.date(value), value);
    }
  });

  it("are stricter than ajv-formats about offsets without a colon", () => {
    // RFC 3339 requires `+HH:MM`; ajv-formats also takes `+HHMM` and `+HH`.
    assert.strictEqual(isValidDateTime("2026-08-04T00:00:00+0530"), false);
    assert.strictEqual(isValidDateTime("2026-08-04T00:00:00+05"), false);
  });
});
