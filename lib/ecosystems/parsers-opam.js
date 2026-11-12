import { readFileSync } from "node:fs";

import { tryBuildPurl } from "../inventory/purl.js";

/**
 * OCaml opam parser for `.opam.locked` files.
 *
 * `opam lock` writes a `<name>.opam.locked` file that pins the full resolved
 * dependency set of a project: a `depends:` field listing every package with
 * an equality constraint on its version, and a `pin-depends:` field for
 * packages pinned to a URL. The file is opam's own syntax, a small
 * line-oriented field language, which is read here with a line scanner rather
 * than a monolithic expression.
 *
 * A locked file holds the closure only: it does not record which packages are
 * direct dependencies of the project, so every entry is reported with the
 * same standing and the project root links to all of them.
 *
 * Packages are identified with the registered `opam` purl type
 * (`pkg:opam/<name>@<version>`).
 */

/**
 * Parse an `.opam.locked` (or plain `.opam`) file.
 *
 * @param {string} opamLockedFile Path to the opam file
 * @returns {{ pkgList: object[], pins: Array<{name: string, url: string}> }}
 */
export function parseOpamLockedFile(opamLockedFile) {
  let text;
  try {
    text = readFileSync(opamLockedFile, "utf-8");
  } catch (error) {
    console.warn(`Failed to read ${opamLockedFile}: ${error.message}`);
    return { pkgList: [], pins: [] };
  }

  const depends = [];
  const pins = [];
  const lines = text.split("\n");
  let section;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("depends:")) {
      section = "depends";
      continue;
    }
    if (line.startsWith("pin-depends:")) {
      section = "pin-depends";
      continue;
    }
    // A bare `field:` at the start of a line ends the previous list section.
    if (/^[A-Za-z0-9_-]+:/u.test(line)) {
      section = undefined;
      continue;
    }
    if (section === "depends") {
      collectDependsEntry(line, depends, opamLockedFile);
    } else if (section === "pin-depends") {
      collectPinEntry(line, pins);
    }
  }
  // A pin overrides where a package is fetched from; reflect that on the
  // resolved component so consumers can see the divergence from the registry.
  for (const pin of pins) {
    const target = depends.find((dep) => dep.name === pin.name);
    if (target) {
      target.properties.push({ name: "cdx:opam:pinned", value: "true" });
      target.properties.push({
        name: "cdx:opam:pinSource",
        value: pin.url,
      });
    }
  }
  return { pkgList: depends, pins };
}

/**
 * Turn one `depends` list line into a pinned package record.
 *
 * Entries look like `"dune" {= "3.16.0"}` or `"ocaml" {= "5.1.1" & build}`.
 * Only equality pins carry a version; constraint-only entries are recorded
 * without one so the package is still inventoried.
 *
 * @param {string} line Trimmed list line
 * @param {object[]} depends Accumulator for package records
 * @param {string} srcFile Source path for provenance
 */
function collectDependsEntry(line, depends, srcFile) {
  const nameMatch = line.match(/^"([^"]+)"/u);
  if (!nameMatch) {
    return;
  }
  const name = nameMatch[1];
  let version;
  // Each `{` opens a group that ends at the next `}`. An unclosed `{` ends the
  // search, since no later `{` can be closed either.
  const constraints = [];
  let open = line.indexOf("{");
  while (open !== -1) {
    const close = line.indexOf("}", open + 1);
    if (close === -1) {
      break;
    }
    constraints.push(line.slice(open, close + 1));
    open = line.indexOf("{", close + 1);
  }
  for (const constraint of constraints) {
    // A pin is a standalone `=`, not the tail of `>=`, `<=`, or `!=`.
    const pinned = constraint.match(/(?<![<>!=])=(?!=)\s*"([^"]+)"/u);
    if (pinned) {
      version = pinned[1];
      break;
    }
  }
  if (depends.some((dep) => dep.name === name && dep.version === version)) {
    return;
  }
  const purl = tryBuildPurl({
    type: "opam",
    name,
    version: version || undefined,
  });
  const properties = [{ name: "internal:SrcFile", value: srcFile }];
  const pkg = {
    name,
    ...(version ? { version } : {}),
    type: "library",
    scope: "required",
    properties,
  };
  if (purl) {
    pkg.purl = purl;
    pkg["bom-ref"] = decodeURIComponent(purl);
  } else {
    pkg["bom-ref"] = `library:${name}:${version || ""}`;
  }
  depends.push(pkg);
}

/**
 * Turn one `pin-depends` list line into a pin record.
 *
 * Entries look like `[ "mylib.dev" "git+https://host/path#rev" ]`. The first
 * string is a package *version* identifier — `<name>.<version>` — whereas the
 * matching `depends` entry carries the bare name, so the version suffix is
 * split off before the two can be matched. Package names cannot contain a
 * dot, which makes the first dot the separator.
 *
 * The URL is reduced to its origin and path so credentials embedded in a
 * query string never reach the BOM.
 *
 * @param {string} line Trimmed list line
 * @param {Array<{name: string, url: string}>} pins Accumulator for pins
 */
function collectPinEntry(line, pins) {
  const strings = line.match(/"[^"]*"/gu) || [];
  if (strings.length < 2) {
    return;
  }
  const identifier = strings[0].slice(1, -1);
  const rawUrl = strings[1].slice(1, -1);
  pins.push({
    name: identifier.split(".")[0],
    url: sanitizedPinUrl(rawUrl),
  });
}

/**
 * Reduce a pin URL to a safe origin plus path.
 *
 * @param {string} rawUrl URL as written in the lock file
 * @returns {string} Sanitised URL, or the raw value when it is not a URL
 */
function sanitizedPinUrl(rawUrl) {
  const schemeSplit = rawUrl.split("://");
  if (schemeSplit.length < 2) {
    return rawUrl;
  }
  const scheme = schemeSplit[0];
  const rest = schemeSplit[1];
  const pathStart = rest.indexOf("/");
  const authority = pathStart === -1 ? rest : rest.slice(0, pathStart);
  const path = pathStart === -1 ? "" : rest.slice(pathStart).split(/[?#]/u)[0];
  // Userinfo is dropped by taking only the authority's host portion.
  const host = authority.split("@").pop();
  return `${scheme}://${host}${path}`;
}
