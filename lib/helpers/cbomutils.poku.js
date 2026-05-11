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
      });
      const names = components.map((component) => component.name);
      assert.ok(names.includes("sha-256"));
      assert.ok(names.includes("aes256-GCM"));
      assert.ok(names.includes("sha256WithRSAEncryption"));
      assert.ok(!names.includes("hmac"));
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
