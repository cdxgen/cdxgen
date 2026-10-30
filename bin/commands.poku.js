import { execFileSync, spawn } from "node:child_process";
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

import { strict as assert, describe, it } from "poku";

// Every command exposed on the `bin` field of package.json that takes
// arguments. `repl` is excluded: it is an interactive shell that treats
// `--help` and `--version` as unknown input and drops into its prompt.
const COMMANDS = [
  "audit",
  "cdxgen",
  "convert",
  "evinse",
  "hbom",
  "sign",
  "tracebom",
  "validate",
  "verify",
];

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

describe("bin entry points", () => {
  for (const command of COMMANDS) {
    it(`${command} --help exits 0 and describes its options`, async () => {
      const { status, stdout, stderr } = await run([binFor(command), "--help"]);
      assert.strictEqual(status, 0, `${command} --help exited ${status}`);
      const output = stdout + stderr;
      assert.ok(
        output.includes("--help") || output.includes("Options"),
        `${command} --help printed no usage text`,
      );
    });

    it(`${command} --version prints a version`, async () => {
      const { status, stdout, stderr } = await run([
        binFor(command),
        "--version",
      ]);
      assert.strictEqual(status, 0, `${command} --version exited ${status}`);
      assert.match(stdout + stderr, /\d+\.\d+\.\d+/);
    });
  }
});

// A committed CycloneDX 1.7 document, so these cases stay hermetic and do not
// pay for a full scan.
const BOM_FIXTURE = "test/data/bom-cbom-js-fixture.json";
const workDir = mkdtempSync(join(tmpdir(), "cdxgen-bin-"));
process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));

