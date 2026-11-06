import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { auditBom } from "../stages/postgen/auditBom.js";
import { postProcess } from "../stages/postgen/postgen.js";
import precompiled20 from "../validator/generated/validate-2.0.mjs";
import {
  formatReadLossNotice,
  loadBomForAnalysis,
  readCycloneDx20,
  renderCycloneDx20,
} from "./cyclonedx20.js";

// Absolute paths throughout: every spawned command runs with its cwd in a
// temporary directory, so nothing it writes (atom slices, flowsummary files,
// default outputs) lands in the repository.
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
// The pinned draft's example corpus (see
// test/data/cyclonedx-2.0-upstream/README.md).
const UPSTREAM_DIR = join(REPO_ROOT, "test", "data", "cyclonedx-2.0-upstream");
const READ_FIXTURE_DIR = join(REPO_ROOT, "test", "data", "cyclonedx-2.0-read");
const bin = (name) => join(REPO_ROOT, "bin", name);

/** Run a bin script with node from `cwd`, CDXGEN_NO_CACHE set. */
function runBin(name, args, cwd, extra = {}) {
  return spawnSync(process.execPath, [bin(name), ...args], {
    cwd,
    encoding: "utf-8",
    ...extra,
    env: { ...process.env, CDXGEN_NO_CACHE: "true", ...(extra.env || {}) },
  });
}

/** A fresh temporary working directory. */
const makeWorkDir = (label) => mkdtempSync(join(tmpdir(), `cdx20-${label}-`));

/** The stderr lines cdx-convert prints for a list of reader losses. */
const lossLines = (losses) =>
  losses.map((loss) => `  - ${loss.pointer || "(root)"}: ${loss.reason}`);

/** Assert every line is present in `text`. */
function assertLines(text, lines, label) {
  const missing = lines.filter((line) => !text.includes(line));
  assert.deepStrictEqual(
    missing,
    [],
    `${label}: every expected line is printed (output: ${text.slice(-1500)})`,
  );
}

/** Synthetic 1.x BOMs whose data triggers one audit rule pack each. */
const prop = (name, value) => ({ name, value });
const PARITY_PACKS = [
  {
    pack: "ai-bom",
    bom: () => ({
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      version: 1,
      metadata: {
        timestamp: "2026-01-01T00:00:00Z",
        lifecycles: [{ phase: "build" }],
      },
      components: [
        {
          "bom-ref": "file:/repo/prompts/release-prompt.yaml",
          name: "release-prompt.yaml",
          type: "file",
          properties: [
            prop("internal:SrcFile", "/repo/prompts/release-prompt.yaml"),
            prop("cdx:file:kind", "prompt-config-file"),
            prop("cdx:ai:source", "prompt-config"),
          ],
        },
      ],
    }),
  },
  {
    pack: "mcp-server",
    bom: () => ({
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      version: 1,
      metadata: { timestamp: "2026-01-01T00:00:00Z" },
      services: [
        {
          "bom-ref": "urn:service:mcp:fetch",
          name: "fetch",
          version: "1",
          endpoints: ["https://mcp.example/fetch"],
          authenticated: false,
          "x-trust-boundary": true,
          trustZone: "public",
          properties: [
            prop("cdx:mcp:transport", "streamable-http"),
            prop("cdx:mcp:capabilities:tools", "true"),
          ],
        },
      ],
    }),
  },
  {
    pack: "package-integrity",
    bom: () => ({
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      version: 1,
      metadata: { timestamp: "2026-01-01T00:00:00Z" },
      components: [
        {
          "bom-ref": "pkg:npm/evil-hook@1.0.0",
          name: "evil-hook",
          version: "1.0.0",
          type: "library",
          purl: "pkg:npm/evil-hook@1.0.0",
          properties: [prop("cdx:npm:hasInstallScript", "true")],
        },
      ],
    }),
  },
  {
    pack: "container-risk",
    bom: () => ({
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      version: 1,
      metadata: { timestamp: "2026-01-01T00:00:00Z" },
      components: [
        {
          "bom-ref": "pkg:generic/findutils@4.9",
          name: "find",
          version: "4.9",
          type: "file",
          purl: "pkg:generic/findutils@4.9",
          properties: [
            prop("cdx:gtfobins:matched", "true"),
            prop("cdx:gtfobins:functions", "shell,file-read"),
            prop("internal:has_setuid", "true"),
          ],
        },
      ],
    }),
  },
  {
    pack: "cbom-security",
    bom: () => ({
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      version: 1,
      metadata: { timestamp: "2026-01-01T00:00:00Z" },
      components: [
        {
          "bom-ref": "crypto/algorithm/md5",
          name: "md5",
          type: "cryptographic-asset",
          cryptoProperties: {
            assetType: "algorithm",
            oid: "1.3.14.3.2.26",
            algorithmProperties: {
              primitive: "hash",
              algorithmFamily: "MD5",
            },
          },
        },
      ],
    }),
  },
];

