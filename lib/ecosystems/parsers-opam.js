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
 * @returns {{ pkgList: object[], pins: Array<{name: string, url: string|undefined}> }}
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
  // Keys of the name and version pairs already in `depends`.
  const seen = new Set();
  const pins = [];
  const lines = text.split("\n");
  let section;
  // Nesting of the current section's list; the bracket that brings it back to
  // zero closes the section.
  let depth = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    // A `field:` at the start of a line ends the previous list section. opam
    // allows white space between the field name and the colon.
    const field = line.match(/^([A-Za-z0-9_+-]+)\s*:/u);
    if (field) {
      const value = structureOf(line.slice(field[0].length));
      section = ["depends", "pin-depends"].includes(field[1])
        ? field[1]
        : undefined;
      depth = bracketDelta(value);
      // A value that is complete on the field's own line leaves nothing open.
      if (value && depth <= 0) {
        section = undefined;
      }
      continue;
    }
    if (!section) {
      continue;
    }
    if (section === "depends") {
      collectDependsEntry(line, depends, seen, opamLockedFile);
    } else if (section === "pin-depends") {
      collectPinEntry(line, pins);
    }
    // The section is over once its list is closed. Without this, whatever
    // follows the list (build commands, comments) would be read as entries
    // until the next line the field pattern recognises.
    const structure = structureOf(line);
    depth += bracketDelta(structure);
    if (structure && depth <= 0) {
      section = undefined;
    }
  }
  // A pin overrides where a package is fetched from; reflect that on the
  // resolved component so consumers can see the divergence from the registry.
  // A pin applies to the first record with its name.
  const firstByName = new Map();
  for (const dep of depends) {
    if (!firstByName.has(dep.name)) {
      firstByName.set(dep.name, dep);
    }
  }
  for (const pin of pins) {
    const target = firstByName.get(pin.name);
    if (target) {
      target.properties.push({ name: "cdx:opam:pinned", value: "true" });
      if (pin.url) {
        target.properties.push({
          name: "cdx:opam:pinSource",
          value: pin.url,
        });
      }
    }
  }
  return { pkgList: depends, pins };
}

/**
 * Reduce a line to its structural characters: string literals collapse to
 * `""` and comments are dropped, so brackets inside either are not counted.
 *
 * @param {string} line Line, or the part of it after a field's colon
 * @returns {string} Trimmed line without string contents and comments
 */
function structureOf(line) {
  // The `s` flag lets an unterminated string or comment run to the end of the
  // line across a stray carriage return, so no part of it is scanned twice.
  return line
    .replace(/"(?:[^"\\]|\\.)*"?|#.*|\(\*.*?(?:\*\)|$)/gsu, (token) =>
      token.startsWith('"') ? '""' : "",
    )
    .trim();
}

/**
 * Net change in list nesting across one line.
 *
 * @param {string} structure Line as returned by `structureOf`
 * @returns {number} Opening brackets minus closing brackets
 */
function bracketDelta(structure) {
  return (
    (structure.match(/\[/gu) || []).length -
    (structure.match(/\]/gu) || []).length
  );
}

// Package names are alphanumerics, `-`, `_` and `+`.
const OPAM_PACKAGE_NAME = /^[A-Za-z0-9_+-]+$/u;

/**
 * Turn one `depends` list line into a pinned package record.
 *
 * Entries look like `"dune" {= "3.16.0"}` or `"ocaml" {= "5.1.1" & build}`.
 * Only equality pins carry a version; constraint-only entries are recorded
 * without one so the package is still inventoried.
 *
 * @param {string} line Trimmed list line
 * @param {object[]} depends Accumulator for package records
 * @param {Set<string>} seen Keys of the name and version pairs already in
 *   `depends`
 * @param {string} srcFile Source path for provenance
 */
function collectDependsEntry(line, depends, seen, srcFile) {
  const nameMatch = line.match(/^"([^"]+)"/u);
  if (!nameMatch) {
    return;
  }
  const name = nameMatch[1];
  // Anything else is not a package, and must not be turned into a purl.
  if (!OPAM_PACKAGE_NAME.test(name)) {
    return;
  }
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
  // A separator could also occur in the name or the version, so the key is
  // the JSON form of the pair.
  const key = JSON.stringify([name, version]);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
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
 * @param {Array<{name: string, url: string|undefined}>} pins Accumulator for pins
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
 * Reduce a pin address to a safe origin plus path.
 *
 * opam takes a URL (`git+https://host/path#rev`), an ssh address without a
 * scheme (`user@host:path`) and a plain path. All three are read the same
 * way: the userinfo in front of the host is dropped, and so are the query
 * string and the fragment.
 *
 * @param {string} rawUrl Address as written in the lock file
 * @returns {string|undefined} Sanitised address, or undefined when an `@`
 *   is left that cannot be told apart from userinfo
 */
function sanitizedPinUrl(rawUrl) {
  const scheme = /^[^:/@?#]*:\/\//u.exec(rawUrl)?.[0] ?? "";
  const rest = rawUrl.slice(scheme.length);
  const authorityEnd = rest.search(/[/?#]/u);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const tail = authorityEnd === -1 ? "" : rest.slice(authorityEnd);
  // An `@` past the authority is part of the path, or of a password that
  // holds a `/`, `?` or `#`. Nothing here can tell which, so no source is
  // reported for such an address.
  if (tail.includes("@")) {
    return undefined;
  }
  // Userinfo is dropped by taking only the authority's host portion.
  const host = authority.split("@").pop();
  const path = tail.split(/[?#]/u)[0];
  return `${scheme}${host}${path}`;
}
