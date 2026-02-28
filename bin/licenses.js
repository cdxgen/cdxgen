#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const CURRENT_LICENSES = [
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-3.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "WTFPL",
];

const newLicenses = new Map();
const noLicenses = [];

if (existsSync("./bom.json")) {
  const sbom = JSON.parse(readFileSync("./bom.json", "utf8"));

  for (const component of sbom.components) {
    const componentID =
      (component.group !== "" ? `${component.group}/` : "") +
      `${component.name}@${component.version}`;
    if (component.licenses) {
      for (const license of component.licenses) {
        if (license.license) {
          if (!CURRENT_LICENSES.includes(license.license.id)) {
            newLicenses.set(componentID, license.license.id);
          }
        } else if (license.expression) {
          const licenses = license.expression
            .replaceAll("(", "")
            .replaceAll(")", "")
            .split(/ (?:and|or) /i);
          for (const aLicense of licenses) {
            if (!CURRENT_LICENSES.includes(aLicense)) {
              newLicenses.set(componentID, license.expression);
              break;
            }
          }
        } else {
          noLicenses.push(componentID);
        }
      }
    } else {
      noLicenses.push(componentID);
    }
  }

  if (newLicenses.size) {
    console.log(
      "The following dependencies have licenses that are not yet used in the project:",
    );
    for (const dependency of newLicenses.keys()) {
      console.log(`  - ${dependency}: ${newLicenses.get(dependency)}`);
    }
    console.log(
      "If the licenses are allowed, add them to CURRENT_LICENSES in 'bin/licenses.js'.",
    );
  }

  if (noLicenses.length) {
    console.log("The following dependencies have NO license:");
    for (const dependency of noLicenses) {
      console.log(`  - ${dependency}`);
    }
    console.log(
      "If this is correct and the dependency should be allowed, an ignore mechanism should be implemented!",
    );
  }
}

export function checkLicenses() {
  return newLicenses.size + noLicenses.length;
}