const findingSignature = (finding) =>
  `${finding.ruleId}|${finding.severity}|${JSON.stringify(finding.location ?? finding.purl ?? finding.bomRef ?? null)}`;

describe("audit parity between 1.x and read-back 2.0 documents", () => {
  for (const { pack, bom: makeBom } of PARITY_PACKS) {
    it(`finds the same ${pack} findings at 1.7 and through a 2.0 round trip`, async () => {
      const bom17 = makeBom();
      const findings17 = await auditBom(bom17, {
        bomAuditCategories: pack,
      });
      assert.ok(
        findings17.length > 0,
        `the synthetic ${pack} fixture must trigger at least one finding`,
      );
      const bom20 = renderCycloneDx20(structuredClone(bom17));
      assert.ok(precompiled20(bom20), "rendered document validates");
      const { internalBom, losses } = loadBomForAnalysis(bom20);
      assert.deepStrictEqual(losses, [], `${pack}: the round trip is lossless`);
      const findings20 = await auditBom(internalBom, {
        bomAuditCategories: pack,
      });
      assert.deepStrictEqual(
        findings20.map(findingSignature).sort(),
        findings17.map(findingSignature).sort(),
        `${pack} findings differ after the 2.0 round trip`,
      );
    });
  }

  it("reads the carried mcp-server service fields back with their 1.x types", () => {
    const bom17 = PARITY_PACKS.find(({ pack }) => pack === "mcp-server").bom();
    const bom20 = renderCycloneDx20(structuredClone(bom17));
    const { internalBom } = loadBomForAnalysis(bom20);
    // Booleans again (the mcp-server rules compare with === true/false), and
    // the carried properties are gone from the 1.x property list.
    assert.deepStrictEqual(internalBom.services, bom17.services);
  });
});

/** Pick upstream valid examples that cover the document's structural variety. */
function corpusSample() {
  const wanted = [
    /inventory/,
    /part(y|ies)/,
    /identifier/,
    /definitions/,
    /component-choice/,
    /risk/,
    /blueprint/,
    /behavior/,
    /annotation/,
    /composition/,
    /citation/,
    /formulation/,
    /vulnerability/,
    /hardware/,
    /physical/,
    /service/,
    /assembly/,
    /bom-2\.0/,
    /attestation/,
    /perspective/,
    /profile/,
    /declaration/,
    /weakness/,
    /control/,
    /threat/,
  ];
  const files = readdirSync(UPSTREAM_DIR)
    .filter((name) => name.startsWith("valid-") && name.endsWith(".json"))
    .sort();
  const picked = [];
  for (const pattern of wanted) {
    const match = files.find(
      (name) => pattern.test(name) && !picked.includes(name),
    );
    if (match) {
      picked.push(match);
    }
  }
  return picked;
}

