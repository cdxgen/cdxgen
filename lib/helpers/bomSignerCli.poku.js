import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { describe, it } from "poku";

// End-to-end checks of cdx-sign, cdx-verify, cdx-validate, and cdxgen signing.
const binFor = (command) => join(process.cwd(), "bin", `${command}.js`);

function run(args, options = {}) {
  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(process.argv0, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (status) =>
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      }),
    );
    child.on("error", (error) =>
      resolve({ status: 1, stdout: "", stderr: error.message }),
    );
  });
}

// Independent RFC 8785 canonicalizer, used to build documents the way a third
// party would rather than through cdxgen's own signer.
function jcs(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(jcs).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`)
    .join(",")}}`;
}

describe("JSF signing and verification commands", () => {
  const signingDir = mkdtempSync(join(tmpdir(), "cdxgen-jsf-"));
  process.on("exit", () =>
    rmSync(signingDir, { recursive: true, force: true }),
  );
  const file = (name) => join(signingDir, name);
  const writeKeyPair = (name, type, options = {}) => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync(type, {
      ...options,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    writeFileSync(file(`${name}-public.pem`), publicKey);
    writeFileSync(file(`${name}-private.pem`), privateKey);
    return { publicKey, privateKey };
  };
  const rsa = writeKeyPair("rsa", "rsa", { modulusLength: 2048 });
  writeKeyPair("ed25519", "ed25519");
  writeFileSync(file("hmac.secret"), crypto.randomBytes(48));
  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    components: [
      {
        type: "library",
        name: "left-pad",
        version: "1.3.0",
        purl: "pkg:npm/left-pad@1.3.0",
      },
    ],
  };
  writeFileSync(file("bom.json"), JSON.stringify(bom));
  const sign = (output, ...args) =>
    run([binFor("sign"), "-i", file("bom.json"), "-o", file(output), ...args]);
  const verify = (input, ...args) =>
    run([binFor("verify"), "-i", file(input), ...args]);

  it("cdx-verify rejects an HS256 signature keyed with the public key", async () => {
    const forged = structuredClone(bom);
    forged.components.push({ type: "library", name: "backdoor" });
    forged.signature = { algorithm: "HS256", keyId: "release" };
    forged.signature.value = crypto
      .createHmac("sha256", rsa.publicKey)
      .update(jcs(forged))
      .digest("base64url");
    writeFileSync(file("forged.json"), JSON.stringify(forged));
    const { status, stdout } = await verify(
      "forged.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(status, 1);
    assert.match(stdout, /BOM signature is invalid!/);
    assert.match(stdout, /Algorithm HS256 requires a shared secret/);

    const validated = await run([
      binFor("validate"),
      "-i",
      file("forged.json"),
      "--public-key",
      file("rsa-public.pem"),
      "--require-signature",
      "--benchmark",
      "none",
    ]);
    assert.strictEqual(validated.status, 4);
    assert.match(validated.stderr, /requires a shared secret/);
  });

  it("cdx-verify prints a non-string keyId without failing", async () => {
    const odd = structuredClone(bom);
    odd.signature = { algorithm: "RS256", keyId: { toString: "x" } };
    odd.signature.value = crypto
      .sign("sha256", Buffer.from(jcs(odd)), rsa.privateKey)
      .toString("base64url");
    writeFileSync(file("odd-keyid.json"), JSON.stringify(odd));
    const { status, stdout } = await verify(
      "odd-keyid.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(status, 0, stdout);
    assert.match(stdout, /Matched KeyId: '\{"toString":"x"\}'/);
  });

  it("cdx-sign refuses an algorithm that does not match the key", async () => {
    const { status, stderr } = await sign(
      "mislabelled.json",
      "-k",
      file("rsa-private.pem"),
      "-a",
      "Ed25519",
    );
    assert.notStrictEqual(status, 0);
    assert.match(
      stderr,
      /Algorithm Ed25519 requires an ed25519 key, but the key is rsa/,
    );
  });

  it("verifies HMAC signatures only through --secret-key", async () => {
    const signed = await sign(
      "hmac.json",
      "-k",
      file("hmac.secret"),
      "-a",
      "HS384",
    );
    assert.strictEqual(signed.status, 0, signed.stderr);
    const withSecret = await verify(
      "hmac.json",
      "--secret-key",
      file("hmac.secret"),
    );
    assert.strictEqual(withSecret.status, 0, withSecret.stdout);
    assert.match(withSecret.stdout, /Signature is valid!/);

    const asPublicKey = await verify(
      "hmac.json",
      "--public-key",
      file("hmac.secret"),
    );
    assert.strictEqual(asPublicKey.status, 1);
    assert.match(asPublicKey.stdout, /Unable to use/);

    const both = await verify(
      "hmac.json",
      "--public-key",
      file("rsa-public.pem"),
      "--secret-key",
      file("hmac.secret"),
    );
    assert.strictEqual(both.status, 1);
    assert.match(both.stdout, /either --public-key or --secret-key/);

    const publicKeyAsSecret = await verify(
      "hmac.json",
      "--secret-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(publicKeyAsSecret.status, 1);
    assert.match(
      publicKeyAsSecret.stdout,
      /looks like a public or private key/,
    );

    const validated = await run([
      binFor("validate"),
      "-i",
      file("hmac.json"),
      "--secret-key",
      file("hmac.secret"),
      "--require-signature",
      "--benchmark",
      "none",
    ]);
    assert.notStrictEqual(validated.status, 4, validated.stderr);
  });

  it("appends a chain entry without breaking the builder signature", async () => {
    const built = await sign(
      "chain.json",
      "-k",
      file("rsa-private.pem"),
      "-a",
      "RS512",
      "--key-id",
      "builder",
    );
    assert.strictEqual(built.status, 0, built.stderr);
    const approved = await run([
      binFor("sign"),
      "-i",
      file("chain.json"),
      "-k",
      file("ed25519-private.pem"),
      "-a",
      "Ed25519",
      "--key-id",
      "approver",
      "--mode",
      "chain",
      "--verify-existing-with",
      file("rsa-public.pem"),
    ]);
    assert.strictEqual(approved.status, 0, approved.stderr);
    const chained = JSON.parse(readFileSync(file("chain.json"), "utf-8"));
    assert.deepStrictEqual(
      chained.signature.chain.map((entry) => entry.keyId),
      ["builder", "approver"],
    );

    const builder = await verify(
      "chain.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(builder.status, 0, builder.stdout);
    assert.match(builder.stdout, /Matched KeyId: 'builder'/);
    const approver = await verify(
      "chain.json",
      "--public-key",
      file("ed25519-public.pem"),
      "--no-deep",
    );
    assert.strictEqual(approver.status, 0, approver.stdout);
    assert.match(approver.stdout, /Matched KeyId: 'approver'/);

    chained.signature.chain.reverse();
    writeFileSync(file("reordered.json"), JSON.stringify(chained));
    const reordered = await verify(
      "reordered.json",
      "--public-key",
      file("ed25519-public.pem"),
      "--no-deep",
    );
    assert.strictEqual(reordered.status, 1);
  });

  it("cdx-sign refuses to re-sign nested elements while appending", async () => {
    const built = await sign("nested.json", "-k", file("rsa-private.pem"));
    assert.strictEqual(built.status, 0, built.stderr);
    const before = readFileSync(file("nested.json"), "utf-8");
    const { status, stderr } = await run([
      binFor("sign"),
      "-i",
      file("nested.json"),
      "-k",
      file("ed25519-private.pem"),
      "-a",
      "Ed25519",
      "--mode",
      "signers",
      "--sign-components",
    ]);
    assert.notStrictEqual(status, 0);
    assert.match(
      stderr,
      /changes content covered by the existing root signature/,
    );
    assert.strictEqual(readFileSync(file("nested.json"), "utf-8"), before);
  });

  it("cdx-verify asks for BOMs signed by earlier releases to be re-signed", async () => {
    // Earlier releases signed the content without the signature metadata.
    const old = structuredClone(bom);
    old.signature = {
      algorithm: "RS512",
      value: crypto
        .sign("sha512", Buffer.from(jcs(bom)), rsa.privateKey)
        .toString("base64url"),
    };
    writeFileSync(file("old.json"), JSON.stringify(old));
    const { status, stdout } = await verify(
      "old.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(status, 1);
    assert.match(stdout, /re-sign it with this version of cdx-sign/);
  });
  const appendChain = (input, ...args) =>
    run([
      binFor("sign"),
      "-i",
      file(input),
      "-k",
      file("ed25519-private.pem"),
      "-a",
      "Ed25519",
      "--key-id",
      "auditor",
      "--mode",
      "chain",
      ...args,
    ]);

  it("cdx-sign refuses to append to chain history it cannot verify", async () => {
    const fabricated = structuredClone(bom);
    fabricated.signature = {
      chain: [
        {
          algorithm: "RS256",
          keyId: "secure-builder-ci",
          value: crypto.randomBytes(256).toString("base64url"),
        },
      ],
    };
    const fabricatedText = JSON.stringify(fabricated);
    writeFileSync(file("fabricated.json"), fabricatedText);

    const unverified = await appendChain("fabricated.json");
    assert.notStrictEqual(unverified.status, 0);
    assert.match(unverified.stderr, /could not be verified/);
    assert.match(
      unverified.stderr,
      /entry 0 \(RS256, keyId 'secure-builder-ci'\): no --verify-existing-with key was given/,
    );
    assert.strictEqual(
      readFileSync(file("fabricated.json"), "utf-8"),
      fabricatedText,
    );

    const wrongValue = await appendChain(
      "fabricated.json",
      "--verify-existing-with",
      file("rsa-public.pem"),
    );
    assert.notStrictEqual(wrongValue.status, 0);
    assert.match(wrongValue.stderr, /does not verify with this key/);

    writeFileSync(
      file("broken-history.json"),
      JSON.stringify({ ...bom, signature: { chain: "abc" } }),
    );
    const broken = await appendChain("broken-history.json");
    assert.notStrictEqual(broken.status, 0);
    assert.match(broken.stderr, /entry 0: The chain array must contain/);
    assert.doesNotMatch(broken.stderr, /undefined/);

    const allowed = await appendChain(
      "fabricated.json",
      "--allow-unverified-history",
    );
    assert.strictEqual(allowed.status, 0, allowed.stderr);
    assert.match(
      allowed.stderr,
      /Warning: appending to a chain with 1 unverified/,
    );
  });

  it("cdx-sign checks a single signature before chaining onto it", async () => {
    const built = await sign("single.json", "-k", file("rsa-private.pem"));
    assert.strictEqual(built.status, 0, built.stderr);
    const refused = await appendChain(
      "single.json",
      "--verify-existing-with",
      file("ed25519-public.pem"),
    );
    assert.notStrictEqual(refused.status, 0);
    assert.match(refused.stderr, /requires an rsa key, but the key is ed25519/);
    const appended = await appendChain(
      "single.json",
      "--verify-existing-with",
      file("rsa-public.pem"),
    );
    assert.strictEqual(appended.status, 0, appended.stderr);
    const signers = await run([
      binFor("sign"),
      "-i",
      file("single.json"),
      "-k",
      file("ed25519-private.pem"),
      "-a",
      "Ed25519",
      "--mode",
      "chain",
      "--verify-existing-with",
      file("rsa-public.pem"),
      "--verify-existing-with",
      file("ed25519-public.pem"),
    ]);
    assert.strictEqual(signers.status, 0, signers.stderr);
  });

  it("cdx-verify and cdx-validate explain nested signatures made by another signer", async () => {
    const built = await sign(
      "cosigned.json",
      "-k",
      file("rsa-private.pem"),
      "-a",
      "RS512",
    );
    assert.strictEqual(built.status, 0, built.stderr);
    const cosigned = await run([
      binFor("sign"),
      "-i",
      file("cosigned.json"),
      "-k",
      file("ed25519-private.pem"),
      "-a",
      "Ed25519",
      "--mode",
      "signers",
    ]);
    assert.strictEqual(cosigned.status, 0, cosigned.stderr);

    const deep = await verify(
      "cosigned.json",
      "--public-key",
      file("ed25519-public.pem"),
    );
    assert.strictEqual(deep.status, 1);
    assert.match(deep.stdout, /requires an rsa key, but the key is ed25519/);
    assert.match(deep.stdout, /pass --no-deep to verify only the root/);
    const rootOnly = await verify(
      "cosigned.json",
      "--public-key",
      file("ed25519-public.pem"),
      "--no-deep",
    );
    assert.strictEqual(rootOnly.status, 0, rootOnly.stdout);

    const validate = (...args) =>
      run([
        binFor("validate"),
        "-i",
        file("cosigned.json"),
        "--public-key",
        file("ed25519-public.pem"),
        "--require-signature",
        "--benchmark",
        "none",
        ...args,
      ]);
    const validatedDeep = await validate();
    assert.strictEqual(validatedDeep.status, 4);
    assert.match(validatedDeep.stderr, /components\[0\]/);
    const validatedRoot = await validate("--no-nested-signatures");
    assert.notStrictEqual(validatedRoot.status, 4, validatedRoot.stderr);
  });

  describe("cdxgen signing", () => {
    const project = file("project");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", dependencies: {} }),
    );
    const cdxgen = (env, ...args) =>
      run([binFor("cdxgen"), "-t", "js", project, "--no-banner", ...args], {
        env: { ...process.env, FETCH_LICENSE: "false", ...env },
      });
    const rsaSigning = {
      SBOM_SIGN_ALGORITHM: "RS256",
      SBOM_SIGN_PRIVATE_KEY: file("rsa-private.pem"),
    };

    it("exits non-zero when the configured key cannot sign", async () => {
      const { status, stderr } = await cdxgen(
        { ...rsaSigning, SBOM_SIGN_ALGORITHM: "Ed25519" },
        "-o",
        file("cdxgen-mismatch.json"),
      );
      assert.strictEqual(status, 1);
      assert.match(
        stderr,
        /SBOM signing was unsuccessful: Algorithm Ed25519 requires an ed25519 key/,
      );
      assert.match(stderr, /was written without a signature/);
      const written = JSON.parse(
        readFileSync(file("cdxgen-mismatch.json"), "utf-8"),
      );
      assert.strictEqual(written.signature, undefined);
    });

    it("exits non-zero when the configured key file is missing", async () => {
      const { status, stderr } = await cdxgen(
        { ...rsaSigning, SBOM_SIGN_PRIVATE_KEY: file("typo-private.pem") },
        "-o",
        file("cdxgen-missing-key.json"),
      );
      assert.strictEqual(status, 1);
      assert.match(
        stderr,
        /SBOM_SIGN_PRIVATE_KEY file '.*typo-private\.pem' was not found/,
      );
      const written = JSON.parse(
        readFileSync(file("cdxgen-missing-key.json"), "utf-8"),
      );
      assert.strictEqual(written.signature, undefined);
    });

    it("warns when a key is set without an algorithm", async () => {
      const { status, stderr } = await cdxgen(
        { SBOM_SIGN_PRIVATE_KEY: file("rsa-private.pem") },
        "-o",
        file("cdxgen-no-algorithm.json"),
      );
      assert.strictEqual(status, 0, stderr);
      assert.match(
        stderr,
        /SBOM_SIGN_PRIVATE_KEY is set without SBOM_SIGN_ALGORITHM/,
      );
      const optedOut = await cdxgen(
        {
          SBOM_SIGN_PRIVATE_KEY: file("rsa-private.pem"),
          SBOM_SIGN_ALGORITHM: "none",
        },
        "-o",
        file("cdxgen-opted-out.json"),
      );
      assert.strictEqual(optedOut.status, 0, optedOut.stderr);
      assert.doesNotMatch(optedOut.stderr, /without SBOM_SIGN_ALGORITHM/);
    });

    it("signs file output", async () => {
      const toFile = await cdxgen(rsaSigning, "-o", file("cdxgen-signed.json"));
      assert.strictEqual(toFile.status, 0, toFile.stderr);
      const signed = file("cdxgen-signed.json");
      const verified = await run([
        binFor("verify"),
        "-i",
        signed,
        "--public-key",
        file("rsa-public.pem"),
      ]);
      assert.strictEqual(verified.status, 0, verified.stdout);
    });

    it("uploads the signed BOM to Dependency-Track", async () => {
      let uploaded = "";
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          uploaded = Buffer.concat(chunks).toString("utf-8");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ token: "test" }));
        });
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const { status, stderr } = await cdxgen(
          rsaSigning,
          "-o",
          file("cdxgen-uploaded.json"),
          "--server-url",
          `http://127.0.0.1:${server.address().port}`,
          "--api-key",
          "test",
          "--project-name",
          "demo",
        );
        assert.strictEqual(status, 0, stderr);
      } finally {
        server.close();
      }
      // This release line uploads the BOM base64 encoded in a JSON body.
      const sent = JSON.parse(
        Buffer.from(JSON.parse(uploaded).bom, "base64").toString("utf-8"),
      );
      assert.strictEqual(sent.signature.algorithm, "RS256");
    });
  });
});
