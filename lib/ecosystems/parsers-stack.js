import { readFileSync } from "node:fs";

import { parse as loadYaml } from "../core/yaml.js";
import { tryBuildPurl } from "../inventory/purl.js";

/**
 * Haskell Stack parser for `stack.yaml` and its lock file.
 *
 * Stack resolves packages from a snapshot plus the `extra-deps` a project
 * declares, and writes the completed locations to `stack.yaml.lock` (named
 * after the configuration file, so a custom `foo.yaml` locks to
 * `foo.yaml.lock`). The lock is YAML with two lists:
 *
 *   - `packages` — one entry per extra-dep, each holding the `original`
 *     incomplete specification and the `completed` location. A Hackage
 *     location is the string `<name>-<version>@sha256:<hex>,<size>`; a
 *     repository location carries `url`, `commit` and `subdir`.
 *   - `snapshots` — the resolved snapshot chain, each with the `original`
 *     name (`lts-22.28`) and the `completed` url, size and sha256.
 *
 * The lock pins only the extra-deps: packages taken from the snapshot are not
 * listed, because the snapshot url and digest already pin them. The snapshot
 * is therefore recorded on the parent component rather than expanded.
 *
 * Hackage packages are identified with the registered `hackage` purl type
 * (`pkg:hackage/<name>@<version>`).
 */

/**
 * Parse a Stack project from its lock file, with optional `stack.yaml`.
 *
 * @param {string} stackLockFile Path to `stack.yaml.lock` or `stack.lock`
 * @param {string} [stackYamlFile] Path to `stack.yaml`, if present
 * @returns {{ pkgList: object[], parentComponent: object, rootInputs: string[] }}
 */
export function parseStackProject(stackLockFile, stackYamlFile) {
  const lock = readYamlFile(stackLockFile);
  const stackYaml = stackYamlFile ? readYamlFile(stackYamlFile) : undefined;
  const snapshot = snapshotName(lock, stackYaml);

  const pkgList = [];
  const seen = new Set();
  for (const entry of Array.isArray(lock?.packages) ? lock.packages : []) {
    const pkg = stackPackageFromEntry(entry, stackLockFile);
    if (!pkg || seen.has(pkg["bom-ref"])) {
      continue;
    }
    seen.add(pkg["bom-ref"]);
    pkgList.push(pkg);
  }

  const parentComponent = {};
  if (stackYamlFile || pkgList.length) {
    const name =
      typeof stackYaml?.name === "string" && stackYaml.name
        ? stackYaml.name
        : projectDirName(stackYamlFile || stackLockFile);
    parentComponent.type = "application";
    parentComponent.name = name;
    parentComponent.description = `Haskell Stack project: ${name}`;
    parentComponent.properties = [
      { name: "internal:SrcFile", value: stackYamlFile || stackLockFile },
    ];
    if (snapshot) {
      parentComponent.properties.push({
        name: "cdx:stack:snapshot",
        value: snapshot,
      });
    }
  }
  return {
    pkgList,
    parentComponent,
    rootInputs: pkgList.map((pkg) => pkg["bom-ref"]),
  };
}

/**
 * Build a package record from one `packages` entry of the lock.
 *
 * @param {object} entry Lock entry with `original` and `completed`
 * @param {string} srcFile Lock file path for provenance
 * @returns {object|undefined} Package record, or undefined when unrecognised
 */
