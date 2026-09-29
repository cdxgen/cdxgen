#!/usr/bin/env node

import fs from "node:fs";
import { join } from "node:path";
import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import {
  displayValue,
  loadSharedSecret,
  loadVerificationKey,
  verifyNode,
} from "../lib/helpers/bomSigner.js";
import {
  getNonCycloneDxErrorMessage,
  isCycloneDxBom,
} from "../lib/helpers/bomUtils.js";
import { isProtoBomPath } from "../lib/helpers/protobomLoader.js";
import {
  dirNameStr,
  retrieveCdxgenVersion,
  safeExistsSync,
} from "../lib/helpers/utils.js";
import { getBomWithOras } from "../lib/managers/oci.js";

const dirName = dirNameStr;

const _yargs = yargs(hideBin(process.argv));

const args = _yargs
  .option("input", {
    alias: "i",
    default: "bom.json",
    description:
      "Input CycloneDX JSON or protobuf BOM to verify. Default bom.json",
  })
  .option("platform", {
    description: "The platform to validate. No default",
  })
  .option("public-key", {
    description:
      "Public key in PEM format. Default public.key unless --secret-key is used",
  })
  .option("secret-key", {
    description:
      "File holding the shared secret for HMAC (HS256, HS384, HS512) signatures. HMAC signatures are only accepted with this option.",
  })
  .option("deep", {
    type: "boolean",
    default: true,
    description:
      "Strictly verify all nested component, service, and annotation signatures against the provided public key. Pass --no-deep to verify only the root signature.",
  })
  .completion("completion", "Generate bash/zsh completion")
  .epilogue("for documentation, visit https://cdxgen.github.io/cdxgen")
  .scriptName("cdx-verify")
  .version(retrieveCdxgenVersion())
  .help(false)
  .option("help", {
    alias: "h",
    type: "boolean",
    description: "Show help",
  })
  .wrap(Math.min(120, yargs().terminalWidth())).argv;

if (args.help) {
  console.log(`${retrieveCdxgenVersion()}\n`);
  _yargs.showHelp();
  process.exit(0);
}

if (args.version) {
  const packageJsonAsString = fs.readFileSync(
    join(dirName, "..", "package.json"),
    "utf-8",
  );
  const packageJson = JSON.parse(packageJsonAsString);

  console.log(packageJson.version);
  process.exit(0);
}

if (process.env?.CDXGEN_NODE_OPTIONS) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} ${process.env.CDXGEN_NODE_OPTIONS}`;
}

async function getBom(args) {
  if (safeExistsSync(args.input)) {
    if (isProtoBomPath(args.input)) {
      console.log(
        "cdx-verify: protobuf BOM input does not currently preserve JSF signature blocks. Verify signatures against the source JSON BOM instead.",
      );
      process.exit(1);
    }
    try {
      return JSON.parse(fs.readFileSync(args.input, "utf8"));
    } catch (error) {
      console.log(`Failed to parse '${args.input}': ${error.message}`);
      process.exit(1);
    }
  }
  if (
    args.input.includes(":") ||
    args.input.includes("docker") ||
    args.input.includes("ghcr")
  ) {
    return await getBomWithOras(args.input, args.platform);
  }
  return undefined;
}

const bomJson = await getBom(args);

if (!bomJson) {
  console.log(`${args.input} is invalid!`);
  process.exit(1);
}
if (!isCycloneDxBom(bomJson)) {
  console.log(getNonCycloneDxErrorMessage(bomJson, "cdx-verify"));
  process.exit(1);
}

if (args.publicKey && args.secretKey) {
  console.log("Use either --public-key or --secret-key, not both.");
  process.exit(1);
}
const keyFile = args.secretKey || args.publicKey || "public.key";
if (!args.secretKey && !args.publicKey) {
  console.log(
    `No --public-key given; using '${keyFile}' from the current directory. Pass --public-key to name the trusted key explicitly.`,
  );
}
if (!safeExistsSync(keyFile)) {
  console.log(
    args.secretKey
      ? "Shared secret for signature verification is missing!"
      : "Public key for signature verification is missing!",
  );
  process.exit(1);
}

let verificationKey;
try {
  verificationKey = args.secretKey
    ? loadSharedSecret(fs.readFileSync(keyFile))
    : loadVerificationKey(fs.readFileSync(keyFile, "utf8"));
} catch (error) {
  console.log(`Unable to use '${keyFile}': ${error.message}`);
  process.exit(1);
}

function verify(node) {
  const reasons = [];
  const match = verifyNode(node, verificationKey, { reasons });
  return { match, reasons };
}

function printReasons(reasons) {
  for (const reason of new Set(reasons)) {
    console.log(`  - ${reason}`);
  }
}

let rootResult = null;
if (bomJson.signature) {
  rootResult = verify(bomJson);
}

const verifyNested = args.deep || !bomJson.signature;
let hasInvalidNested = false;
let checkedNested = 0;

if (verifyNested) {
  const nestedTargets = [
    ["components", "Component", (c) => c["bom-ref"] || c.name],
    ["services", "Service", (s) => s["bom-ref"] || s.name],
    ["annotations", "Annotation", (a) => a["bom-ref"] || a.subject],
  ];
  for (const [field, label, nameOf] of nestedTargets) {
    for (const node of bomJson[field] || []) {
      if (node?.signature) {
        checkedNested++;
        const result = verify(node);
        if (!result.match) {
          console.log(
            `${label} '${displayValue(nameOf(node))}' signature is invalid!`,
          );
          printReasons(result.reasons);
          hasInvalidNested = true;
        }
      }
    }
  }
}

if (hasInvalidNested) {
  console.log("One or more nested signatures are invalid!");
  if (rootResult?.match) {
    console.log(
      "The root signature verifies with this key. Nested signatures belong to the party that created them, so pass --no-deep to verify only the root signature with this key.",
    );
  }
  process.exit(1);
}

if (bomJson.signature) {
  const rootMatch = rootResult?.match;
  if (rootMatch) {
    const identifier = rootMatch.keyId
      ? `KeyId: '${displayValue(rootMatch.keyId)}'`
      : `Algorithm: '${rootMatch.algorithm}'`;
    console.log(`✓ Signature is valid! (Matched ${identifier})`);
  } else {
    console.log("BOM signature is invalid!");
    printReasons(rootResult?.reasons || []);
    console.log(
      "If this BOM was signed with cdxgen 12.8.4, 13.2.0, or an earlier release, re-sign it with this version of cdx-sign.",
    );
    process.exit(1);
  }
} else if (checkedNested > 0 && !hasInvalidNested) {
  console.log(`✓ ${checkedNested} nested signature(s) are valid!`);
} else {
  console.log("No valid signatures found to verify!");
  process.exit(1);
}
