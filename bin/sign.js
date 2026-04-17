#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { signBom } from "../lib/helpers/bomSigner.js";
import { retrieveCdxgenVersion, safeExistsSync } from "../lib/helpers/utils.js";

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
    demandOption: true,
    description: "Private key in PEM format.",
  })
  .option("algorithm", {
    alias: "a",
    default: "RS512",
    description: "JSF Signature Algorithm (e.g., RS512, ES256, Ed25519).",
  })
  .option("mode", {
    alias: "m",
    default: "replace",
    choices: ["replace", "signers", "chain"],
    description:
      "Signature mode. Use 'signers' for multi-signing, 'chain' for sequential chaining.",
  })
  .option("key-id", {
    description:
      "Optional identifier for the key (keyId) to embed in the signature block.",
  })
  .option("sign-components", {
    type: "boolean",
    default: true,
    description:
      "Sign granular components. Disable (--no-sign-components) when appending multi-signatures.",
  })
  .option("sign-services", {
    type: "boolean",
    default: true,
    description:
      "Sign granular services. Disable (--no-sign-services) when appending multi-signatures.",
  })
  .option("sign-annotations", {
    type: "boolean",
    default: true,
    description:
      "Sign granular annotations. Disable (--no-sign-annotations) when appending multi-signatures.",
  })
  .scriptName("cdx-sign")
  .version(retrieveCdxgenVersion())
  .help()
  .wrap(Math.min(120, yargs().terminalWidth())).argv;

if (!safeExistsSync(args.input)) {
  console.error(`Input file '${args.input}' not found.`);
  process.exit(1);
}

if (!safeExistsSync(args.privateKey)) {
  console.error(`Private key file '${args.privateKey}' not found.`);
  process.exit(1);
}

try {
  const bomJson = JSON.parse(fs.readFileSync(args.input, "utf8"));
  const privateKey = fs.readFileSync(args.privateKey, "utf8");

  const signedBom = signBom(bomJson, {
    privateKey,
    algorithm: args.algorithm,
    keyId: args.keyId,
    mode: args.mode,
    signComponents: args.signComponents,
    signServices: args.signServices,
    signAnnotations: args.signAnnotations,
  });

  const outputPath = args.output || args.input;
  fs.writeFileSync(outputPath, JSON.stringify(signedBom, null, null));

  console.log(`Successfully signed BOM and saved to '${outputPath}'`);
  console.log(
    `Mode: ${args.mode} | Algorithm: ${args.algorithm}${args.keyId ? ` | KeyId: ${args.keyId}` : ""}`,
  );
} catch (error) {
  console.error("SBOM signing failed:", error.message);
  process.exit(1);
}
