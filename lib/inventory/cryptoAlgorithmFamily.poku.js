import { readFileSync } from "node:fs";
import { join } from "node:path";

import { strict as assert, describe, it } from "poku";

import { dirNameStr } from "../core/paths.js";
import {
  applyAlgorithmProperties,
  resolveAlgorithmFamily,
  resolveEllipticCurve,
} from "./cryptoAlgorithmFamily.js";

const cryptoDefs = JSON.parse(
  readFileSync(
    join(dirNameStr, "data", "cryptography-defs.schema.json"),
    "utf-8",
  ),
);
const FAMILY_ENUM = new Set(cryptoDefs.definitions.algorithmFamiliesEnum.enum);
const CURVE_ENUM = new Set(cryptoDefs.definitions.ellipticCurvesEnum.enum);

describe("resolveAlgorithmFamily()", () => {
  it("maps OID-style names to the algorithmFamily enum", () => {
    const cases = [
      ["aes128-GCM", "AES"],
      ["aes256-CBC", "AES"],
      ["sha-256", "SHA-2"],
      ["sha-384", "SHA-2"],
      ["sha3-256", "SHA-3"],
      ["ecdsaWithSHA256", "ECDSA"],
      ["ecdsaWithSHA1", "ECDSA"],
      ["hmacWithSHA256", "HMAC"],
      ["sha256WithRSAEncryption", "RSASSA-PKCS1"],
      ["PBKDF2", "PBKDF2"],
      ["ecdhHKDF-SHA256", "ECDH"],
      ["HKDF-SHA256", "HKDF"],
      ["rsaesOaep", "RSAES-OAEP"],
      ["rsassaPss", "RSASSA-PSS"],
    ];
    for (const [name, expected] of cases) {
      assert.strictEqual(
        resolveAlgorithmFamily(name),
        expected,
        `${name} should map to ${expected}`,
      );
    }
  });

  it("returns a family that is always a valid enum member", () => {
    const names = [
      "AES",
      "ECDSA",
      "EdDSA",
      "ML-KEM",
      "ML-DSA",
      "SLH-DSA",
      "ChaCha20-Poly1305",
      "BLAKE2b",
    ];
    for (const name of names) {
      const family = resolveAlgorithmFamily(name);
      assert.ok(family, `${name} should resolve`);
      assert.ok(FAMILY_ENUM.has(family), `${family} must be in the enum`);
    }
  });

  it("returns undefined for names with no defensible mapping", () => {
    assert.strictEqual(resolveAlgorithmFamily(""), undefined);
    assert.strictEqual(
      resolveAlgorithmFamily("totally-unknown-scheme"),
      undefined,
    );
  });
});

describe("resolveEllipticCurve()", () => {
  it("maps common curve aliases to the ellipticCurve enum", () => {
    const cases = [
      ["P-256", "nist/P-256"],
      ["secp256r1", "secg/secp256r1"],
      ["prime256v1", "x962/prime256v1"],
      ["P-384", "nist/P-384"],
      ["P-521", "nist/P-521"],
      ["secp256k1", "secg/secp256k1"],
      ["Ed25519", "other/Ed25519"],
      ["Ed448", "other/Ed448"],
      ["X25519", "other/Curve25519"],
      ["brainpoolP256r1", "brainpool/brainpoolP256r1"],
      ["SM2", "oscaa/SM2"],
      ["BLS12-381", "bls/BLS12-381"],
    ];
    for (const [name, expected] of cases) {
      const result = resolveEllipticCurve(name);
      assert.strictEqual(
        result.ellipticCurve,
        expected,
        `${name} -> ${expected}`,
      );
      assert.ok(CURVE_ENUM.has(result.ellipticCurve));
    }
  });

  it("falls back to the deprecated free-text curve property when unmappable", () => {
    const result = resolveEllipticCurve("weird-curve-XYZ");
    assert.strictEqual(result.ellipticCurve, undefined);
    assert.strictEqual(result.curve, "weird-curve-XYZ");
    assert.ok(!CURVE_ENUM.has(result.curve));
  });

  it("returns nothing when no curve is named", () => {
    assert.deepStrictEqual(resolveEllipticCurve(""), {});
    assert.deepStrictEqual(resolveEllipticCurve(undefined), {});
  });
});

describe("applyAlgorithmProperties()", () => {
  it("sets algorithmFamily, primitive, and ellipticCurve on an algorithm component", () => {
    const component = {
      type: "cryptographic-asset",
      name: "ecdsaWithSHA256",
      cryptoProperties: { assetType: "algorithm", oid: "1.2.840.10045.4.3.2" },
    };
    applyAlgorithmProperties(component, {
      name: "ecdsaWithSHA256",
      primitive: "signature",
      curve: "P-256",
    });
    assert.strictEqual(
      component.cryptoProperties.algorithmProperties.algorithmFamily,
      "ECDSA",
    );
    assert.strictEqual(
      component.cryptoProperties.algorithmProperties.primitive,
      "signature",
    );
    assert.strictEqual(
      component.cryptoProperties.algorithmProperties.ellipticCurve,
      "nist/P-256",
    );
  });

  it("uses the deprecated curve property for an unmappable curve", () => {
    const component = {
      type: "cryptographic-asset",
      name: "ecdsaWithSHA256",
      cryptoProperties: { assetType: "algorithm" },
    };
    applyAlgorithmProperties(component, { curve: "custom-curve" });
    assert.strictEqual(
      component.cryptoProperties.algorithmProperties.curve,
      "custom-curve",
    );
    assert.ok(!component.cryptoProperties.algorithmProperties.ellipticCurve);
  });

  it("does not touch non-algorithm crypto assets", () => {
    const component = {
      type: "cryptographic-asset",
      cryptoProperties: { assetType: "related-crypto-material" },
    };
    applyAlgorithmProperties(component, { name: "AES" });
    assert.strictEqual(
      component.cryptoProperties.algorithmProperties,
      undefined,
    );
  });
});
