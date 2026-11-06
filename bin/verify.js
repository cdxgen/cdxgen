#!/usr/bin/env node

import fs from "node:fs";
import { join } from "node:path";
import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { readEnvironmentVariable } from "../lib/core/activity.js";
import {
  dirNameStr,
  retrieveCdxgenVersion,
  safeExistsSync,
} from "../lib/ecosystems/utils.js";
import {
  displayValue,
  loadSharedSecret,
  loadVerificationKey,
  verifyBomSignatures,
} from "../lib/helpers/bomSigner.js";
import { verifyJssBom } from "../lib/helpers/jssSigner.js";
import {
  getNonCycloneDxErrorMessage,
  isCycloneDxBom,
} from "../lib/inventory/bomUtils.js";
import { isProtoBomPath } from "../lib/inventory/protobomLoader.js";
import { getBomWithOras } from "../lib/managers/oci.js";
import { parseStrictJson } from "../lib/parsers/strictJson.js";

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
    type: "array",
    string: true,
    description:
      "Trusted public key in PEM format. Repeat to trust several keys; a signature entry verifies when one of them verifies it. CycloneDX 2.0 (JSS) documents need at least one: the public_key embedded in a JSS entry is never trusted on its own, and an entry whose public_key is one of these keys must verify with it.",
  })
  .option("secret-key", {
    type: "string",
    description:
      "File holding the shared secret for HMAC (HS256, HS384, HS512) signatures. HMAC signatures are only accepted with this option. Not supported for CycloneDX 2.0 (JSS) documents.",
  })
  .option("deep", {
    type: "boolean",
    default: true,
    description:
      "Strictly verify all nested component, service, and annotation signatures against the provided keys (at 2.0: inventories, their components, compositions, and annotations). Pass --no-deep to verify only the root signature.",
  })
  .option("require-all", {
    type: "boolean",
    default: false,
    description:
      "Require every entry of a signers or chain signature to verify with one of the keys, instead of at least one. At 2.0 every JSS signature object, countersignatures included, must verify with one of the keys, and every key must verify a root signature object.",
  })
  .option("allow-nested-only", {
    type: "boolean",
    default: false,
    description:
      "Accept a BOM without a root signature when every component, service, and annotation carries a signature that verifies (at 2.0: every inventory, inventory component, composition, and annotation). No signature then covers the other members of the BOM.",
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

if (readEnvironmentVariable("CDXGEN_NODE_OPTIONS")) {
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
      return parseStrictJson(fs.readFileSync(args.input));
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
    try {
      return await getBomWithOras(args.input, args.platform, {
        checkBytes: parseStrictJson,
      });
    } catch (error) {
      console.log(
        `Failed to parse the BOM attached to '${args.input}': ${error.message}`,
      );
      process.exit(1);
    }
  }
  return undefined;
}

const publicKeyFiles = args.publicKey || [];
if (publicKeyFiles.length && args.secretKey) {
  console.log("Use either --public-key or --secret-key, not both.");
  process.exit(1);
}
if (!publicKeyFiles.length && !args.secretKey) {
  console.log(
    "Name the trusted key with --public-key <file>, or --secret-key <file> for HMAC signatures.",
  );
  process.exit(1);
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
// A CycloneDX 2.0 document carries JSS signatures (ITU-T X.590).
const isJssBom = bomJson.specVersion === "2.0" || Boolean(bomJson.specFormat);
if (isJssBom && args.secretKey) {
  console.log(
    "--secret-key is not supported for CycloneDX 2.0 (JSS) signatures: X.590 clause 6.2.2 says HMAC algorithms SHOULD NOT be used, and cdx-verify does not verify them. Pass the signer's --public-key instead.",
  );
  process.exit(1);
}

const verificationKeys = [];
for (const keyFile of args.secretKey ? [args.secretKey] : publicKeyFiles) {
  if (!safeExistsSync(keyFile)) {
    console.log(
      args.secretKey
        ? `Shared secret '${keyFile}' for signature verification is missing!`
        : `Public key '${keyFile}' for signature verification is missing!`,
    );
    process.exit(1);
  }
  try {
    verificationKeys.push(
      args.secretKey
        ? loadSharedSecret(fs.readFileSync(keyFile))
        : loadVerificationKey(fs.readFileSync(keyFile, "utf8")),
    );
  } catch (error) {
    console.log(`Unable to use '${keyFile}': ${error.message}`);
    process.exit(1);
  }
}

function describeEntry(node, entry) {
  const parts = [displayValue(entry.algorithm)];
  if (entry.keyId !== undefined) {
    parts.push(`keyId '${displayValue(entry.keyId)}'`);
  }
  const position =
    node.form === "single" ? "" : `${node.form}[${entry.index}] `;
  return `${position}(${parts.join(", ")})`;
}

function printRejections(node) {
  for (const reason of node.reasons) {
    console.log(`  - ${reason}`);
  }
  for (const entry of node.entries) {
    for (const reason of entry.reasons) {
      console.log(
        `  - ${node.form === "single" ? "" : `${node.form}[${entry.index}]: `}${reason}`,
      );
    }
  }
}

function describeJssResult(result) {
  const role = result.depth > 0 ? "countersignature" : "signature";
  return `${result.path} ${role} (${displayValue(result.algorithm)})`;
}

function printJssResults(results, prefix = "") {
  for (const result of results) {
    if (result.status === "verified") {
      console.log(
        `  ✓ ${prefix}${describeJssResult(result)} verified with key #${result.keyIndex + 1}: ${publicKeyFiles[result.keyIndex]}`,
      );
    } else {
      console.log(
        `  - ${prefix}${describeJssResult(result)} ${result.status}: ${result.reason || "not verified"}`,
      );
    }
  }
}

if (isJssBom) {
  // JSS verification (X.590 clause 8.1, countersignatures clause 7.2) with
  // the trusted --public-key values only (clause 8.1.3 "fetch it from a
  // trusted source"); the same --deep, --require-all and
  // --allow-nested-only policy as the JSF path below.
  let jssReport;
  try {
    jssReport = verifyJssBom(bomJson, {
      publicKeys: verificationKeys,
      deep: args.deep,
      requireAll: args.requireAll,
      allowNestedOnly: args.allowNestedOnly,
    });
  } catch (error) {
    console.log(`JSS verification failed: ${error.message}`);
    process.exit(1);
  }
  for (const error of jssReport.errors) {
    console.log(error);
  }
  if (args.requireAll && jssReport.root) {
    jssReport.root.keysMatched.forEach((matched, index) => {
      if (!matched) {
        console.log(`  - key #${index + 1}: ${publicKeyFiles[index]}`);
      }
    });
  }
  if (jssReport.root) {
    console.log(
      jssReport.root.valid
        ? "BOM JSS signatures:"
        : "BOM signature is invalid!",
    );
    for (const reason of jssReport.root.reasons) {
      console.log(`  - ${reason}`);
    }
    printJssResults(jssReport.root.results);
  } else if (!args.allowNestedOnly) {
    console.log(
      "Pass --allow-nested-only to accept a BOM whose inventories, components, compositions, and annotations are all signed.",
    );
  }
  const invalidNested = jssReport.nested.filter((item) => !item.valid);
  for (const item of invalidNested) {
    console.log(`${item.path} signature is invalid!`);
    for (const reason of item.reasons) {
      console.log(`  - ${reason}`);
    }
    printJssResults(item.results);
  }
  if (invalidNested.length) {
    console.log("One or more nested signatures are invalid!");
    if (jssReport.root?.valid) {
      console.log(
        "The root signature verifies with this key. Nested signatures belong to the party that created them, so pass --no-deep to verify only the root signature with this key.",
      );
    }
  }
  if (!jssReport.valid) {
    process.exit(1);
  }
  const unverified = [
    ...jssReport.results,
    ...jssReport.nested.flatMap((item) => item.results),
  ].filter((result) => result.status !== "verified");
  if (unverified.length) {
    console.log(
      `Warning: ${unverified.length} JSS signature object(s) did not verify with the given key(s). Pass --require-all to fail in that case.`,
    );
  }
  if (!jssReport.root) {
    console.log(`✓ ${jssReport.nested.length} nested signature(s) are valid!`);
  }
  console.log("JSS signature(s) verified successfully.");
  process.exit(0);
}

const report = verifyBomSignatures(bomJson, verificationKeys, {
  deep: args.deep,
  allowNestedOnly: args.allowNestedOnly,
  requireAll: args.requireAll,
});

for (const error of report.errors) {
  console.log(error);
}
const keyFiles = args.secretKey ? [args.secretKey] : publicKeyFiles;
if (args.requireAll && report.root?.form) {
  report.root.keysMatched.forEach((matched, index) => {
    if (!matched) {
      console.log(`  - key #${index + 1}: ${keyFiles[index]}`);
    }
  });
}
const invalidNested = report.nested.filter((item) => !item.verified);
for (const item of invalidNested) {
  console.log(`${item.label} signature is invalid!`);
  printRejections(item);
}
if (invalidNested.length) {
  console.log("One or more nested signatures are invalid!");
  if (report.root?.verified) {
    console.log(
      "The root signature verifies with this key. Nested signatures belong to the party that created them, so pass --no-deep to verify only the root signature with this key.",
    );
  }
}
if (report.root && !report.root.verified) {
  console.log("BOM signature is invalid!");
  printRejections(report.root);
  if (!report.root.reasons.length && !report.root.match) {
    console.log(
      "If this BOM was signed with cdxgen 13.2.0 or earlier, re-sign it with this version of cdx-sign.",
    );
  }
}
if (!report.root && !bomJson.signature && !args.allowNestedOnly) {
  console.log(
    "Pass --allow-nested-only to accept a BOM whose components, services, and annotations are all signed.",
  );
}
for (const notice of report.notices) {
  console.log(`Note: ${notice}`);
}
if (!report.verified) {
  process.exit(1);
}

if (report.root) {
  const rootMatch = report.root.match;
  const identifier = rootMatch.keyId
    ? `KeyId: '${displayValue(rootMatch.keyId)}'`
    : `Algorithm: '${rootMatch.algorithm}'`;
  console.log(`✓ Signature is valid! (Matched ${identifier})`);
  const unverified = report.root.entries.filter((entry) => !entry.verified);
  if (unverified.length) {
    console.log(
      `Warning: ${unverified.length} of ${report.root.entries.length} ${report.root.form} entries did not verify with the given key(s). Pass --require-all to fail in that case.`,
    );
    for (const entry of unverified) {
      console.log(
        `  - ${describeEntry(report.root, entry)}: ${entry.reasons[0] || "not verified"}`,
      );
    }
  }
} else {
  console.log(`✓ ${report.nested.length} nested signature(s) are valid!`);
}
const MAX_LISTED_ENTRIES = 10;
const unverifiedNested = report.nested.flatMap((item) =>
  item.entries
    .filter((entry) => !entry.verified)
    .map(
      (entry) =>
        `${item.label} ${describeEntry(item, entry)}: ${entry.reasons[0] || "not verified"}`,
    ),
);
if (unverifiedNested.length) {
  console.log(
    `Warning: ${unverifiedNested.length} nested signature entries did not verify with the given key(s). Pass --require-all to fail in that case.`,
  );
  for (const line of unverifiedNested.slice(0, MAX_LISTED_ENTRIES)) {
    console.log(`  - ${line}`);
  }
  if (unverifiedNested.length > MAX_LISTED_ENTRIES) {
    console.log(`  - and ${unverifiedNested.length - MAX_LISTED_ENTRIES} more`);
  }
}