// Upstream documents whose 1.7 conversion is schema-valid but fails cdxgen's
// deep checks for content the source document has; shared with
// cyclonedx20Read.poku.js.
const { $comment: _deepCheckComment, ...DEEP_CHECK_EXCEPTIONS } = JSON.parse(
  readFileSync(join(READ_FIXTURE_DIR, "deep-check-exceptions.json"), "utf-8"),
);

describe("commands accept upstream 2.0 documents", () => {
  const sample = corpusSample();
  it("selects a corpus sample that covers the structural variety", () => {
    assert.ok(sample.length >= 20, `expected 20+ files, got ${sample.length}`);
    assert.ok(
      sample.some((name) => Object.hasOwn(DEEP_CHECK_EXCEPTIONS, name)),
      "the sample includes a deep-check exception, so that branch is exercised",
    );
  });

  for (const name of sample) {
    it(`cdx-validate accepts ${name}`, () => {
      const workDir = makeWorkDir("validate");
      // Schema-only: the deep SCVS/BOM rules report real findings on the
      // upstream examples, which is not what this smoke checks.
      const result = runBin(
        "validate.js",
        ["-i", join(UPSTREAM_DIR, name), "--no-deep"],
        workDir,
      );
      rmSync(workDir, { recursive: true, force: true });
      // Exit 3 is compliance findings at or above --fail-severity (the
      // upstream examples legitimately trip SCVS-1.1); only a configuration
      // error (1) or schema failure (2) means the reader could not handle
      // the document.
      assert.ok(
        result.status === 0 || result.status === 3,
        `${name}: cdx-validate exited ${result.status}: ${result.stderr || result.stdout}`,
      );
    });
  }

  it("cdx-audit and cdx-convert (validating) run over the corpus sample and print every loss", () => {
    const workDir = makeWorkDir("reader-smoke");
    let withLosses = 0;
    let deepExceptions = 0;
    for (const name of sample) {
      const input = join(UPSTREAM_DIR, name);
      const { losses } = readCycloneDx20(
        JSON.parse(readFileSync(input, "utf-8")),
      );
      const audit = runBin(
        "audit.js",
        [
          "--bom",
          input,
          "--direct-bom-audit",
          "--no-ai-provenance",
          "--report",
          "json",
        ],
        workDir,
      );
      assert.strictEqual(
        audit.status,
        0,
        `${name}: cdx-audit exited ${audit.status}: ${audit.stderr?.slice(-300)}`,
      );
      JSON.parse(audit.stdout);
      if (losses.length) {
        withLosses++;
        assert.ok(
          audit.stderr.includes(formatReadLossNotice(losses)),
          `${name}: cdx-audit prints the loss count on stderr`,
        );
      }
      const output = join(workDir, `${name}.17.json`);
      const convert = runBin(
        "convert.js",
        ["-i", input, "--to", "1.7", "-o", output],
        workDir,
      );
      if (losses.length) {
        assertLines(
          convert.stderr,
          [
            `Reading the CycloneDX 2.0 input into cdxgen's 1.x model reported ${losses.length} loss(es); the CycloneDX 1.7 output lacks what they name:`,
            ...lossLines(losses),
          ],
          name,
        );
      } else {
        assert.ok(
          !convert.stderr.includes("Reading the CycloneDX 2.0 input"),
          `${name}: no loss notice without losses`,
        );
      }
      if (Object.hasOwn(DEEP_CHECK_EXCEPTIONS, name)) {
        deepExceptions++;
        assert.strictEqual(
          convert.status,
          1,
          `${name}: ${DEEP_CHECK_EXCEPTIONS[name]}`,
        );
        assert.ok(
          convert.stderr.includes(
            "CycloneDX 1.7 validation failed for the converted output.",
          ),
          `${name}: fails validation, not something else`,
        );
        assert.ok(!existsSync(output), `${name}: nothing written`);
        continue;
      }
      assert.strictEqual(
        convert.status,
        0,
        `${name}: cdx-convert exited ${convert.status}: ${convert.stderr?.slice(-300)}`,
      );
      const bom17 = JSON.parse(readFileSync(output, "utf-8"));
      assert.strictEqual(bom17.specVersion, "1.7", `${name}: specVersion`);
    }
    rmSync(workDir, { recursive: true, force: true });
    assert.ok(withLosses > 0, "some sampled documents report losses");
    assert.ok(deepExceptions > 0, "some sampled documents are deep exceptions");
  });
});

