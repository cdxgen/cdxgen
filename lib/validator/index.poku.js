import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { signBom } from "../helpers/bomSigner.js";
import { renderCycloneDx20 } from "../inventory/cyclonedx20.js";
import { shouldFail, validateBomAdvanced } from "./index.js";

function richBom() {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: "urn:uuid:1b671687-395b-41f5-a30f-a58921a69b79",
    version: 1,
    metadata: {
      timestamp: "2024-02-02T00:00:00Z",
      tools: {
        components: [
          { type: "application", name: "cdxgen", version: "12.0.0" },
        ],
      },
      component: {
        name: "demo",
        version: "1.0.0",
        type: "application",
        "bom-ref": "pkg:generic/demo@1.0.0",
      },
      supplier: {
        name: "Acme",
        contact: [{ email: "psirt@example.com" }],
      },
    },
    components: [
      {
        type: "library",
        name: "lodash",
        version: "4.17.21",
        purl: "pkg:npm/lodash@4.17.21",
        "bom-ref": "pkg:npm/lodash@4.17.21",
        licenses: [{ license: { id: "MIT" } }],
        hashes: [{ alg: "SHA-256", content: "x" }],
        copyright: "© OpenJS",
      },
    ],
    dependencies: [
      { ref: "pkg:generic/demo@1.0.0", dependsOn: ["pkg:npm/lodash@4.17.21"] },
      { ref: "pkg:npm/lodash@4.17.21", dependsOn: [] },
    ],
  };
}

