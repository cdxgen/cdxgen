#!/usr/bin/env node

import fs from "node:fs";
import { join } from "node:path";
import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { verifyNode } from "../lib/helpers/bomSigner.js";
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
    description: "Input json to validate. Default bom.json",
  })
  .option("platform", {
    description: "The platform to validate. No default",
  })
  .option("public-key", {
    default: "public.key",
    description: "Public key in PEM format. Default public.key",
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

function getBom(args) {
  if (fs.existsSync(args.input)) {
    return JSON.parse(fs.readFileSync(args.input, "utf8"));
  }
  if (
    args.input.includes(":") ||
    args.input.includes("docker") ||
    args.input.includes("ghcr")
  ) {
    return getBomWithOras(args.input, args.platform);
  }
  return undefined;
}

const bomJson = getBom(args);

if (!bomJson) {
  console.log(`${args.input} is invalid!`);
  process.exit(1);
}

if (bomJson && !safeExistsSync(args.publicKey)) {
  console.log("Public key for signature verification is missing!");
  process.exit(1);
}

const publicKeyStr = fs.readFileSync(args.publicKey, "utf8");

let rootMatch = null;
if (bomJson.signature) {
  rootMatch = verifyNode(bomJson, publicKeyStr);
}

const verifyNested = args.deep || !bomJson.signature;
let hasInvalidNested = false;
let checkedNested = 0;

if (verifyNested) {
  for (const comp of bomJson.components || []) {
    if (comp.signature) {
      checkedNested++;
      if (!verifyNode(comp, publicKeyStr)) {
        console.log(
          `Component '${comp["bom-ref"] || comp.name}' signature is invalid!`,
        );
        hasInvalidNested = true;
      }
    }
  }
  for (const svc of bomJson.services || []) {
    if (svc.signature) {
      checkedNested++;
      if (!verifyNode(svc, publicKeyStr)) {
        console.log(
          `Service '${svc["bom-ref"] || svc.name}' signature is invalid!`,
        );
        hasInvalidNested = true;
      }
    }
  }
  for (const ann of bomJson.annotations || []) {
    if (ann.signature) {
      checkedNested++;
      if (!verifyNode(ann, publicKeyStr)) {
        console.log(
          `Annotation '${ann["bom-ref"] || ann.subject}' signature is invalid!`,
        );
        hasInvalidNested = true;
      }
    }
  }
}

if (hasInvalidNested) {
  console.log("One or more nested signatures are invalid!");
  process.exit(1);
}

if (bomJson.signature) {
  if (rootMatch) {
    const identifier = rootMatch.keyId
      ? `KeyId: '${rootMatch.keyId}'`
      : `Algorithm: '${rootMatch.algorithm}'`;
    console.log(`✓ Signature is valid! (Matched ${identifier})`);
  } else {
    console.log("BOM signature is invalid!");
    process.exit(1);
  }
} else if (checkedNested > 0 && !hasInvalidNested) {
  console.log(`✓ ${checkedNested} nested signature(s) are valid!`);
} else {
  console.log("No valid signatures found to verify!");
  process.exit(1);
}