/** A 2.0 document with one carried 2.0-only section (`risks`). */
function bom20WithRisks() {
  const bom20 = renderCycloneDx20({
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    version: 1,
    metadata: { timestamp: "2026-01-01T00:00:00Z" },
    components: [
      {
        "bom-ref": "pkg:npm/a@1.0.0",
        name: "a",
        version: "1.0.0",
        type: "library",
        purl: "pkg:npm/a@1.0.0",
      },
    ],
    dependencies: [],
  });
  bom20.risks = {
    risks: [
      {
        refId: "risk-1",
        name: "demo risk",
        statement: "A carried 2.0 section",
      },
    ],
  };
  return bom20;
}

describe("cdx-audit on a 2.0 input", () => {
  for (const report of ["json", "sarif"]) {
    it(`keeps --report ${report} stdout parseable and prints the loss count on stderr`, () => {
      const workDir = makeWorkDir("audit-report");
      const input = join(workDir, "risks-2.0.json");
      const bom20 = bom20WithRisks();
      writeFileSync(input, JSON.stringify(bom20));
      const { losses } = readCycloneDx20(bom20);
      assert.deepStrictEqual(
        losses.map((loss) => loss.pointer),
        ["/risks"],
      );
      const result = runBin(
        "audit.js",
        [
          "--bom",
          input,
          "--direct-bom-audit",
          "--no-ai-provenance",
          "--report",
          report,
        ],
        workDir,
      );
      rmSync(workDir, { recursive: true, force: true });
      assert.strictEqual(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      if (report === "sarif") {
        assert.strictEqual(parsed.version, "2.1.0");
        assert.ok(Array.isArray(parsed.runs));
      } else {
        assert.ok(parsed && typeof parsed === "object");
      }
      assert.ok(!result.stdout.includes("CycloneDX 2.0 input"));
      assert.ok(
        result.stderr.includes(
          "CycloneDX 2.0 input: reading it into the 1.x model reported 1 loss;",
        ),
        result.stderr,
      );
      assert.ok(!result.stderr.includes("section(s)"));
    });
  }
});

describe("cdxi on a 2.0 input", () => {
  it("loads bin/repl.js and imports a 2.0 document through the internal model", () => {
    const workDir = makeWorkDir("repl");
    const input = join(workDir, "risks-2.0.json");
    writeFileSync(input, JSON.stringify(bom20WithRisks()));
    const result = runBin("repl.js", [input], workDir, {
      input: ".exit\n",
      timeout: 60000,
      env: { CDXGEN_REPL_HISTORY: join(workDir, "history") },
    });
    rmSync(workDir, { recursive: true, force: true });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const output = `${result.stdout}${result.stderr}`;
    assert.ok(!output.includes("does not provide an export"), output);
    assert.ok(
      output.includes(`SBOM imported successfully from ${input}`),
      output,
    );
    assert.ok(
      output.includes(
        "CycloneDX 2.0 input: reading it into the 1.x model reported 1 loss;",
      ),
      output,
    );
  });
});

/**
 * SBOM components of a 2.0 document: the inventory's, or the definitions
 * components of a subject-less document.
 */
const inventoryComponents = (bom20) =>
  bom20.inventories
    ? bom20.inventories.flatMap((inventory) => inventory.components ?? [])
    : (bom20.definitions?.components ?? []);

describe("cdx-convert at the 2.0 boundary", () => {
  const smokeBom = join(
    REPO_ROOT,
    "test",
    "repotests",
    "cbom-js-smoke",
    "expected",
    "default.json",
  );

  it("upgrades a 1.7 document to a valid 2.0 document, sorted as cdxgen sorts", () => {
    const workDir = makeWorkDir("convert-upgrade");
    const output = join(workDir, "upgraded.json");
    const result = runBin(
      "convert.js",
      ["-i", smokeBom, "--to", "2.0", "-o", output],
      workDir,
    );
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const bom20 = JSON.parse(readFileSync(output, "utf-8"));
    assert.strictEqual(bom20.specFormat, "CycloneDX");
    assert.ok(precompiled20(bom20), "the upgraded document validates");
    // The same input with each component's properties reversed converts to the same document: cdx-convert sorts
    // (sortBomCollections) before it renders, as postProcess does.
    const reversed = JSON.parse(readFileSync(smokeBom, "utf-8"));
    assert.ok(
      reversed.components.some((component) => component.properties?.length > 1),
    );
    for (const component of reversed.components) {
      component.properties?.reverse();
    }
    const reversedInput = join(workDir, "reversed.json");
    writeFileSync(reversedInput, JSON.stringify(reversed));
    const reversedOutput = join(workDir, "reversed-2.0.json");
    const again = runBin(
      "convert.js",
      ["-i", reversedInput, "--to", "2.0", "-o", reversedOutput],
      workDir,
    );
    assert.strictEqual(again.status, 0, again.stderr || again.stdout);
    assert.deepStrictEqual(
      JSON.parse(readFileSync(reversedOutput, "utf-8")),
      bom20,
    );
    rmSync(workDir, { recursive: true, force: true });
  });

  it("reports renderer drops at --to 2.0 and fails on them with --fail-on-loss", () => {
    const workDir = makeWorkDir("convert-drops");
    const input = join(workDir, "service-flow-1.7.json");
    writeFileSync(
      input,
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.7",
        version: 1,
        metadata: { timestamp: "2026-01-01T00:00:00Z" },
        services: [
          {
            "bom-ref": "urn:service:api",
            name: "api",
            data: [{ flow: "outbound", classification: "PII" }],
          },
        ],
      }),
    );
    const output = join(workDir, "out-2.0.json");
    const result = runBin(
      "convert.js",
      ["-i", input, "--to", "2.0", "-o", output],
      workDir,
    );
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assertLines(
      result.stderr,
      [
        "Rendering CycloneDX 2.0 dropped 1 value(s) the 2.0 format has no place for:",
        "  - service.data.flow ×1",
      ],
      "renderer drops",
    );
    assert.ok(precompiled20(JSON.parse(readFileSync(output, "utf-8"))));
    const failOutput = join(workDir, "fail-2.0.json");
    const failed = runBin(
      "convert.js",
      ["-i", input, "--to", "2.0", "--fail-on-loss", "-o", failOutput],
      workDir,
    );
    assert.strictEqual(failed.status, 2, failed.stderr);
    assert.ok(
      failed.stderr.includes(
        "--fail-on-loss is set and the conversion lost data (1 loss(es) above).",
      ),
      failed.stderr,
    );
    assert.ok(!existsSync(failOutput), "nothing written on --fail-on-loss");
    rmSync(workDir, { recursive: true, force: true });
  });

  it("refuses --to 2.0 for input older than 1.6", () => {
    const workDir = makeWorkDir("convert-old");
    const input = join(workDir, "old-1.5.json");
    writeFileSync(
      input,
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        version: 1,
        components: [],
      }),
    );
    const output = join(workDir, "out.json");
    const result = runBin(
      "convert.js",
      ["-i", input, "--to", "2.0", "-o", output],
      workDir,
    );
    assert.strictEqual(result.status, 1);
    assert.ok(
      result.stderr.includes(
        `cdx-convert --to 2.0 reads CycloneDX 1.6, 1.7 or 2.0 input, and '${input}' is CycloneDX 1.5.`,
      ),
      result.stderr,
    );
    assert.ok(!existsSync(output));
    const unsupported = runBin(
      "convert.js",
      ["-i", input, "--to", "next", "-o", output],
      workDir,
    );
    assert.strictEqual(unsupported.status, 1);
    assert.ok(
      unsupported.stderr.includes("such as 1.5, 1.6, 1.7 or 2.0."),
      unsupported.stderr,
    );
    rmSync(workDir, { recursive: true, force: true });
  });

  it("downgrades a 2.0 document, prints the losses and honours --fail-on-loss", () => {
    const workDir = makeWorkDir("convert-downgrade");
    const input = join(workDir, "source-2.0.json");
    const bom20 = bom20WithRisks();
    writeFileSync(input, JSON.stringify(bom20));
    const { losses } = readCycloneDx20(bom20);
    assert.deepStrictEqual(losses, [
      {
        pointer: "/risks",
        reason:
          "2.0-only section with no 1.x field: dropped from 1.x and SPDX output (a 2.0 render of the read model keeps it)",
      },
    ]);
    const expectedLines = [
      "Reading the CycloneDX 2.0 input into cdxgen's 1.x model reported 1 loss(es); the CycloneDX 1.7 output lacks what they name:",
      ...lossLines(losses),
    ];
    const output = join(workDir, "downgraded.json");
    const result = runBin(
      "convert.js",
      ["-i", input, "--to", "1.7", "-o", output],
      workDir,
    );
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assertLines(result.stderr, expectedLines, "downgrade");
    const bom17 = JSON.parse(readFileSync(output, "utf-8"));
    assert.strictEqual(bom17.specVersion, "1.7");
    assert.deepStrictEqual(
      bom17.components.map((component) => component["bom-ref"]),
      ["pkg:npm/a@1.0.0"],
    );
    assert.ok(!JSON.stringify(bom17).includes("cdx20Sections"));
    assert.ok(!Object.hasOwn(bom17, "risks"));
    const failOutput = join(workDir, "failed.json");
    const failResult = runBin(
      "convert.js",
      ["-i", input, "--to", "1.7", "--fail-on-loss", "-o", failOutput],
      workDir,
    );
    assert.strictEqual(failResult.status, 2, "--fail-on-loss exits non-zero");
    assertLines(
      failResult.stderr,
      [
        ...expectedLines,
        "--fail-on-loss is set and the conversion lost data (1 loss(es) above).",
      ],
      "downgrade --fail-on-loss",
    );
    assert.ok(!existsSync(failOutput), "nothing written on --fail-on-loss");
    // The SPDX export prints the same losses.
    const spdx = runBin(
      "convert.js",
      ["-i", input, "-o", join(workDir, "out.spdx.json")],
      workDir,
    );
    assert.strictEqual(spdx.status, 0, spdx.stderr);
    assertLines(
      spdx.stderr,
      [
        "Reading the CycloneDX 2.0 input into cdxgen's 1.x model reported 1 loss(es); the SPDX 3.0.1 export lacks what they name:",
        ...lossLines(losses),
      ],
      "spdx",
    );
    rmSync(workDir, { recursive: true, force: true });
  });

  it("prints the reader losses at 2.0 → 2.0 and fails only on what the output lacks", () => {
    const workDir = makeWorkDir("convert-same");
    const input = join(workDir, "source-2.0.json");
    const bom20 = bom20WithRisks();
    writeFileSync(input, JSON.stringify(bom20));
    const { losses } = readCycloneDx20(bom20);
    const output = join(workDir, "same-2.0.json");
    const result = runBin(
      "convert.js",
      ["-i", input, "--to", "2.0", "--fail-on-loss", "-o", output],
      workDir,
    );
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assertLines(
      result.stderr,
      [
        "Reading the CycloneDX 2.0 input into cdxgen's 1.x model reported 1 loss(es); the 2.0 output keeps what the read model carries for 2.0, and any difference is reported below:",
        ...lossLines(losses),
      ],
      "2.0 to 2.0",
    );
    assert.ok(!result.stderr.includes("lacks"), result.stderr);
    assert.deepStrictEqual(JSON.parse(readFileSync(output, "utf-8")), bom20);
    // Two inventories have no 1.x form: the second subject becomes a root
    // component, so the 2.0 output really lacks values of the input.
    const multi = join(
      UPSTREAM_DIR,
      "valid-inventory-multi-product-shared-2.0.json",
    );
    const multiOutput = join(workDir, "multi-2.0.json");
    const multiResult = runBin(
      "convert.js",
      ["-i", multi, "--to", "2.0", "--fail-on-loss", "-o", multiOutput],
      workDir,
    );
    assert.strictEqual(multiResult.status, 2, multiResult.stderr);
    assertLines(
      multiResult.stderr,
      [
        "The CycloneDX 2.0 output lacks 2 value(s) of the input (member order ignored):",
        '  - inventories.subject.ref="acme-controller"',
        "--fail-on-loss is set and the conversion lost data (2 loss(es) above).",
      ],
      "multi-inventory",
    );
    assert.ok(!existsSync(multiOutput));
    rmSync(workDir, { recursive: true, force: true });
  });
});

