#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import {
  checkSignatureEntries,
  displayValue,
  signBom,
} from "../lib/helpers/bomSigner.js";
import {
  getNonCycloneDxErrorMessage,
  isCycloneDxBom,
} from "../lib/helpers/bomUtils.js";
import {
  readEnvironmentVariable,
  retrieveCdxgenVersion,
  safeExistsSync,
  safeWriteSync,
} from "../lib/helpers/utils.js";
import { parseStrictJson } from "../lib/parsers/strictJson.js";

const _yargs = yargs(hideBin(process.argv));

const args = _yargs
  .option("input", {
    alias: "i",
    default: "bom.json",
    description: "Input SBOM json to sign.",
  })
  .option("output", {
    alias: "o",
    description: "Output signed SBOM json. Defaults to overwriting input.",
  })
  .option("private-key", {
    alias: "k",
    description:
      "Private key in PEM format, or the shared secret file for HS256, HS384, and HS512.",
  })
  .option("algorithm", {
    alias: "a",
    default: readEnvironmentVariable("SBOM_SIGN_ALGORITHM") || "RS512",
    description:
      "JSF Signature Algorithm (e.g., RS512, ES256, Ed25519). It must match the key type.",
  })
  .option("mode", {
    alias: "m",
    default: readEnvironmentVariable("SBOM_SIGN_MODE") || "replace",
    choices: ["replace", "signers", "chain"],
    description:
      "Signature mode. Use 'signers' for multi-signing, 'chain' for sequential chaining.",
  })
  .option("verify-existing-with", {
    type: "array",
    string: true,
    description:
      "Public key (PEM) of an earlier signer. Before a new entry is appended, every existing chain entry (--mode chain), or at least one existing entry (--mode signers), must verify with one of these keys.",
  })
  .option("allow-unverified-history", {
    type: "boolean",
    default: false,
    description:
      "With --mode chain or signers, append even when the existing signature entries cannot be verified with --verify-existing-with.",
  })
  .option("embed-public-key", {
    type: "boolean",
    default: true,
    description:
      "Embed the signer's public key in the root signature, which binds the signature to that key. Not used for HMAC (HS*) algorithms. Pass --no-embed-public-key to leave it out.",
  })
  .option("key-id", {
    description:
      "Optional identifier for the key (keyId) to embed in the signature block.",
  })
  .option("sign-components", {
    type: "boolean",
    description:
      "Sign granular components. Defaults to true, or false when appending a signers or chain signature to a signed BOM.",
  })
  .option("sign-services", {
    type: "boolean",
    description:
      "Sign granular services. Defaults to true, or false when appending a signers or chain signature to a signed BOM.",
  })
  .option("sign-annotations", {
    type: "boolean",
    description:
      "Sign granular annotations. Defaults to true, or false when appending a signers or chain signature to a signed BOM.",
  })
  .option("attach", {
    type: "string",
    description:
      "Attach the signed SBOM to the specified OCI image reference natively.",
  })
  .scriptName("cdx-sign")
  .version(retrieveCdxgenVersion())
  .help()
  .wrap(Math.min(120, yargs().terminalWidth())).argv;

if (!safeExistsSync(args.input)) {
  console.error(`Input file '${args.input}' not found.`);
  process.exit(1);
}

let hasPrivateKey = false;
let privateKeyContent = null;

const envPrivateKeyFile = readEnvironmentVariable("SBOM_SIGN_PRIVATE_KEY", {
  sensitive: true,
});
const envPrivateKeyBase64 = readEnvironmentVariable(
  "SBOM_SIGN_PRIVATE_KEY_BASE64",
  {
    sensitive: true,
  },
);

if (args.privateKey) {
  if (safeExistsSync(args.privateKey)) {
    privateKeyContent = fs.readFileSync(args.privateKey);
    hasPrivateKey = true;
  } else {
    console.error(`Private key file '${args.privateKey}' not found.`);
    process.exit(1);
  }
} else if (envPrivateKeyFile) {
  if (safeExistsSync(envPrivateKeyFile)) {
    privateKeyContent = fs.readFileSync(envPrivateKeyFile);
    hasPrivateKey = true;
  } else {
    console.error(
      `Private key file '${envPrivateKeyFile}' from SBOM_SIGN_PRIVATE_KEY environment variable not found.`,
    );
    process.exit(1);
  }
} else if (envPrivateKeyBase64) {
  try {
    privateKeyContent = Buffer.from(envPrivateKeyBase64, "base64");
    hasPrivateKey = true;
  } catch {
    console.error(
      "Failed to decode SBOM_SIGN_PRIVATE_KEY_BASE64 environment variable.",
    );
    process.exit(1);
  }
}