describe("bin commands over a CycloneDX document", () => {
  it("cdx-validate reports a verdict", async () => {
    const { status, stdout, stderr } = await run([
      binFor("validate"),
      "-i",
      BOM_FIXTURE,
      "--benchmark",
      "none",
    ]);
    assert.strictEqual(status, 0);
    assert.ok((stdout + stderr).length > 0);
  });

  it("cdx-validate keeps stdout parseable when the schema check fails", async () => {
    const badBom = join(workDir, "schema-invalid.json");
    writeFileSync(
      badBom,
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        components: [{ name: "left-pad", version: "1.3.0" }],
      }),
    );
    for (const reporter of ["json", "sarif"]) {
      const { stdout, stderr } = await run([
        binFor("validate"),
        "-i",
        badBom,
        "-r",
        reporter,
        "--benchmark",
        "none",
      ]);
      assert.doesNotThrow(() => JSON.parse(stdout), reporter);
      assert.ok(stderr.includes("Schema validation failed"), reporter);
    }
  });

  it("cdx-validate runs the deep validators once and reports a passing schema", async () => {
    const badBom = join(workDir, "deep-invalid.json");
    writeFileSync(
      badBom,
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        components: [
          {
            type: "cryptographic-asset",
            name: "aes-256-gcm",
            purl: "pkg:generic/aes-256-gcm",
          },
        ],
      }),
    );
    const { stdout, stderr } = await run([
      binFor("validate"),
      "-i",
      badBom,
      "-r",
      "json",
      "--benchmark",
      "none",
    ]);
    const report = JSON.parse(stdout);
    assert.strictEqual(report.schemaValid, true);
    assert.strictEqual(report.deepValid, false);
    assert.strictEqual(
      stderr.split("purl should not be defined for cryptographic-asset").length,
      2,
    );
  });

  it("cdx-convert exports an SPDX document", async () => {
    const spdxFile = join(workDir, "bom.spdx.json");
    const { status } = await run([
      binFor("convert"),
      "-i",
      BOM_FIXTURE,
      "-o",
      spdxFile,
    ]);
    assert.strictEqual(status, 0);
    const spdx = JSON.parse(readFileSync(spdxFile, "utf-8"));
    assert.ok(JSON.stringify(spdx).includes("spdx"));
  });

  it("cdx-convert downgrades a CycloneDX document to an older spec version", async () => {
    const outFile = join(workDir, "bom-1_6.json");
    const { status, stdout, stderr } = await run([
      binFor("convert"),
      "-i",
      BOM_FIXTURE,
      "--to",
      "1.6",
      "-o",
      outFile,
    ]);
    assert.strictEqual(status, 0, `cdx-convert --to 1.6 exited ${status}`);
    const bomJson = JSON.parse(readFileSync(outFile, "utf-8"));
    assert.strictEqual(bomJson.specVersion, "1.6");
    assert.strictEqual(bomJson.bomFormat, "CycloneDX");
    // 1.7-only root elements never reach a 1.6 document.
    assert.strictEqual(bomJson.citations, undefined);
    assert.ok(bomJson.components.length > 0);
    assert.match(stdout + stderr, /Successfully converted/);
  });

  it("cdx-convert refuses an unknown conversion target", async () => {
    const { status, stdout, stderr } = await run([
      binFor("convert"),
      "-i",
      BOM_FIXTURE,
      "--to",
      "parquet",
    ]);
    assert.notStrictEqual(status, 0);
    assert.match(stdout + stderr, /Unsupported conversion target/);
  });

  // cdx-audit's behaviour is covered by lib/stages/postgen/auditBom.poku.js.
  // Running it here would reach the network for every component and take over
  // a minute on a fixture of this size.

  it("cdx-sign signs a BOM that cdx-verify then accepts", async () => {
    const privateKey = join(workDir, "private.pem");
    const publicKey = join(workDir, "public.pem");
    const signedFile = join(workDir, "signed.json");
    execFileSync("openssl", ["genrsa", "-out", privateKey, "2048"], {
      stdio: "ignore",
    });
    execFileSync(
      "openssl",
      ["rsa", "-in", privateKey, "-pubout", "-out", publicKey],
      { stdio: "ignore" },
    );

    const signed = await run([
      binFor("sign"),
      "-i",
      BOM_FIXTURE,
      "-o",
      signedFile,
      "-k",
      privateKey,
    ]);
    assert.strictEqual(signed.status, 0);
    assert.ok(JSON.parse(readFileSync(signedFile, "utf-8")).signature);

    const verified = await run([
      binFor("verify"),
      "-i",
      signedFile,
      "--public-key",
      publicKey,
    ]);
    assert.strictEqual(verified.status, 0);
  });

  it("cdx-sign refuses to sign without a key", async () => {
    const { status } = await run([
      binFor("sign"),
      "-i",
      BOM_FIXTURE,
      "-o",
      join(workDir, "unsigned.json"),
    ]);
    assert.notStrictEqual(status, 0);
  });
});

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
      "--verify-existing-with",
      file("rsa-public.pem"),
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
      "--verify-existing-with",
      file("rsa-public.pem"),
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

    it("signs file and stdout output", async () => {
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

      const toStdout = await cdxgen(rsaSigning, "-o", "-");
      assert.strictEqual(toStdout.status, 0, toStdout.stderr);
      assert.strictEqual(
        JSON.parse(toStdout.stdout).signature.algorithm,
        "RS256",
      );

      const generated = await cdxgen({}, "-o", "-", "--generate-key-and-sign");
      assert.strictEqual(generated.status, 1);
      assert.match(generated.stderr, /needs a file output/);
      assert.strictEqual(generated.stdout, "");
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
      const start = uploaded.indexOf('{"bomFormat"');
      assert.ok(start >= 0, "The upload carries the BOM");
      const end = uploaded.lastIndexOf("}");
      const sent = JSON.parse(uploaded.slice(start, end + 1));
      assert.strictEqual(sent.signature.algorithm, "RS256");
    });
  });
});

