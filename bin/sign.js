#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { escapeControlCharacters } from "../lib/core/text.js";
import {
  readEnvironmentVariable,
  retrieveCdxgenVersion,
  safeExistsSync,
  safeWriteSync,
} from "../lib/ecosystems/utils.js";
import {
  checkSignatureEntries,
  displayValue,
  signBom,
} from "../lib/helpers/bomSigner.js";
import {
  countersignJss,
  removeJssSignatures,
  selectJssAlgorithmForKey,
  signJssBom,
  verifyJss,
} from "../lib/helpers/jssSigner.js";
import {
  getNonCycloneDxErrorMessage,
  isCycloneDx20SpecVersion,
  isCycloneDxBom,
} from "../lib/inventory/bomUtils.js";
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
    default: readEnvironmentVariable("SBOM_SIGN_ALGORITHM"),
    defaultDescription:
      "SBOM_SIGN_ALGORITHM, else RS512 for JSF (1.x) or derived from the key for JSS (2.0)",
    description:
      "Signature algorithm (e.g., RS512, ES256, Ed25519). It must match the key type. For a CycloneDX 2.0 (JSS) document it defaults to ES256/ES384/ES512 by curve, RS256 for rsa, PS256 for rsa-pss, Ed25519 or Ed448.",
  })
  .option("mode", {
    alias: "m",
    default: readEnvironmentVariable("SBOM_SIGN_MODE") || "replace",
    choices: ["replace", "signers", "chain"],
    description:
      "Signature mode. Use 'signers' for multi-signing, 'chain' for sequential chaining. At 2.0 (JSS), 'replace' removes every existing JSS signature, 'signers' appends a root signature (X.590 clause 7.1), and 'chain' countersigns the only root signature (X.590 clause 7.2).",
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
  // CycloneDX 2.0 carries JSS signatures in `signatures` lists.
  if (Array.isArray(bomJson.signatures) && bomJson.signatures.length)
    return true;
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
      ]
        .map((line) => escapeControlCharacters(line))
        .join("\n"),
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

function signJsfDocument(bomJson) {
  const jsfAlgorithm = args.algorithm || "RS512";
  checkExistingSignatures(bomJson);
  const signedBom = signBom(bomJson, {
    privateKey: privateKeyContent,
    algorithm: jsfAlgorithm,
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
    `Mode: ${args.mode} | Algorithm: ${jsfAlgorithm}${args.keyId ? ` | KeyId: ${args.keyId}` : ""}`,
  );
  const rootSignature = signedBom.signature;
  const newEntry =
    rootSignature?.signers?.at(-1) ??
    rootSignature?.chain?.at(-1) ??
    rootSignature;
  if (
    args.embedPublicKey &&
    !String(jsfAlgorithm).startsWith("HS") &&
    newEntry?.publicKey === undefined
  ) {
    console.warn(
      "Warning: this key type has no JWK form, so the public key was not embedded in the signature.",
    );
  }
  return signedBom;
}

// A JSS (X.590) countersignature of the only root entry vouches for that
// entry and its chain, so every object of the chain must verify (as for a
// JSF chain). A new root entry covers the same content as the existing ones,
// so the existing signatures must pass the cdx-verify policy: at least one
// entry verifies, no entry that names a given key fails, and every
// countersignature verifies.
function checkExistingJssSignatures(bomJson) {
  const chain = args.mode === "chain";
  const keys = (args.verifyExistingWith || []).map((keyFile) => {
    if (!safeExistsSync(keyFile)) {
      throw new Error(`Public key file '${keyFile}' not found.`);
    }
    return fs.readFileSync(keyFile, "utf8");
  });
  const verdict = keys.length
    ? verifyJss(bomJson, { publicKeys: keys })
    : undefined;
  const results = verdict
    ? verdict.results
    : bomJson.signatures.map((entry, index) => ({
        path: `signatures[${index}]`,
        algorithm: entry?.algorithm,
        status: "untrusted",
        reason: "no --verify-existing-with key was given",
      }));
  const unverified = results.filter((result) => result.status !== "verified");
  if (chain ? !unverified.length : verdict?.valid) {
    return;
  }
  const someVerified = unverified.length < results.length;
  const details = unverified.map(
    (result) =>
      `  - ${result.path} (${displayValue(result.algorithm)}): ${result.reason || "not verified"}`,
  );
  if (args.allowUnverifiedHistory) {
    console.warn(
      [
        chain
          ? `Warning: countersigning a JSS signature chain with ${unverified.length} unverified signature object(s):`
          : someVerified
            ? `Warning: appending a JSS signature although ${unverified.length} existing signature object(s) failed verification:`
            : `Warning: appending a JSS signature although none of the ${unverified.length} existing signature object(s) verified:`,
        ...details,
      ]
        .map((line) => escapeControlCharacters(line))
        .join("\n"),
    );
    return;
  }
  throw new Error(
    [
      chain
        ? `the countersignature would vouch for ${unverified.length} existing JSS signature object(s) that could not be verified:`
        : someVerified
          ? "the existing JSS signatures do not pass verification, so cdx-verify would reject the signed document:"
          : `none of the ${unverified.length} existing JSS signature object(s) could be verified, so the content may have changed since it was signed:`,
      ...details,
      "Pass --verify-existing-with <public key> for each earlier signer, or --allow-unverified-history to sign anyway.",
    ].join("\n"),
  );
}

/**
 * Signs a CycloneDX 2.0 document with JSS (ITU-T X.590).
 *
 * - replace: every existing JSS signature is removed (with a warning that
 *   names how many), then the root and the nested members are signed;
 * - signers: a root entry is appended. X.590 clause 7.1.2 removes the
 *   existing entries before canonicalizing, so they stay valid;
 * - chain: the only root entry is countersigned (X.590 clause 7.2). A JSF
 *   chain entry covers every earlier entry, while a JSS countersignature
 *   covers only the entry it countersigns, so the two agree only when the
 *   root has a single entry; otherwise chain mode is refused.
 *
 * Nested members are signed only when no root signature is kept: signing
 * them changes content the existing root entries cover.
 */
function signJssDocument(bomJson) {
  if (args.embedPublicKey === false) {
    throw new Error(
      "--no-embed-public-key is not supported for CycloneDX 2.0 (JSS): X.590 clause 6.2.1 requires public_key, public_cert_chain, cert_url or thumbprint in every signature object, and cdx-sign writes public_key.",
    );
  }
  if (args.keyId !== undefined) {
    console.warn(
      "Warning: --key-id is not used for CycloneDX 2.0 (JSS) signatures, which identify the key by public_key.",
    );
  }
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(privateKeyContent);
  } catch (error) {
    throw new Error(`Unable to load the JSS signing key: ${error.message}`);
  }
  const algorithm = args.algorithm || selectJssAlgorithmForKey(privateKey);
  const rootEntries = Array.isArray(bomJson.signatures)
    ? bomJson.signatures
    : [];
  const appending = args.mode !== "replace" && rootEntries.length > 0;
  const nestedFlags = [
    ["components", args.signComponents],
    ["services", args.signServices],
    ["annotations", args.signAnnotations],
  ];
  if (appending) {
    const requested = nestedFlags.find(([, value]) => value === true);
    if (requested) {
      throw new Error(
        `Cannot sign ${requested[0]} while appending a ${args.mode} JSS signature, because that changes content covered by the existing root signature(s). Sign the root only (for example, --no-sign-${requested[0]}), or use --mode replace.`,
      );
    }
    if (args.mode === "chain" && rootEntries.length !== 1) {
      throw new Error(
        `--mode chain is not supported for JSS when the BOM has ${rootEntries.length} root signatures: an X.590 clause 7.2 countersignature covers only the entry it countersigns, while a chain entry must cover every earlier entry. Use --mode signers to append a root signature.`,
      );
    }
    checkExistingJssSignatures(bomJson);
  }
  // At 2.0 the nested members (inventories, their components, compositions
  // and annotations) are signed together; any --no-sign-* signs the root
  // only.
  const deep = !appending && nestedFlags.every(([, value]) => value !== false);
  const signOptions = { algorithm, privateKey };
  let signedBom;
  let label = args.mode;
  if (args.mode === "replace") {
    const { bom, removed } = removeJssSignatures(bomJson);
    if (removed) {
      console.warn(
        `Replacing ${removed} existing JSS signature(s) (--mode replace). Use --mode signers to keep them.`,
      );
    }
    signedBom = signJssBom(bom, { ...signOptions, deep });
  } else if (appending && args.mode === "chain") {
    signedBom = countersignJss(bomJson, { ...signOptions, index: 0 });
    label = "chain (X.590 clause 7.2 countersignature)";
  } else {
    signedBom = signJssBom(bomJson, { ...signOptions, deep });
    if (args.mode === "chain") {
      label = "chain (first signature)";
    }
  }
  console.log(`Mode: ${label} | Format: JSS | Algorithm: ${algorithm}`);
  return signedBom;
}

try {
  const bomJson = parseStrictJson(fs.readFileSync(args.input));
  if (!isCycloneDxBom(bomJson)) {
    console.error(
      escapeControlCharacters(getNonCycloneDxErrorMessage(bomJson, "cdx-sign")),
    );
    process.exit(1);
  }

  let signedBom = bomJson;
  if (hasPrivateKey && privateKeyContent) {
    if (
      isCycloneDx20SpecVersion(bomJson.specVersion) ||
      bomJson.specFormat !== undefined
    ) {
      // A CycloneDX 2.0 document signs with JSS (ITU-T X.590); the JSF
      // signer below is 1.x only.
      signedBom = signJssDocument(bomJson);
      const jssOutputPath = args.output || args.input;
      safeWriteSync(jssOutputPath, JSON.stringify(signedBom, null, null));
      console.log(`Successfully signed BOM and saved to '${jssOutputPath}'`);
    } else {
      signedBom = signJsfDocument(bomJson);
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
  console.error(
    "SBOM signing failed:",
    escapeControlCharacters(String(error?.message)),
  );
  process.exit(1);
}