function stackPackageFromEntry(entry, srcFile) {
  const completed = entry?.completed ?? {};
  const original = entry?.original ?? {};
  const hackage =
    typeof completed.hackage === "string"
      ? completed.hackage
      : typeof original.hackage === "string"
        ? original.hackage
        : undefined;
  if (hackage) {
    return hackagePackage(hackage, srcFile);
  }
  // Repository extra-deps pin a commit rather than a Hackage release; the
  // package name is the repository's last path segment unless a subdir names
  // the package more precisely.
  const url = typeof completed.url === "string" ? completed.url : undefined;
  const commit =
    typeof completed.commit === "string" ? completed.commit : undefined;
  if (!url) {
    return undefined;
  }
  const subdir =
    typeof completed.subdir === "string" && completed.subdir
      ? completed.subdir.split("/").filter(Boolean).pop()
      : undefined;
  const repoName = url
    .split(/[?#]/u)[0]
    .replace(/\.git$/u, "")
    .split("/")
    .filter(Boolean)
    .pop();
  const name = subdir || repoName;
  if (!name) {
    return undefined;
  }
  return finishPackage(name, commit, srcFile, [
    { name: "cdx:stack:repository", value: url },
    ...(commit ? [{ name: "cdx:stack:commit", value: commit }] : []),
  ]);
}

/**
 * Build a package record from a Hackage location string.
 *
 * The string is `<name>-<version>@sha256:<hex>,<size>`; the trailing
 * `-<version>` separates the name, and the digest covers the package tarball.
 *
 * @param {string} location Hackage location as the lock writes it
 * @param {string} srcFile Lock file path for provenance
 * @returns {object|undefined} Package record
 */
function hackagePackage(location, srcFile) {
  const [coordinate, rest] = splitOnce(location, "@");
  const match = coordinate.match(/^(.+)-(\d[^-]*)$/u);
  if (!match) {
    return undefined;
  }
  const [, name, version] = match;
  const sha256 = rest?.startsWith("sha256:")
    ? rest.slice("sha256:".length).split(",")[0]
    : undefined;
  const pkg = finishPackage(name, version, srcFile, []);
  if (sha256 && /^[0-9a-f]{64}$/iu.test(sha256)) {
    pkg.hashes = [{ alg: "SHA-256", content: sha256.toLowerCase() }];
  }
  return pkg;
}

/**
 * Assemble the common fields of a Stack package record.
 *
 * @param {string} name Package name
 * @param {string|undefined} version Version or pinned commit
 * @param {string} srcFile Lock file path for provenance
 * @param {object[]} extraProperties Additional properties
 * @returns {object} Package record
 */
function finishPackage(name, version, srcFile, extraProperties) {
  const purl = tryBuildPurl({
    type: "hackage",
    name,
    version: version || undefined,
  });
  const pkg = {
    name,
    ...(version ? { version } : {}),
    type: "library",
    scope: "required",
    properties: [
      { name: "internal:SrcFile", value: srcFile },
      // The lock records extra-deps only; snapshot packages never appear.
      { name: "cdx:stack:dependency", value: "extra-dep" },
      ...extraProperties,
    ],
  };
  if (purl) {
    pkg.purl = purl;
    pkg["bom-ref"] = decodeURIComponent(purl);
  } else {
    pkg["bom-ref"] = `library:${name}:${version || ""}`;
  }
  return pkg;
}

/**
 * Determine the snapshot the project resolves against.
 *
 * `stack.yaml` names it under `snapshot` (or the older `resolver`); the lock
 * repeats it as the `original` of the first snapshot entry.
 *
 * @param {object|undefined} lock Parsed lock file
 * @param {object|undefined} stackYaml Parsed `stack.yaml`
 * @returns {string|undefined} Snapshot name or url
 */
function snapshotName(lock, stackYaml) {
  for (const candidate of [stackYaml?.snapshot, stackYaml?.resolver]) {
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }
  const first = Array.isArray(lock?.snapshots) ? lock.snapshots[0] : undefined;
  const original = first?.original;
  if (typeof original === "string" && original) {
    return original;
  }
  if (typeof original?.url === "string" && original.url) {
    return original.url;
  }
  if (typeof first?.completed?.url === "string") {
    return first.completed.url;
  }
  return undefined;
}

/**
 * Split a string at the first occurrence of a separator.
 *
 * @param {string} value Value to split
 * @param {string} separator Separator character
 * @returns {[string, string|undefined]} Head and remainder
 */
function splitOnce(value, separator) {
  const index = value.indexOf(separator);
  if (index === -1) {
    return [value, undefined];
  }
  return [value.slice(0, index), value.slice(index + 1)];
}

/**
 * Derive a project name from the directory holding the Stack files.
 *
 * Stack manifests never carry a project name, so the directory is the name
 * developers already use for the project.
 *
 * @param {string} filePath File path
 * @returns {string} Directory name
 */
function projectDirName(filePath) {
  const segments = filePath.split(/[\\/]/u).filter(Boolean);
  // Drop the file itself, keeping the directory.
  segments.pop();
  return segments[segments.length - 1] || "stack-project";
}

/**
 * Read and parse a YAML file, warning instead of throwing.
 *
 * @param {string} filePath File to read
 * @returns {object|undefined} Parsed value
 */
function readYamlFile(filePath) {
  try {
    return loadYaml(readFileSync(filePath, "utf-8"));
  } catch (error) {
    console.warn(`Failed to parse ${filePath}: ${error.message}`);
    return undefined;
  }
}