describe("JSF verification refuses ambiguous or partial signatures", () => {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-jsf-hardening-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const file = (name) => join(dir, name);
  const keyPair = (name, type, options = {}) => {
    const pair = crypto.generateKeyPairSync(type, {
      ...options,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    writeFileSync(file(`${name}-public.pem`), pair.publicKey);
    writeFileSync(file(`${name}-private.pem`), pair.privateKey);
    return pair;
  };
  const rsa = keyPair("rsa", "rsa", { modulusLength: 2048 });
  keyPair("ed25519", "ed25519");
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
  const sign = (input, output, ...args) =>
    run([binFor("sign"), "-i", file(input), "-o", file(output), ...args]);
  const verify = (input, ...args) =>
    run([binFor("verify"), "-i", file(input), ...args]);
  const validate = (input, ...args) =>
    run([
      binFor("validate"),
      "-i",
      file(input),
      "--benchmark",
      "none",
      "--fail-severity",
      "critical",
      ...args,
    ]);
  const readJson = (name) => JSON.parse(readFileSync(file(name), "utf-8"));
  const writeJson = (name, value) =>
    writeFileSync(file(name), JSON.stringify(value));
  const signedByRsa = async (name, ...args) => {
    const { status, stderr } = await sign(
      "bom.json",
      name,
      "-k",
      file("rsa-private.pem"),
      ...args,
    );
    assert.strictEqual(status, 0, stderr);
    return readJson(name);
  };

  it("cdx-verify needs an explicit key and ignores public.key in the working directory", async () => {
    const attacker = join(dir, "attacker");
    mkdirSync(attacker);
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    writeFileSync(join(attacker, "public.key"), publicKey);
    writeFileSync(join(attacker, "attacker-private.pem"), privateKey);
    const signed = await run([
      binFor("sign"),
      "-i",
      file("bom.json"),
      "-o",
      join(attacker, "bom.json"),
      "-k",
      join(attacker, "attacker-private.pem"),
      "-a",
      "Ed25519",
    ]);
    assert.strictEqual(signed.status, 0, signed.stderr);
    const { status, stdout } = await run([binFor("verify")], { cwd: attacker });
    assert.strictEqual(status, 1);
    assert.match(stdout, /Name the trusted key with --public-key <file>/);
    assert.doesNotMatch(stdout, /valid!/);
  });

  it("cdx-verify rejects a BOM whose root signature was removed", async () => {
    const stripped = await signedByRsa("strip.json");
    delete stripped.signature;
    writeJson("stripped-clean.json", stripped);
    stripped.components.push({
      type: "library",
      name: "evil",
      version: "6.6.6",
    });
    writeJson("stripped.json", stripped);

    const plain = await verify(
      "stripped.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(plain.status, 1);
    assert.match(plain.stdout, /The BOM has no root signature/);
    assert.match(plain.stdout, /Pass --allow-nested-only/);

    const injected = await verify(
      "stripped.json",
      "--public-key",
      file("rsa-public.pem"),
      "--allow-nested-only",
    );
    assert.strictEqual(injected.status, 1);
    assert.match(
      injected.stdout,
      /1 of 2 components are not signed, starting with components\[1\] 'evil'/,
    );

    const clean = await verify(
      "stripped-clean.json",
      "--public-key",
      file("rsa-public.pem"),
      "--allow-nested-only",
    );
    assert.strictEqual(clean.status, 0, clean.stdout);
    assert.match(clean.stdout, /✓ 1 nested signature\(s\) are valid!/);
    assert.match(
      clean.stdout,
      /Note: Without a root signature, no signature covers bomFormat, specVersion, version, or which components, services, and annotations the BOM lists and in what order\./,
    );
  });

  it("cdx-verify rejects a component signature presented as a BOM", async () => {
    const component = {
      type: "library",
      name: "innocent",
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [{ type: "library", name: "backdoor" }],
    };
    const block = { algorithm: "RS512" };
    const value = crypto
      .sign(
        "sha512",
        Buffer.from(jcs({ ...component, signature: block })),
        rsa.privateKey,
      )
      .toString("base64url");
    writeJson("promoted.json", {
      ...component,
      signature: { ...block, value },
    });
    const { status, stdout } = await verify(
      "promoted.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(status, 1);
    assert.match(
      stdout,
      /members that CycloneDX does not define at the root of a BOM: type, name/,
    );

    writeJson("bom-shaped-component.json", {
      ...bom,
      components: [{ ...bom.components[0], specVersion: "1.6" }],
    });
    const refused = await sign(
      "bom-shaped-component.json",
      "bom-shaped-signed.json",
      "-k",
      file("rsa-private.pem"),
    );
    assert.notStrictEqual(refused.status, 0);
    assert.match(
      refused.stderr,
      /Cannot sign components\[0\] 'left-pad': it carries specVersion, which only the root of a BOM may hold/,
    );
  });

  it("cdx-verify, cdx-sign, and cdx-validate refuse repeated member names", async () => {
    await signedByRsa("duplicate-source.json");
    const signedText = readFileSync(file("duplicate-source.json"), "utf-8");
    const duplicated = `{"components":[{"type":"library","name":"evil"}],${signedText.slice(1)}`;
    writeFileSync(file("duplicated.json"), duplicated);
    const verified = await verify(
      "duplicated.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(verified.status, 1);
    assert.match(verified.stdout, /Duplicate member name at \/components/);
    assert.doesNotMatch(verified.stdout, /valid!/);

    const signed = await sign(
      "duplicated.json",
      "duplicated-signed.json",
      "-k",
      file("rsa-private.pem"),
    );
    assert.notStrictEqual(signed.status, 0);
    assert.match(signed.stderr, /Duplicate member name at \/components/);

    const validated = await validate(
      "duplicated.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(validated.status, 4);
    assert.match(validated.stderr, /Duplicate member name at \/components/);
  });

  it("cdx-verify refuses numbers a double cannot hold exactly", async () => {
    const signed = await signedByRsa("number.json");
    signed.version = 1;
    const text = JSON.stringify(signed).replace(
      '"version":1',
      '"version":1.0000000000000001',
    );
    writeFileSync(file("number-tampered.json"), text);
    const { status, stdout } = await verify(
      "number-tampered.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(status, 1);
    assert.match(
      stdout,
      /The number 1\.0000000000000001 at \/version cannot be held exactly/,
    );
  });

  it("cdx-verify refuses more than 32 signature entries", async () => {
    const signed = await signedByRsa("many.json", "--mode", "signers");
    signed.signature.signers.unshift(
      ...Array.from({ length: 32 }, () => ({
        algorithm: "RS512",
        value: "AAAA",
      })),
    );
    writeJson("many-entries.json", signed);
    const { status, stdout } = await verify(
      "many-entries.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(status, 1);
    assert.match(
      stdout,
      /The signers array has 33 entries; at most 32 are supported/,
    );
  });

  it("cdx-verify lists entries that did not verify, and --require-all fails on them", async () => {
    await signedByRsa(
      "cosign.json",
      "--mode",
      "signers",
      "--key-id",
      "builder",
    );
    const cosigned = await run([
      binFor("sign"),
      "-i",
      file("cosign.json"),
      "-k",
      file("ed25519-private.pem"),
      "-a",
      "Ed25519",
      "--mode",
      "signers",
      "--key-id",
      "auditor",
      "--verify-existing-with",
      file("rsa-public.pem"),
    ]);
    assert.strictEqual(cosigned.status, 0, cosigned.stderr);
    const both = await verify(
      "cosign.json",
      "--public-key",
      file("rsa-public.pem"),
      "--public-key",
      file("ed25519-public.pem"),
      "--require-all",
    );
    assert.strictEqual(both.status, 0, both.stdout);
    assert.doesNotMatch(both.stdout, /Warning/);

    const spoofed = readJson("cosign.json");
    spoofed.signature.signers.push({
      algorithm: "RS512",
      keyId: "security-team",
      value: "AAAA",
    });
    writeJson("spoofed.json", spoofed);
    const lenient = await verify(
      "spoofed.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(lenient.status, 0, lenient.stdout);
    assert.match(lenient.stdout, /Matched KeyId: 'builder'/);
    assert.match(
      lenient.stdout,
      /Warning: 2 of 3 signers entries did not verify with the given key\(s\)/,
    );
    assert.match(
      lenient.stdout,
      /signers\[2\] \(RS512, keyId 'security-team'\)/,
    );
    const strict = await verify(
      "spoofed.json",
      "--public-key",
      file("rsa-public.pem"),
      "--public-key",
      file("ed25519-public.pem"),
      "--require-all",
    );
    assert.strictEqual(strict.status, 1);
    assert.match(strict.stdout, /BOM signature is invalid!/);
    assert.match(
      strict.stdout,
      /signers\[2\]: The RS512 signature does not verify/,
    );

    const validated = await validate(
      "cosign.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(validated.status, 0, validated.stderr);
    assert.match(
      validated.stderr,
      /warning — 1 of 2 signature entries did not verify with the given key: entry 1 \(keyId 'auditor'\)/,
    );
  });

  it("cdx-validate fails on a bad signature whenever a key is given", async () => {
    const tampered = await signedByRsa("validate.json");
    tampered.components[0].version = "1.3.1";
    writeJson("validate-tampered.json", tampered);
    const failed = await validate(
      "validate-tampered.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(failed.status, 4);
    assert.match(failed.stderr, /signature verification failed/);
    const reportOnly = await validate(
      "validate-tampered.json",
      "--public-key",
      file("rsa-public.pem"),
      "--no-require-signature",
    );
    assert.strictEqual(reportOnly.status, 0, reportOnly.stderr);
    assert.match(reportOnly.stderr, /signature verification failed/);
    const untouched = await validate(
      "validate.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(untouched.status, 0, untouched.stderr);
  });

  it("cdx-sign embeds the signer's public key in the root signature only", async () => {
    const embedded = await signedByRsa("embedded.json");
    assert.deepStrictEqual(
      embedded.signature.publicKey,
      crypto.createPublicKey(rsa.publicKey).export({ format: "jwk" }),
    );
    assert.strictEqual(embedded.components[0].signature.publicKey, undefined);
    const otherKey = await verify(
      "embedded.json",
      "--public-key",
      file("ed25519-public.pem"),
      "--no-deep",
    );
    assert.strictEqual(otherKey.status, 1);
    const plain = await signedByRsa("plain.json", "--no-embed-public-key");
    assert.strictEqual(plain.signature.publicKey, undefined);
    const hmac = await sign(
      "bom.json",
      "hmac.json",
      "-k",
      file("hmac.secret"),
      "-a",
      "HS256",
    );
    assert.strictEqual(hmac.status, 0, hmac.stderr);
    assert.strictEqual(readJson("hmac.json").signature.publicKey, undefined);
  });

  it("cdx-sign checks the existing signers before co-signing", async () => {
    await signedByRsa("cosign-check.json", "--mode", "signers");
    const cosign = (input, ...args) =>
      run([
        binFor("sign"),
        "-i",
        file(input),
        "-k",
        file("ed25519-private.pem"),
        "-a",
        "Ed25519",
        "--mode",
        "signers",
        ...args,
      ]);
    const tampered = readJson("cosign-check.json");
    tampered.components[0].version = "9.9.9";
    writeJson("cosign-tampered.json", tampered);
    const before = readFileSync(file("cosign-tampered.json"), "utf-8");

    const refused = await cosign(
      "cosign-tampered.json",
      "--verify-existing-with",
      file("rsa-public.pem"),
    );
    assert.notStrictEqual(refused.status, 0);
    assert.match(
      refused.stderr,
      /none of the 1 existing signature entry\(s\) could be verified, so the content may have changed since it was signed/,
    );
    assert.strictEqual(
      readFileSync(file("cosign-tampered.json"), "utf-8"),
      before,
    );

    const noKey = await cosign("cosign-check.json");
    assert.notStrictEqual(noKey.status, 0);
    assert.match(noKey.stderr, /no --verify-existing-with key was given/);

    const allowed = await cosign(
      "cosign-tampered.json",
      "--allow-unverified-history",
    );
    assert.strictEqual(allowed.status, 0, allowed.stderr);
    assert.match(
      allowed.stderr,
      /Warning: appending a signers entry although none of the 1 existing entry\(s\) verified/,
    );

    const appended = await cosign(
      "cosign-check.json",
      "--verify-existing-with",
      file("rsa-public.pem"),
    );
    assert.strictEqual(appended.status, 0, appended.stderr);
    assert.strictEqual(
      readJson("cosign-check.json").signature.signers.length,
      2,
    );
  });

  it("cdx-verify accepts the BOMs signed by cdxgen 13.3.0", async () => {
    const fixtures = join(process.cwd(), "test", "data", "jsf");
    const check = async (name, ...args) => {
      const { status, stdout } = await run([
        binFor("verify"),
        "-i",
        join(fixtures, name),
        ...args,
      ]);
      assert.strictEqual(status, 0, `${name}: ${stdout}`);
    };
    await check(
      "replace-RS512.json",
      "--public-key",
      join(fixtures, "rsa-public.pem"),
    );
    await check(
      "replace-ES512.json",
      "--public-key",
      join(fixtures, "p521-public.pem"),
    );
    await check(
      "replace-HS256.json",
      "--secret-key",
      join(fixtures, "hmac.secret"),
    );
    await check(
      "signers-RS512-ES256.json",
      "--public-key",
      join(fixtures, "rsa-public.pem"),
      "--public-key",
      join(fixtures, "p256-public.pem"),
      "--require-all",
    );
    await check(
      "chain-Ed25519-PS512.json",
      "--public-key",
      join(fixtures, "ed25519-public.pem"),
      "--public-key",
      join(fixtures, "rsa-public.pem"),
      "--require-all",
    );
  });

  it("cdx-validate refuses an empty key path or key file", async () => {
    const tampered = await signedByRsa("empty-key.json");
    tampered.components[0].version = "6.6.6";
    writeJson("empty-key-tampered.json", tampered);
    writeFileSync(file("empty.pem"), "  \n");
    for (const keyArgs of [
      ["--public-key", ""],
      ["--public-key", file("empty.pem")],
      ["--secret-key", file("empty.pem")],
    ]) {
      const { status, stderr } = await validate(
        "empty-key-tampered.json",
        ...keyArgs,
      );
      assert.strictEqual(status, 1, `${keyArgs.join(" ")}: ${stderr}`);
      assert.match(stderr, /needs exactly one file path|is empty/);
    }
  });

  it("cdx-verify --require-all fails when an expected signer's entry was removed", async () => {
    await signedByRsa("require-all.json", "--key-id", "builder");
    const cosigned = await run([
      binFor("sign"),
      "-i",
      file("require-all.json"),
      "-k",
      file("ed25519-private.pem"),
      "-a",
      "Ed25519",
      "--mode",
      "signers",
      "--verify-existing-with",
      file("rsa-public.pem"),
    ]);
    assert.strictEqual(cosigned.status, 0, cosigned.stderr);
    const removed = readJson("require-all.json");
    removed.signature = removed.signature.signers[0];
    writeJson("require-all-removed.json", removed);
    const lenient = await verify(
      "require-all-removed.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(lenient.status, 0, lenient.stdout);
    const strict = await verify(
      "require-all-removed.json",
      "--public-key",
      file("rsa-public.pem"),
      "--public-key",
      file("ed25519-public.pem"),
      "--require-all",
    );
    assert.strictEqual(strict.status, 1);
    assert.match(
      strict.stdout,
      /No entry of the root signature verifies with key #2/,
    );
    assert.match(strict.stdout, /key #2: .*ed25519-public\.pem/);
  });

  it("cdx-verify warns about nested signature entries that did not verify", async () => {
    const signed = await signedByRsa("nested-warn.json", "--mode", "signers");
    delete signed.signature;
    signed.components[0].signature.signers.push({
      algorithm: "RS512",
      keyId: "release-approver",
      value: "AAAA",
    });
    writeJson("nested-warn-unsigned.json", signed);
    const resigned = await sign(
      "nested-warn-unsigned.json",
      "nested-warn-signed.json",
      "-k",
      file("rsa-private.pem"),
      "--no-sign-components",
    );
    assert.strictEqual(resigned.status, 0, resigned.stderr);
    const { status, stdout } = await verify(
      "nested-warn-signed.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(status, 0, stdout);
    assert.match(
      stdout,
      /Warning: 1 nested signature entries did not verify with the given key\(s\)/,
    );
    assert.match(
      stdout,
      /components\[0\] 'left-pad' signers\[1\] \(RS512, keyId 'release-approver'\)/,
    );
    const strict = await verify(
      "nested-warn-signed.json",
      "--public-key",
      file("rsa-public.pem"),
      "--require-all",
    );
    assert.strictEqual(strict.status, 1);
  });

  it("cdx-verify refuses BOM bytes that are not UTF-8", async () => {
    const withReplacement = {
      ...bom,
      components: [{ ...bom.components[0], description: "a�b" }],
    };
    writeJson("utf8-source.json", withReplacement);
    const signed = await sign(
      "utf8-source.json",
      "utf8-signed.json",
      "-k",
      file("rsa-private.pem"),
    );
    assert.strictEqual(signed.status, 0, signed.stderr);
    const bytes = readFileSync(file("utf8-signed.json"));
    const marker = Buffer.from("�", "utf8");
    const at = bytes.indexOf(marker);
    assert.ok(at > 0);
    const swapped = Buffer.concat([
      bytes.subarray(0, at),
      Buffer.from([0xff]),
      bytes.subarray(at + marker.length),
    ]);
    writeFileSync(file("utf8-swapped.json"), swapped);
    const intact = await verify(
      "utf8-signed.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(intact.status, 0, intact.stdout);
    const { status, stdout } = await verify(
      "utf8-swapped.json",
      "--public-key",
      file("rsa-public.pem"),
    );
    assert.strictEqual(status, 1);
    assert.match(stdout, /not valid UTF-8/);
  });

  it("cdx-sign signs with an rsa-pss key and says the key was not embedded", async () => {
    let pair;
    try {
      pair = crypto.generateKeyPairSync("rsa-pss", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
    } catch {
      // Bun cannot create rsa-pss keys.
      return;
    }
    writeFileSync(file("pss-private.pem"), pair.privateKey);
    writeFileSync(file("pss-public.pem"), pair.publicKey);
    const signed = await sign(
      "bom.json",
      "pss.json",
      "-k",
      file("pss-private.pem"),
      "-a",
      "PS384",
    );
    assert.strictEqual(signed.status, 0, signed.stderr);
    assert.match(signed.stderr, /public key was not embedded/);
    const verified = await verify(
      "pss.json",
      "--public-key",
      file("pss-public.pem"),
    );
    assert.strictEqual(verified.status, 0, verified.stdout);
  });
});