function hasAnySignature(bomJson) {
  if (bomJson.signature) return true;
  if (
    Array.isArray(bomJson.components) &&
    bomJson.components.some((c) => c.signature)
  )
    return true;
  if (
    Array.isArray(bomJson.services) &&
    bomJson.services.some((s) => s.signature)
  )
    return true;
  if (
    Array.isArray(bomJson.annotations) &&
    bomJson.annotations.some((a) => a.signature)
  )
    return true;
  return false;
}

function describeEntry(result) {
  const parts = [];
  if (result.algorithm !== undefined) {
    parts.push(displayValue(result.algorithm));
  }
  if (result.keyId !== undefined) {
    parts.push(`keyId '${displayValue(result.keyId)}'`);
  }
  return parts.length
    ? `entry ${result.index} (${parts.join(", ")})`
    : `entry ${result.index}`;
}

// A new chain entry covers every earlier entry, so the signer vouches for that
// history, and every entry must verify. A new signers entry covers the same
// content as the existing entries, so at least one must verify to show the
// content is still what an earlier signer signed.
function checkExistingSignatures(bomJson) {
  const existing = bomJson.signature;
  const otherForm = args.mode === "chain" ? "signers" : "chain";
  if (
    args.mode === "replace" ||
    existing === undefined ||
    (existing !== null &&
      typeof existing === "object" &&
      Object.hasOwn(existing, otherForm))
  ) {
    return;
  }
  const keys = (args.verifyExistingWith || []).map((keyFile) => {
    if (!safeExistsSync(keyFile)) {
      throw new Error(`Public key file '${keyFile}' not found.`);
    }
    return fs.readFileSync(keyFile, "utf8");
  });
  const results = checkSignatureEntries(bomJson, keys);
  const unverified = results.filter((result) => !result.verified);
  const chain = args.mode === "chain";
  if (chain ? !unverified.length : unverified.length < results.length) {
    return;
  }
  const details = unverified.map(
    (result) =>
      `  - ${describeEntry(result)}: ${result.reasons[0] || "no --verify-existing-with key was given"}`,
  );
  if (args.allowUnverifiedHistory) {
    console.warn(
      [
        chain
          ? `Warning: appending to a chain with ${unverified.length} unverified entry(s):`
          : `Warning: appending a signers entry although none of the ${unverified.length} existing entry(s) verified:`,
        ...details,
      ].join("\n"),
    );
    return;
  }
  throw new Error(
    [
      chain
        ? `the new chain entry would vouch for ${unverified.length} existing entry(s) that could not be verified:`
        : `none of the ${unverified.length} existing signature entry(s) could be verified, so the content may have changed since it was signed:`,
      ...details,
      "Pass --verify-existing-with <public key> for each earlier signer, or --allow-unverified-history to sign anyway.",
    ].join("\n"),
  );
}

try {
  const bomJson = parseStrictJson(fs.readFileSync(args.input));
  if (!isCycloneDxBom(bomJson)) {
    console.error(getNonCycloneDxErrorMessage(bomJson, "cdx-sign"));
    process.exit(1);
  }

  let signedBom = bomJson;
  if (hasPrivateKey && privateKeyContent) {
    checkExistingSignatures(bomJson);
    signedBom = signBom(bomJson, {
      privateKey: privateKeyContent,
      algorithm: args.algorithm,
      embedPublicKey: args.embedPublicKey,
      embedPublicKeyNested: false,
      keyId: args.keyId,
      mode: args.mode,
      signComponents: args.signComponents,
      signServices: args.signServices,
      signAnnotations: args.signAnnotations,
    });

    const outputPath = args.output || args.input;
    safeWriteSync(outputPath, JSON.stringify(signedBom, null, null));

    console.log(`Successfully signed BOM and saved to '${outputPath}'`);
    console.log(
      `Mode: ${args.mode} | Algorithm: ${args.algorithm}${args.keyId ? ` | KeyId: ${args.keyId}` : ""}`,
    );
    const rootSignature = signedBom.signature;
    const newEntry =
      rootSignature?.signers?.at(-1) ??
      rootSignature?.chain?.at(-1) ??
      rootSignature;
    if (
      args.embedPublicKey &&
      !String(args.algorithm).startsWith("HS") &&
      newEntry?.publicKey === undefined
    ) {
      console.warn(
        "Warning: this key type has no JWK form, so the public key was not embedded in the signature.",
      );
    }
  } else {
    if (!hasAnySignature(bomJson)) {
      console.error(
        "Private key not provided, and the BOM does not contain any signatures.",
      );
      process.exit(1);
    }
    console.log(
      "Private key not provided. BOM contains existing signature(s); skipping signing step.",
    );
  }

  if (args.attach) {
    const { attachBomNative } = await import("../lib/managers/oci.js");
    await attachBomNative(args.attach, signedBom);
  }
} catch (error) {
  console.error("SBOM signing failed:", error.message);
  process.exit(1);
}