describe("validateBomAdvanced", () => {
  it("accepts CycloneDX 2.0-dev root fields in compliance evaluation", async () => {
    const bom20 = richBom();
    delete bom20.bomFormat;
    bom20.specFormat = "CycloneDX";
    bom20.specVersion = "2.0";
    const report = await validateBomAdvanced(bom20, { schema: false });
    assert.strictEqual(
      report.allFindings.some((finding) =>
        /bomFormat\/specVersion missing/.test(finding.message),
      ),
      false,
    );
  });

  it("returns structural, compliance, and benchmark data", async () => {
    const report = await validateBomAdvanced(richBom(), { schema: false });
    assert.strictEqual(typeof report.schemaValid, "boolean");
    assert.strictEqual(typeof report.deepValid, "boolean");
    assert.ok(Array.isArray(report.findings));
    assert.ok(Array.isArray(report.allFindings));
    assert.ok(Array.isArray(report.benchmarks));
    assert.ok(report.summary);
    assert.strictEqual(report.summary.schemaValid, report.schemaValid);
    assert.strictEqual(report.summary.deepValid, report.deepValid);
  });

  it("surfaces validator exceptions instead of hiding them", async () => {
    const bom = richBom();
    bom.dependencies = [null];
    const report = await validateBomAdvanced(bom, { schema: false });
    assert.strictEqual(report.deepValid, false);
    assert.strictEqual(report.validationErrors.length, 1);
    assert.strictEqual(report.validationErrors[0].stage, "deep");
    assert.ok(report.validationErrors[0].message);
  });

  it("reports no validation errors for a well-formed BOM", async () => {
    const report = await validateBomAdvanced(richBom(), { schema: false });
    assert.deepStrictEqual(report.validationErrors, []);
  });

  it("hides pass findings by default but includes manual", async () => {
    const report = await validateBomAdvanced(richBom(), { schema: false });
    for (const f of report.findings) {
      assert.notStrictEqual(f.status, "pass");
    }
    assert.ok(report.findings.some((f) => f.status === "manual"));
  });

  it("respects minSeverity filter", async () => {
    const report = await validateBomAdvanced(richBom(), {
      schema: false,
      minSeverity: "high",
      includeManual: true,
    });
    for (const f of report.findings) {
      assert.ok(["high", "critical"].includes(f.severity));
    }
  });

  it("marks signatureVerified=false when public key given but BOM unsigned", async () => {
    const report = await validateBomAdvanced(richBom(), {
      schema: false,
      publicKey: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
    });
    assert.strictEqual(report.signatureVerified, false);
    assert.ok(report.signatureDetails?.error);
  });

  it("verifies a signed BOM with its public key", async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const bom = signBom(richBom(), { privateKey, algorithm: "Ed25519" });
    const report = await validateBomAdvanced(bom, {
      schema: false,
      publicKey,
    });
    assert.strictEqual(report.signatureVerified, true);
    assert.strictEqual(report.signatureDetails.algorithm, "Ed25519");
  });

  it("rejects an HMAC signature keyed with the public key", async () => {
    const { publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const forged = signBom(richBom(), {
      privateKey: crypto.createSecretKey(Buffer.from(publicKey)),
      algorithm: "HS256",
    });
    const report = await validateBomAdvanced(forged, {
      schema: false,
      publicKey,
    });
    assert.strictEqual(report.signatureVerified, false);
    assert.match(report.signatureDetails.error, /requires a shared secret/);
    assert.strictEqual(
      shouldFail(report, { requireSignature: true }).shouldFail,
      true,
    );
  });

  it("verifies an HMAC signature only with secretKey", async () => {
    const secret = crypto.randomBytes(32);
    const bom = signBom(richBom(), { privateKey: secret, algorithm: "HS512" });
    const withSecret = await validateBomAdvanced(bom, {
      schema: false,
      secretKey: secret,
    });
    assert.strictEqual(withSecret.signatureVerified, true);
    const wrongSecret = await validateBomAdvanced(bom, {
      schema: false,
      secretKey: crypto.randomBytes(32),
    });
    assert.strictEqual(wrongSecret.signatureVerified, false);
    assert.match(
      wrongSecret.signatureDetails.error,
      /does not verify with this key/,
    );
  });

  it("verifies nested signatures unless nestedSignatures is false", async () => {
    const keys = (type, options = {}) =>
      crypto.generateKeyPairSync(type, {
        ...options,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
    const builder = keys("ed25519");
    const auditor = keys("ec", { namedCurve: "prime256v1" });
    const bom = signBom(richBom(), {
      privateKey: builder.privateKey,
      algorithm: "Ed25519",
    });
    signBom(bom, {
      privateKey: auditor.privateKey,
      algorithm: "ES256",
      mode: "signers",
    });
    const deep = await validateBomAdvanced(bom, {
      schema: false,
      publicKey: auditor.publicKey,
    });
    assert.strictEqual(deep.signatureVerified, false);
    assert.match(deep.signatureDetails.error, /^components\[0\]/);
    const rootOnly = await validateBomAdvanced(bom, {
      schema: false,
      publicKey: auditor.publicKey,
      nestedSignatures: false,
    });
    assert.strictEqual(rootOnly.signatureVerified, true);
    const builderDeep = await validateBomAdvanced(bom, {
      schema: false,
      publicKey: builder.publicKey,
    });
    assert.strictEqual(builderDeep.signatureVerified, true);
  });

  it("reports every root signature entry and whether it verified", async () => {
    const keys = (type, options = {}) =>
      crypto.generateKeyPairSync(type, {
        ...options,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
    const builder = keys("ed25519");
    const auditor = keys("ec", { namedCurve: "prime256v1" });
    const bom = signBom(richBom(), {
      privateKey: builder.privateKey,
      algorithm: "Ed25519",
      keyId: "builder",
      mode: "signers",
    });
    signBom(bom, {
      privateKey: auditor.privateKey,
      algorithm: "ES256",
      keyId: "auditor",
      mode: "signers",
    });
    const report = await validateBomAdvanced(bom, {
      schema: false,
      publicKey: builder.publicKey,
    });
    assert.strictEqual(report.signatureVerified, true);
    assert.deepStrictEqual(report.signatureEntries, [
      { index: 0, algorithm: "Ed25519", keyId: "builder", verified: true },
      { index: 1, algorithm: "ES256", keyId: "auditor", verified: false },
    ]);
  });

  it("rejects a signed root that is not shaped like a BOM", async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const bom = signBom(richBom(), { privateKey, algorithm: "Ed25519" });
    bom.name = "not a BOM member";
    for (const nestedSignatures of [true, false]) {
      const report = await validateBomAdvanced(bom, {
        schema: false,
        publicKey,
        nestedSignatures,
      });
      assert.strictEqual(report.signatureVerified, false);
      assert.match(
        report.signatureDetails.error,
        /does not define at the root of a BOM: name/,
      );
    }
  });

  it("returns signatureVerified=null when no public key supplied", async () => {
    const report = await validateBomAdvanced(richBom(), { schema: false });
    assert.strictEqual(report.signatureVerified, null);
  });
});

describe("shouldFail", () => {
  const fakeReport = (opts) => ({
    schemaValid: opts.schemaValid ?? true,
    deepValid: opts.deepValid ?? true,
    signatureVerified: opts.signatureVerified ?? null,
    allFindings: opts.findings || [],
  });

  it("fails on any finding at or above fail-severity", () => {
    const r = fakeReport({
      findings: [{ status: "fail", severity: "high", ruleId: "X" }],
    });
    const { shouldFail: f } = shouldFail(r, { failSeverity: "high" });
    assert.strictEqual(f, true);
  });

  it("does not fail when severity is below threshold", () => {
    const r = fakeReport({
      findings: [{ status: "fail", severity: "low", ruleId: "X" }],
    });
    const { shouldFail: f } = shouldFail(r, { failSeverity: "high" });
    assert.strictEqual(f, false);
  });

  it("fails in strict mode on schema invalid", () => {
    const r = fakeReport({ schemaValid: false });
    assert.strictEqual(
      shouldFail(r, { strict: true, failSeverity: "critical" }).shouldFail,
      true,
    );
  });

  it("fails when signature required but verification failed", () => {
    const r = fakeReport({ signatureVerified: false });
    const { shouldFail: f, reason } = shouldFail(r, {
      requireSignature: true,
      failSeverity: "critical",
    });
    assert.strictEqual(f, true);
    assert.match(reason, /Signature/);
  });

  it("fails when signature required but nothing was verified", () => {
    const r = fakeReport({ signatureVerified: null });
    const { shouldFail: f, reason } = shouldFail(r, {
      requireSignature: true,
      failSeverity: "critical",
    });
    assert.strictEqual(f, true);
    assert.match(reason, /signature is required/);
  });

  it("ignores signature when not required", () => {
    const r = fakeReport({ signatureVerified: false });
    assert.strictEqual(
      shouldFail(r, { failSeverity: "critical" }).shouldFail,
      false,
    );
  });
});

describe("validateBomAdvanced() on CycloneDX 2.0 input", () => {
  const readFixture = (...parts) =>
    JSON.parse(readFileSync(join("test", "data", ...parts), "utf-8"));
  const ruleResults = (report) =>
    report.allFindings
      .map((finding) => `${finding.ruleId}:${finding.status}`)
      .sort();

  for (const fixture of ["bom-alpine-trivy.json", "bom-java.json"]) {
    it(`gives the same deep and compliance results at 1.x and 2.0 for ${fixture}`, async () => {
      const bom1x = readFixture(fixture);
      const bom20 = renderCycloneDx20(structuredClone(bom1x));
      const report1x = await validateBomAdvanced(bom1x, { includePass: true });
      const report20 = await validateBomAdvanced(bom20, { includePass: true });
      assert.ok(report1x.allFindings.length > 0);
      assert.deepStrictEqual(ruleResults(report20), ruleResults(report1x));
      assert.strictEqual(report20.deepValid, report1x.deepValid);
      assert.strictEqual(
        report20.schemaValid,
        true,
        "the schema check reads the 2.0 document",
      );
      assert.deepStrictEqual(report20.readLosses, []);
      assert.deepStrictEqual(report20.validationErrors, []);
    });
  }

  it("reports the read losses of a 2.0 document", async () => {
    const bom20 = readFixture("cyclonedx-2.0-read", "stray-components.json");
    const report = await validateBomAdvanced(bom20, { benchmarks: [] });
    assert.strictEqual(
      report.schemaValid,
      false,
      "a stray components member is not 2.0",
    );
    assert.ok(
      report.readLosses.some((loss) => loss.pointer === "/components"),
      "the stray member is a read loss",
    );
  });

  it("records a read failure instead of throwing", async () => {
    const bom20 = { specFormat: "CycloneDX", specVersion: "2.0" };
    Object.defineProperty(bom20, "metadata", {
      enumerable: true,
      get() {
        throw new Error("unreadable member");
      },
    });
    const report = await validateBomAdvanced(bom20, {
      schema: false,
      benchmarks: [],
    });
    assert.deepStrictEqual(report.readLosses, []);
    assert.strictEqual(report.validationErrors[0].stage, "read");
    assert.match(
      report.validationErrors[0].message,
      /^Unable to read the CycloneDX 2\.0 document: unreadable member/,
    );
  });
});
