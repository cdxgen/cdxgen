import assert from "node:assert";
import crypto from "node:crypto";

import { describe, it } from "poku";

import { signBom, verifyBom, verifyNode } from "./bomSigner.js";

const rsaKeys = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ecKeys = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const generateMockBom = () => ({
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  components: [{ type: "library", name: "cdxgen", version: "1.0.0" }],
  services: [{ name: "acme-service", endpoints: ["https://appthreat.com"] }],
  annotations: [{ subject: "ref-1", annotator: { name: "System" } }],
});

describe("bomSigner Tests", async () => {
  it("Test basic RS512 Signature & Verification", () => {
    const bomRsa = generateMockBom();
    const signedRsa = signBom(bomRsa, {
      privateKey: rsaKeys.privateKey,
      algorithm: "RS512",
    });
    assert.ok(signedRsa.signature, "Root BOM should be signed");
    assert.strictEqual(signedRsa.signature.algorithm, "RS512");
    assert.ok(
      signedRsa.components[0].signature,
      "Granular component should be signed",
    );
    assert.ok(
      signedRsa.services[0].signature,
      "Granular service should be signed",
    );
    assert.ok(
      signedRsa.annotations[0].signature,
      "Granular annotation should be signed",
    );
    assert.ok(verifyBom(signedRsa, rsaKeys.publicKey));
  });

  it("Test ECDSA (ES256) Signature & Verification (JWA IEEE P1363 Format Compliance)", () => {
    const bomEc = generateMockBom();
    const signedEc = signBom(bomEc, {
      privateKey: ecKeys.privateKey,
      algorithm: "ES256",
    });
    assert.strictEqual(signedEc.signature.algorithm, "ES256");
    assert.ok(verifyBom(signedEc, ecKeys.publicKey));
    const signedRsa = signBom(bomEc, {
      privateKey: rsaKeys.privateKey,
      algorithm: "RS512",
    });
    assert.strictEqual(
      verifyBom(signedRsa, ecKeys.publicKey),
      false,
      "Verification must fail with the wrong public key",
    );
  });

  it("Test Multi-Signature Support (`signers`)", () => {
    const bomMulti = generateMockBom();

    // 1st Pass: First signer signs the whole BOM including inner elements
    signBom(bomMulti, {
      privateKey: rsaKeys.privateKey,
      algorithm: "RS512",
      mode: "signers",
    });

    assert.ok(
      bomMulti.signature.algorithm,
      "Initial signature block takes root format",
    );

    // 2nd Pass: Second signer ONLY co-signs the root BOM.
    signBom(bomMulti, {
      privateKey: ecKeys.privateKey,
      algorithm: "ES256",
      mode: "signers",
      signComponents: false,
      signServices: false,
      signAnnotations: false,
    });

    assert.ok(
      Array.isArray(bomMulti.signature.signers),
      "Signature should be converted to signers array",
    );

    assert.strictEqual(
      bomMulti.signature.signers.length,
      2,
      "Should contain exactly two signers",
    );

    // RSA key signed EVERYTHING (root + components), so full deep verifyBom passes
    assert.ok(verifyBom(bomMulti, rsaKeys.publicKey));

    // EC key ONLY signed the root.
    assert.ok(verifyNode(bomMulti, ecKeys.publicKey));
  });

  it("Test Signature Chain Support (`chain`)", () => {
    const bomChain = generateMockBom();

    signBom(bomChain, {
      privateKey: rsaKeys.privateKey,
      algorithm: "RS512",
      mode: "chain",
    });

    signBom(bomChain, {
      privateKey: ecKeys.privateKey,
      algorithm: "ES256",
      mode: "chain",
      signComponents: false,
      signServices: false,
      signAnnotations: false,
    });

    assert.ok(
      Array.isArray(bomChain.signature.chain),
      "Signature should be converted to chain array",
    );

    assert.strictEqual(bomChain.signature.chain.length, 2);

    // RSA key signed everything, verifyBom works
    assert.ok(verifyBom(bomChain, rsaKeys.publicKey));

    // EC key only chained the root, verifyNode strictly checks the root
    assert.ok(verifyNode(bomChain, ecKeys.publicKey));
  });

  it("Test HMAC Symmetric Signature (HS256)", () => {
    const symmetricKey = crypto.randomBytes(32).toString("hex");
    const bomHmac = generateMockBom();
    const signedHmac = signBom(bomHmac, {
      privateKey: symmetricKey,
      algorithm: "HS256",
    });
    assert.strictEqual(signedHmac.signature.algorithm, "HS256");
    assert.ok(verifyBom(signedHmac, symmetricKey));
  });
});
