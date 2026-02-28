#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { parse as yaml } from "yaml";

const pkgJson = JSON.parse(readFileSync("./package.json", "utf8"));
const pnpmLockYaml = yaml(readFileSync("./pnpm-lock.yaml", "utf8"));

const installedPackages = [];

const incorrectNpmOverridesVersions = [];
const incorrectPnpmOverridesVersions = [];
const missingNpmOverrides = [];
const missingPnpmOverrides = [];

const obsoleteNpmOverrides = [];
const obsoletePnpmOverrides = [];

for (const _package in pkgJson.dependencies) {
  checkOverride(_package, pkgJson.dependencies[_package]);
}
for (const _package in pkgJson.devDependencies) {
  checkOverride(_package, pkgJson.devDependencies[_package]);
}
for (const _package in pkgJson.optionalDependencies) {
  checkOverride(_package, pkgJson.optionalDependencies[_package]);
}
for (const _package in pnpmLockYaml.snapshots) {
  const indexOfSeparator = _package.split("(")[0].lastIndexOf("@");
  const packageName = _package.substring(0, indexOfSeparator);
  const packageVersion = _package.substring(indexOfSeparator + 1);
  if (!installedPackages.includes(packageName)) {
    installedPackages.push(packageName);
    checkOverride(packageName, packageVersion);
  }
  for (const dependency in pnpmLockYaml.snapshots[_package].dependencies) {
    if (!installedPackages.includes(dependency)) {
      installedPackages.push(dependency);
      checkOverride(
        dependency,
        pnpmLockYaml.snapshots[_package].dependencies[dependency],
      );
    }
  }
  for (const dependency in pnpmLockYaml.snapshots[_package]
    .optionalDependencies) {
    if (!installedPackages.includes(dependency)) {
      installedPackages.push(dependency);
      checkOverride(
        dependency,
        pnpmLockYaml.snapshots[_package].optionalDependencies[dependency],
      );
    }
  }
}
for (const override in pkgJson.overrides) {
  checkObsolescence(override, obsoleteNpmOverrides);
}
for (const override in pkgJson.pnpm.overrides) {
  checkObsolescence(override, obsoletePnpmOverrides);
}

if (missingNpmOverrides.length) {
  console.log("\nThe following dependencies are not in the 'overrides'-block:");
  console.log(missingNpmOverrides.join(",\n"));
}
if (incorrectNpmOverridesVersions.length) {
  console.log(
    "\nThe following dependencies have a different version in the 'overrides'-block:",
  );
  console.log(incorrectNpmOverridesVersions.join("\n"));
}
if (missingPnpmOverrides.length) {
  console.log(
    "\nThe following dependencies are not in the 'pnpm.overrides'-block:",
  );
  console.log(missingPnpmOverrides.join(",\n"));
}
if (incorrectPnpmOverridesVersions.length) {
  console.log(
    "\nThe following dependencies have a different version in the 'pnpm.overrides'-block:",
  );
  console.log(incorrectPnpmOverridesVersions.join("\n"));
}
if (obsoleteNpmOverrides.length) {
  console.log("\nThe following entries in 'overrides' are not used:");
  console.log(obsoleteNpmOverrides.join("\n"));
}
if (obsoletePnpmOverrides.length) {
  console.log("\nThe following entries in 'pnpm.overrides' are not used:");
  console.log(obsoletePnpmOverrides.join("\n"));
}

function checkOverride(packageName, packageVersion) {
  packageVersion = packageVersion.split("(")[0];
  if (packageVersion.includes("@")) {
    packageVersion = `npm:${packageVersion}`;
  }
  if (!Object.hasOwn(pkgJson.overrides, packageName)) {
    missingNpmOverrides.push(`  "${packageName}": "${packageVersion}"`);
  } else if (pkgJson.overrides[packageName] !== packageVersion) {
    incorrectNpmOverridesVersions.push(
      ` - ${packageName} (${pkgJson.overrides[packageName]} instead of ${packageVersion})`,
    );
  }
  if (!Object.hasOwn(pkgJson.pnpm.overrides, packageName)) {
    missingPnpmOverrides.push(`  "${packageName}": "${packageVersion}"`);
  } else if (pkgJson.pnpm.overrides[packageName] !== packageVersion) {
    incorrectPnpmOverridesVersions.push(
      ` - ${packageName} (${pkgJson.pnpm.overrides[packageName]} instead of ${packageVersion})`,
    );
  }
}

function checkObsolescence(override, obsoletionArray) {
  if (!installedPackages.includes(override)) {
    obsoletionArray.push(override);
  }
}

export function checkDependencies() {
  return (
    incorrectNpmOverridesVersions.length +
    incorrectPnpmOverridesVersions.length +
    missingNpmOverrides.length +
    missingPnpmOverrides.length +
    obsoleteNpmOverrides.length +
    obsoletePnpmOverrides.length
  );
}
