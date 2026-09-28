import crypto from "node:crypto";

import { assert, describe, it } from "poku";

import { signBom } from "../helpers/bomSigner.js";
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
  it("accepts CycloneDX 2.0-dev root fields in compliance evaluation", () => {
    const bom20 = richBom();
    delete bom20.bomFormat;
    bom20.specFormat = "CycloneDX";
    bom20.specVersion = "2.0";
    const report = validateBomAdvanced(bom20, { schema: false });
    assert.strictEqual(
      report.allFindings.some((finding) =>
        /bomFormat\/specVersion missing/.test(finding.message),
      ),
      false,
    );
  });

  it("returns structural, compliance, and benchmark data", () => {
    const report = validateBomAdvanced(richBom(), { schema: false });
    assert.strictEqual(typeof report.schemaValid, "boolean");
    assert.strictEqual(typeof report.deepValid, "boolean");
    assert.ok(Array.isArray(report.findings));
    assert.ok(Array.isArray(report.allFindings));
    assert.ok(Array.isArray(report.benchmarks));
    assert.ok(report.summary);
    assert.strictEqual(report.summary.schemaValid, report.schemaValid);
    assert.strictEqual(report.summary.deepValid, report.deepValid);
  });

  it("hides pass findings by default but includes manual", () => {
    const report = validateBomAdvanced(richBom(), { schema: false });
    for (const f of report.findings) {
      assert.notStrictEqual(f.status, "pass");
    }
    assert.ok(report.findings.some((f) => f.status === "manual"));
  });

  it("respects minSeverity filter", () => {
    const report = validateBomAdvanced(richBom(), {
      schema: false,
      minSeverity: "high",
      includeManual: true,
    });
    for (const f of report.findings) {
      assert.ok(["high", "critical"].includes(f.severity));
    }
  });

  it("marks signatureVerified=false when public key given but BOM unsigned", () => {
    const report = validateBomAdvanced(richBom(), {
      schema: false,
      publicKey: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
    });
    assert.strictEqual(report.signatureVerified, false);
    assert.ok(report.signatureDetails?.error);
  });

  it("verifies a signed BOM with its public key", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const bom = signBom(richBom(), { privateKey, algorithm: "Ed25519" });
    const report = validateBomAdvanced(bom, {
      schema: false,
      publicKey,
    });
    assert.strictEqual(report.signatureVerified, true);
    assert.strictEqual(report.signatureDetails.algorithm, "Ed25519");
  });

  it("rejects an HMAC signature keyed with the public key", () => {
    const { publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const forged = signBom(richBom(), {
      privateKey: crypto.createSecretKey(Buffer.from(publicKey)),
      algorithm: "HS256",
    });
    const report = validateBomAdvanced(forged, {
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

  it("verifies an HMAC signature only with secretKey", () => {
    const secret = crypto.randomBytes(32);
    const bom = signBom(richBom(), { privateKey: secret, algorithm: "HS512" });
    const withSecret = validateBomAdvanced(bom, {
      schema: false,
      secretKey: secret,
    });
    assert.strictEqual(withSecret.signatureVerified, true);
    const wrongSecret = validateBomAdvanced(bom, {
      schema: false,
      secretKey: crypto.randomBytes(32),
    });
    assert.strictEqual(wrongSecret.signatureVerified, false);
    assert.match(
      wrongSecret.signatureDetails.error,
      /does not verify with this key/,
    );
  });

  it("verifies nested signatures unless nestedSignatures is false", () => {
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
    const deep = validateBomAdvanced(bom, {
      schema: false,
      publicKey: auditor.publicKey,
    });
    assert.strictEqual(deep.signatureVerified, false);
    assert.match(deep.signatureDetails.error, /^components\[0\]/);
    const rootOnly = validateBomAdvanced(bom, {
      schema: false,
      publicKey: auditor.publicKey,
      nestedSignatures: false,
    });
    assert.strictEqual(rootOnly.signatureVerified, true);
    const builderDeep = validateBomAdvanced(bom, {
      schema: false,
      publicKey: builder.publicKey,
    });
    assert.strictEqual(builderDeep.signatureVerified, true);
  });

  it("returns signatureVerified=null when no public key supplied", () => {
    const report = validateBomAdvanced(richBom(), { schema: false });
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

  it("ignores signature when not required", () => {
    const r = fakeReport({ signatureVerified: false });
    assert.strictEqual(
      shouldFail(r, { failSeverity: "critical" }).shouldFail,
      false,
    );
  });
});