describe("postProcess render gate", () => {
  const model = () => ({
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    version: 1,
    metadata: { timestamp: "2026-01-01T00:00:00Z" },
    components: [
      {
        "bom-ref": "pkg:npm/a@1.0.0",
        name: "a",
        version: "1.0.0",
        type: "library",
        purl: "pkg:npm/a@1.0.0",
      },
    ],
    dependencies: [{ ref: "pkg:npm/a@1.0.0", dependsOn: [] }],
  });

  it("follows the specVersion of an internal model read from 2.0 when the caller passes none", async () => {
    const { internalBom } = loadBomForAnalysis(renderCycloneDx20(model()));
    assert.strictEqual(internalBom.specVersion, "2.0");
    // The internal model goes through loadBomForAnalysis unchanged, the way
    // createEvinseFile reads it.
    assert.strictEqual(
      loadBomForAnalysis(internalBom).internalBom,
      internalBom,
    );
    const result = await postProcess({ bomJson: internalBom }, {});
    assert.strictEqual(result.bomJson.specFormat, "CycloneDX");
    assert.strictEqual(result.bomJson.specVersion, "2.0");
    assert.ok(precompiled20(result.bomJson), "the rendered document validates");
    assert.deepStrictEqual(
      inventoryComponents(result.bomJson).map((component) => component.refId),
      ["pkg:npm/a@1.0.0"],
    );
    assert.ok(Array.isArray(result.internalBomJson.components));
  });

  it("leaves a 1.7 document at 1.7 when the caller passes none", async () => {
    const result = await postProcess({ bomJson: model() }, {});
    assert.strictEqual(result.bomJson.specVersion, "1.7");
    assert.ok(!result.internalBomJson);
  });
});

