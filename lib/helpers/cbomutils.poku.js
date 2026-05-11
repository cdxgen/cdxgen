import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  collectOSCryptoLibs,
  collectSourceCryptoComponents,
} from "./cbomutils.js";

describe("cbom utils", () => {
  it("collectOSCryptoLibs() returns a result set", () => {
    const cryptoLibs = collectOSCryptoLibs();
    assert.ok(cryptoLibs);
  });

  it("collectSourceCryptoComponents() extracts algorithms from JS source", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-cbom-source-"));
    try {
      writeFileSync(
        join(projectDir, "index.js"),
        [
          "import { createHash, webcrypto } from 'node:crypto';",
          "import jwt from 'jsonwebtoken';",
          "const subtle = webcrypto.subtle;",
          "const digest = 'sha256';",
          "const signingAlgorithm = 'Ed25519';",
          "const profile = { name: 'AES-GCM', length: 256 };",
          "createHash(digest);",
          "subtle.generateKey(profile, true, ['encrypt']);",
          "jwt.sign({ sub: '123' }, 'secret', { algorithm: 'RS256' });",
        ].join("\n"),
        "utf-8",
      );
      const components = await collectSourceCryptoComponents(projectDir, {
        deep: false,
        evidence: true,
        specVersion: 1.7,
      });
      const names = components.map((component) => component.name);
      const sha256Component = components.find(
        (component) => component.name === "sha-256",
      );
      assert.ok(names.includes("sha-256"));
      assert.ok(names.includes("aes256-GCM"));
      assert.ok(names.includes("Ed25519"));
      assert.ok(names.includes("sha256WithRSAEncryption"));
      assert.ok(!names.includes("hmac"));
      assert.ok(sha256Component);
      assert.ok(Array.isArray(sha256Component.evidence.identity));
      assert.strictEqual(sha256Component.evidence.identity[0].field, "name");
      assert.strictEqual(
        sha256Component.evidence.identity[0].concludedValue,
        "sha-256",
      );
      assert.ok(
        sha256Component.evidence.identity[0].methods.some(
          (method) => method.technique === "source-code-analysis",
        ),
      );
      assert.ok(
        sha256Component.evidence.occurrences.some(
          (occurrence) =>
            occurrence.location === "index.js" && occurrence.line === 7,
        ),
      );
      const sha256Occurrence = sha256Component.evidence.occurrences.find(
        (occurrence) =>
          occurrence.location === "index.js" && occurrence.line === 7,
      );
      assert.ok(sha256Occurrence);
      assert.strictEqual(sha256Occurrence.additionalContext, "hash");
      assert.strictEqual(sha256Occurrence.symbol, "node:crypto.createHash");
      assert.ok(!Object.hasOwn(sha256Occurrence, "offset"));
      assert.ok(
        components.every(
          (component) => component.cryptoProperties?.oid?.length,
        ),
      );
      assert.ok(
        components.some((component) =>
          component.properties.some(
            (property) =>
              property.name === "cdx:crypto:sourceType" &&
              property.value.startsWith("js-ast:"),
          ),
        ),
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("collectSourceCryptoComponents() keeps branch-derived evidence for dynamic crypto values", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-cbom-branches-"));
    try {
      writeFileSync(
        join(projectDir, "dynamic-branches.mjs"),
        [
          "import crypto, { createHash, webcrypto } from 'node:crypto';",
          "import jwt from 'jsonwebtoken';",
          "const subtle = webcrypto.subtle;",
          "const digestName = process.env.CDXGEN_TEST_DIGEST || 'sha384';",
          "const keyProfiles = globalThis.__legacyCipher",
          "  ? { active: { name: 'AES-CBC', length: 256 } }",
          "  : { active: { name: 'AES-GCM', length: 256 } };",
          "const signingAlgorithm = globalThis.__legacySignature ? 'RS256' : 'RS512';",
          "const jwtOptions = globalThis.__jwtOptions ?? { algorithm: signingAlgorithm };",
          "createHash(digestName);",
          "await subtle.generateKey(keyProfiles.active, true, ['encrypt', 'decrypt']);",
          "jwt.sign({ sub: '123' }, 'secret', jwtOptions);",
          "export function signPayload(payload, privateKey, alg) {",
          "  let hashAlg = null;",
          "  if (alg === 'RS256' || alg === 'RS512') {",
          "    hashAlg = alg.replace('RS', 'SHA');",
          "    return crypto.sign(hashAlg, Buffer.from(payload, 'utf8'), { key: privateKey });",
          "  }",
          "  if (alg !== 'RS384') {",
          "    return crypto.sign('SHA-224', Buffer.from(payload, 'utf8'), { key: privateKey });",
          "  } else {",
          "    hashAlg = alg.replace('RS', 'SHA');",
          "    return crypto.sign(hashAlg, Buffer.from(payload, 'utf8'), { key: privateKey });",
          "  }",
          "}",
          "export function signPayloadWithSwitch(payload, privateKey, alg) {",
          "  switch (alg) {",
          "    case 'RS256':",
          "    case 'RS512':",
          "      return crypto.sign(alg.replace('RS', 'SHA'), Buffer.from(payload, 'utf8'), { key: privateKey });",
          "    case 'RS384':",
          "      return crypto.sign(alg.replace('RS', 'SHA'), Buffer.from(payload, 'utf8'), { key: privateKey });",
          "    default:",
          "      return crypto.sign('SHA-224', Buffer.from(payload, 'utf8'), { key: privateKey });",
          "  }",
          "}",
          "export function signPayloadWithSwitchDefault(payload, privateKey) {",
          "  const alg = globalThis.__preferLegacy ? 'RS256' : 'RS384';",
          "  switch (alg) {",
          "    case 'RS256':",
          "      return crypto.sign(alg.replace('RS', 'SHA'), Buffer.from(payload, 'utf8'), { key: privateKey });",
          "    default:",
          "      return crypto.sign(alg.replace('RS', 'SHA'), Buffer.from(payload, 'utf8'), { key: privateKey });",
          "  }",
          "}",
        ].join("\n"),
        "utf-8",
      );
      const components = await collectSourceCryptoComponents(projectDir, {
        deep: false,
        evidence: true,
        specVersion: 1.7,
      });
      const names = components.map((component) => component.name);
      const sha384Component = components.find(
        (component) => component.name === "sha-384",
      );

      assert.ok(names.includes("sha-384"));
      assert.ok(names.includes("sha-224"));
      assert.ok(names.includes("sha-256"));
      assert.ok(names.includes("sha-512"));
      assert.ok(names.includes("aes256-CBC"));
      assert.ok(names.includes("aes256-GCM"));
      assert.ok(names.includes("sha256WithRSAEncryption"));
      assert.ok(names.includes("sha512WithRSAEncryption"));
      assert.ok(sha384Component);
      assert.ok(
        sha384Component.evidence.occurrences.some(
          (occurrence) =>
            occurrence.location === "dynamic-branches.mjs" &&
            occurrence.line === 10 &&
            occurrence.symbol === "node:crypto.createHash" &&
            occurrence.additionalContext === "hash",
        ),
      );
      assert.ok(
        sha384Component.properties.some(
          (property) =>
            property.name === "cdx:crypto:sourceLocation" &&
            property.value === "dynamic-branches.mjs:10:0",
        ),
      );
      assert.ok(
        sha384Component.properties.some(
          (property) =>
            property.name === "cdx:crypto:sourceType" &&
            property.value === "js-ast:node:crypto.sign",
        ),
      );
      assert.ok(
        sha384Component.evidence.occurrences.some(
          (occurrence) =>
            occurrence.location === "dynamic-branches.mjs" &&
            occurrence.symbol === "node:crypto.sign" &&
            occurrence.additionalContext === "signature",
        ),
      );
      assert.ok(
        components.some(
          (component) =>
            component.name === "sha-256" &&
            component.properties.some(
              (property) =>
                property.name === "cdx:crypto:sourceType" &&
                property.value === "js-ast:node:crypto.sign",
            ) &&
            component.evidence.occurrences.some(
              (occurrence) =>
                occurrence.location === "dynamic-branches.mjs" &&
                occurrence.symbol === "node:crypto.sign" &&
                occurrence.additionalContext === "signature",
            ),
        ),
      );
      assert.ok(
        components.some(
          (component) =>
            component.name === "sha-512" &&
            component.properties.some(
              (property) =>
                property.name === "cdx:crypto:sourceType" &&
                property.value === "js-ast:node:crypto.sign",
            ) &&
            component.evidence.occurrences.some(
              (occurrence) =>
                occurrence.location === "dynamic-branches.mjs" &&
                occurrence.line === 30 &&
                occurrence.symbol === "node:crypto.sign" &&
                occurrence.additionalContext === "signature",
            ),
        ),
      );
      assert.ok(
        components.some(
          (component) =>
            component.name === "sha-384" &&
            component.evidence.occurrences.some(
              (occurrence) =>
                occurrence.location === "dynamic-branches.mjs" &&
                occurrence.symbol === "node:crypto.sign" &&
                occurrence.additionalContext === "signature" &&
                occurrence.line > 30,
            ),
        ),
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
