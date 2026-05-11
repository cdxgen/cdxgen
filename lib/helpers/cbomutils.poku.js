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
        sha256Component.evidence.occurrences.some((occurrence) =>
          occurrence.location.startsWith("index.js:"),
        ),
      );
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
});
