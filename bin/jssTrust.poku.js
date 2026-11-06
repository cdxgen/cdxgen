import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import { countersignJss, signJss } from "../lib/helpers/jssSigner.js";

const binFor = (command) => join(process.cwd(), "bin", `${command}.js`);

// process.execPath, not argv0: Deno turns a spawn of its own executable with
// a script path into `deno run` with the parent's permissions.
const run = (args) =>
  spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });

describe("cdx-sign and cdx-verify trust decisions at CycloneDX 2.0", () => {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-jss-trust-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const file = (name) => join(dir, name);
  const pemPair = (name) => {
    const pair = generateKeyPairSync("ed25519");
    writeFileSync(
      file(`${name}-public.pem`),
      pair.publicKey.export({ type: "spki", format: "pem" }),
    );
    writeFileSync(
      file(`${name}-private.pem`),
      pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    return pair;
  };
  const builder = pemPair("builder");
  const approver = pemPair("approver");
  pemPair("auditor");
  const bom20 = {
    specFormat: "CycloneDX",
    specVersion: "2.0",
    serialNumber: "urn:uuid:7c7a5d9e-5d2f-4b0e-9a55-0d9b3c6a1f10",
    version: 1,
    inventories: [
      { components: [{ type: "library", name: "left-pad", version: "1.3.0" }] },
    ],
  };
  const signed = signJss(bom20, {
    algorithm: "Ed25519",
    privateKey: builder.privateKey,
  });

  it("rejects a countersignature that no given key verifies", () => {
    const fake = structuredClone(signed);
    fake.signatures[0].signature = {
      hash_algorithm: "sha-256",
      algorithm: "Ed25519",
      signee: "Release approver",
      thumbprint: "c2hhLTI1Ng",
      value: "AAAA",
    };
    writeFileSync(file("fake-approval.json"), JSON.stringify(fake));
    const result = run([
      binFor("verify"),
      "-i",
      file("fake-approval.json"),
      "--public-key",
      file("builder-public.pem"),
    ]);
    assert.strictEqual(result.status, 1, result.stdout);
    assert.match(result.stdout, /countersignature/u);
  });

  it("accepts a real countersignature once the countersigner's key is given", () => {
    const approved = countersignJss(signed, {
      algorithm: "Ed25519",
      privateKey: approver.privateKey,
    });
    writeFileSync(file("approved.json"), JSON.stringify(approved));
    const builderOnly = run([
      binFor("verify"),
      "-i",
      file("approved.json"),
      "--public-key",
      file("builder-public.pem"),
    ]);
    assert.strictEqual(builderOnly.status, 1, builderOnly.stdout);
    const both = run([
      binFor("verify"),
      "-i",
      file("approved.json"),
      "--public-key",
      file("builder-public.pem"),
      "--public-key",
      file("approver-public.pem"),
    ]);
    assert.strictEqual(both.status, 0, both.stdout);
  });

  it("refuses to append a signer next to an entry that fails verification", () => {
    const tampered = structuredClone(signed);
    tampered.signatures.push({
      hash_algorithm: "sha-256",
      algorithm: "Ed25519",
      public_key: `${tampered.signatures[0].public_key}\n`,
      value: "AAAA",
    });
    writeFileSync(file("tampered.json"), JSON.stringify(tampered));
    const result = run([
      binFor("sign"),
      "-i",
      file("tampered.json"),
      "-o",
      file("tampered-cosigned.json"),
      "-k",
      file("auditor-private.pem"),
      "--mode",
      "signers",
      "--verify-existing-with",
      file("builder-public.pem"),
    ]);
    assert.notStrictEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /cdx-verify would reject/u);
    assert.throws(() => readFileSync(file("tampered-cosigned.json")));
  });

  it("routes any 2.x specVersion to JSS", () => {
    const future = signJss(
      { ...bom20, specVersion: "2.1" },
      { algorithm: "Ed25519", privateKey: builder.privateKey },
    );
    writeFileSync(file("future.json"), JSON.stringify(future));
    const result = run([
      binFor("verify"),
      "-i",
      file("future.json"),
      "--public-key",
      file("builder-public.pem"),
    ]);
    assert.strictEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /JSS/u);
  });
});