// Runs prepareDB and analyzeProject over the inputs named on the command
// line and prints, per input, how many components the evinse loader read and
// how many purls analyzeProject located. Before the single conversion, a
// 2.0 input gave both functions an empty component list.
const ANALYZE_SCRIPT = `
  const { analyzeProject, loadEvinseInputBom, prepareDB } = await import(
    ${JSON.stringify(join(REPO_ROOT, "lib", "evinser", "evinser.js"))}
  );
  const [projectDir, ...inputs] = process.argv.slice(1);
  const out = {};
  for (const spec of inputs) {
    const [input, mode] = spec.split("::");
    const options = { _: [projectDir], input, output: input + ".out", language: "js" };
    if (mode === "model") {
      options.inputBomJson = loadEvinseInputBom({ input }).bomJson;
    }
    const dbObjMap = await prepareDB(options);
    const artefacts = await analyzeProject(dbObjMap, options);
    out[spec] = {
      components: loadEvinseInputBom(options).bomJson.components?.length ?? 0,
      purlLocations: Object.keys(artefacts.purlLocationMap || {}).length,
    };
  }
  process.stdout.write("RESULT " + JSON.stringify(out) + "\\n");
`;

describe("evinse accepts a 2.0 input", () => {
  const fixture = join(REPO_ROOT, "test", "data", "svelte-precision");
  const workDir = makeWorkDir("evinse");
  const out17 = join(workDir, "bom-1.7.json");
  const out20 = join(workDir, "bom-2.0.json");
  const evinseCount = (bom) =>
    (bom.components ?? inventoryComponents(bom)).reduce(
      (sum, component) =>
        sum +
        (component.evidence?.identity?.length || 0) +
        (component.evidence?.occurrences?.length || 0),
      0,
    );

  it("generates the 1.7 and 2.0 inputs", () => {
    for (const [version, output] of [
      ["1.7", out17],
      ["2.0", out20],
    ]) {
      const result = runBin(
        "cdxgen.js",
        [fixture, "--spec-version", version, "-o", output],
        workDir,
      );
      assert.strictEqual(result.status, 0, result.stderr?.slice(-300));
    }
  });

  it("gives prepareDB and analyzeProject the components of a 2.0 input", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        ANALYZE_SCRIPT,
        fixture,
        out17,
        out20,
        `${out20}::model`,
      ],
      {
        cwd: workDir,
        encoding: "utf-8",
        env: { ...process.env, CDXGEN_NO_CACHE: "true" },
        timeout: 240000,
      },
    );
    const line = result.stdout
      .split("\n")
      .find((entry) => entry.startsWith("RESULT "));
    assert.ok(
      line,
      `${result.stderr?.slice(-400)}${result.stdout?.slice(-400)}`,
    );
    const counts = JSON.parse(line.slice("RESULT ".length));
    const at17 = counts[out17];
    assert.ok(at17.components > 0, JSON.stringify(counts));
    assert.ok(at17.purlLocations > 0, JSON.stringify(counts));
    assert.deepStrictEqual(counts[out20], at17, "2.0 file input");
    assert.deepStrictEqual(counts[`${out20}::model`], at17, "inputBomJson");
  });

  it("writes a valid 2.0 document whose evidence matches the 1.7 run", () => {
    const evinse = (input, output) =>
      runBin(
        "evinse.js",
        ["-i", input, "-o", output, "-l", "js", "--include-crypto", fixture],
        workDir,
        { timeout: 240000 },
      );
    const evinsed20 = join(workDir, "evinse-2.0.json");
    const evinsed17 = join(workDir, "evinse-1.7.json");
    const run20 = evinse(out20, evinsed20);
    assert.strictEqual(
      run20.status,
      0,
      run20.stderr?.slice(-400) || run20.stdout?.slice(-400),
    );
    const run17 = evinse(out17, evinsed17);
    assert.strictEqual(run17.status, 0, run17.stderr?.slice(-400));
    const result20 = JSON.parse(readFileSync(evinsed20, "utf-8"));
    const result17 = JSON.parse(readFileSync(evinsed17, "utf-8"));
    assert.strictEqual(result20.specFormat, "CycloneDX");
    assert.ok(precompiled20(result20), "evinse 2.0 output validates");
    assert.strictEqual(
      inventoryComponents(result20).length,
      result17.components.length,
    );
    const count17 = evinseCount(result17);
    assert.ok(count17 > 0, "the 1.7 run has evidence");
    assert.strictEqual(
      evinseCount(result20),
      count17,
      "evidence volume matches the 1.7 run",
    );
    // A cdxgen-generated 2.0 document reads without losses, so no notice.
    assert.ok(!run20.stdout.includes("CycloneDX 2.0 input:"), run20.stdout);
    // atom ran with its cwd in the temporary directory.
    assert.deepStrictEqual(
      readdirSync(REPO_ROOT).filter((name) => name.startsWith("flowsummary-")),
      [],
    );
  });

  it("cleans up", () => {
    rmSync(workDir, { recursive: true, force: true });
  });
});
