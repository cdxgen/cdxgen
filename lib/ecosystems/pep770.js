// PEP 770 — "Improving measurability of Python packages with Software Bill of
// Materials" (Seth Larson; Final, 11-Apr-2025). The canonical, up-to-date spec
// is the PyPA `.dist-info/sboms/` directory specification:
// https://packaging.python.org/en/latest/specifications/binary-distribution-format/#the-dist-info-sboms-directory
//
// Key points the PEP is explicit about, and which this implementation follows:
//   - SBOMs live in a *directory*: `<dist>.dist-info/sboms/`. There is no fixed
//     filename and NO metadata field — the PEP explicitly rejected an
//     `Sbom-File` metadata field; presence in the directory is the sole signal.
//   - Zero-or-more opaque documents; both CycloneDX and SPDX are permitted.
//   - Applies to wheels and installed distributions (installers MUST copy
//     `sboms/` from the wheel).
//   - The embedded data is untrusted third-party input: bound its size, do not
//     follow references out of it, validate before merging, and skip an invalid
//     one with a warning rather than failing the run. `parseSbomDocument` owns
//     that handling, shared with the TEA client.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { safeExistsSync } from "../core/fs.js";
import { createCitation } from "../inventory/citations.js";
import { readZipEntriesMatching } from "../inventory/deps.js";
import { pypiBomRef } from "../inventory/purl.js";
import {
  MAX_SBOM_DOCUMENT_BYTES,
  parseSbomDocument,
  tagSbomComponents,
} from "../inventory/sbomDocument.js";

const SBOMS_DIR_SEGMENT = ".dist-info/sboms/";
const METADATA_SEGMENT = ".dist-info/METADATA";

/**
 * The `<name>-<version>` stem of the `.dist-info` directory a path belongs to.
 * It labels the provenance of the components; the authoritative name and
 * version for the purl come from the METADATA headers, not from this stem.
 *
 * @param {string} dirOrFile Any path inside or naming a `.dist-info` directory
 * @returns {string|undefined} The stem, or undefined when there is none
 */
function distInfoStem(dirOrFile) {
  // The segment is anchored at a path separator so that it is tried once from
  // its first character. An unanchored `[^/\\]+` is retried from every
  // character of a segment, which is quadratic in the length of a zip member
  // name.
  const match = /(?:^|[/\\])([^/\\]+)\.dist-info/.exec(String(dirOrFile));
  return match ? match[1] : undefined;
}

/**
 * Extract the canonical `Name` and `Version` headers from a distribution
 * METADATA file (RFC 822-style headers, as defined by the PyPA metadata
 * specification). This is the name cdxgen uses when it builds the distribution
 * component's purl, so it is the right basis for rebasing an embedded graph.
 *
 * @param {string} text Raw METADATA content
 * @returns {{name: string, version: string}|null} Headers, or null when missing
 */
function distNameVersionFromMetadata(text) {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  let name;
  let version;
  for (const line of lines) {
    if (line.trim() === "") {
      break;
    }
    const firstColon = line.indexOf(":");
    if (firstColon === -1) {
      continue;
    }
    const key = line.substring(0, firstColon).trim().toLowerCase();
    const value = line.substring(firstColon + 1).trim();
    if (key === "name" && name === undefined) {
      name = value;
    } else if (key === "version" && version === undefined) {
      version = value;
    }
    if (name !== undefined && version !== undefined) {
      break;
    }
  }
  if (!name) {
    return null;
  }
  return { name, version };
}

/**
 * Rewrite the root reference of an embedded dependency graph so the bundled
 * components become dependencies *of* the distribution component cdxgen already
 * emits, rather than top-level siblings. The embedded SBOM's own root ref is
 * normalised to the `pkg:pypi/<name>@<version>` ref cdxgen assigns.
 *
 * @param {Object[]} dependencies Dependency entries from the embedded document
 * @param {string} distributionRef bom-ref of the distribution component
 * @param {string} [embeddedRootRef] bom-ref the embedded document uses for itself
 * @returns {Object[]} Rebased dependency entries
 */
function rebaseDependencies(dependencies, distributionRef, embeddedRootRef) {
  if (!distributionRef || !Array.isArray(dependencies)) {
    return dependencies;
  }
  const rebased = [];
  for (const dep of dependencies) {
    if (!dep || typeof dep !== "object") {
      continue;
    }
    const ref =
      embeddedRootRef && dep.ref === embeddedRootRef
        ? distributionRef
        : dep.ref;
    rebased.push({ ...dep, ref });
  }
  return rebased;
}

/**
 * Parse one embedded document and tag its components with the distribution
 * that carried them.
 *
 * @param {string} text Raw document text
 * @param {string} source Provenance label (path or zip entry name)
 * @param {string} distribution `<name>-<version>` stem of the carrying distribution
 * @returns {Object|null} Parsed and tagged document, or null when unusable
 */
function parseEmbeddedSbom(text, source, distribution) {
  const parsed = parseSbomDocument(text, { source });
  if (!parsed) {
    return null;
  }
  tagSbomComponents(parsed.components, [
    { name: "cdx:embeddedSbom:source", value: distribution },
    { name: "cdx:embeddedSbom:format", value: parsed.format },
  ]);
  return parsed;
}

/**
 * Build a citation attributing the embedded components to the distribution that
 * supplied them. Attribution requires the distribution's real bom-ref: with no
 * ref there is no object in the BOM to point at, and inventing one would make
 * the citation dangle, so the citation is dropped instead.
 *
 * @param {string} distribution `<name>-<version>` stem used to tag the components
 * @param {string} source Path or zip entry the document came from
 * @param {string} [distributionRef] bom-ref of the distribution component
 * @returns {Object|null} A citation, or null when the distribution has no ref
 */
function buildEmbeddedCitation(distribution, source, distributionRef) {
  if (!distributionRef) {
    return null;
  }
  // The document travels beyond the machine that built it, so the note names
  // the location within the distribution, never the absolute build path.
  // Anchored at a separator for the same reason as `distInfoStem()`.
  const location = String(source).replace(
    /^.*?(?:^|[/\\])([^/\\]+\.dist-info[/\\])/,
    "$1",
  );
  return createCitation({
    expressions: [
      `$.components[?(@.properties[?(@.name == 'cdx:embeddedSbom:source' && @.value == '${distribution}')])]`,
    ],
    attributedTo: distributionRef,
    note: `Components declared by ${distribution} in its PEP 770 .dist-info/sboms/ directory (${location}).`,
  });
}

/**
 * List the readable documents in an installed distribution's `sboms/`
 * directory, skipping dot files and anything already over the size bound.
 *
 * @param {string} sbomsDir Absolute path of the `sboms/` directory
 * @returns {string[]} Absolute paths of candidate documents
 */
function embeddedSbomFiles(sbomsDir) {
  let entries;
  try {
    entries = readdirSync(sbomsDir);
  } catch (_err) {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }
    const path = join(sbomsDir, entry);
    try {
      const stats = statSync(path);
      if (!stats.isFile()) {
        continue;
      }
      // Checked before the read so an oversized document is never loaded.
      if (stats.size > MAX_SBOM_DOCUMENT_BYTES) {
        console.warn(
          `cdxgen: skipping embedded SBOM at ${path} (exceeds ${MAX_SBOM_DOCUMENT_BYTES} bytes).`,
        );
        continue;
      }
    } catch (_err) {
      continue;
    }
    files.push(path);
  }
  return files;
}

/**
 * Discover and parse embedded SBOMs from installed distribution metadata
 * directories and wheel files, per PEP 770. Returns merged components,
 * dependencies, and citations ready for post-processing.
 *
 * Embedded components are returned as dependencies *of* the distribution that
 * supplied them, never as orphan top-level siblings. An embedded SBOM is
 * stronger than cdxgen's inference; the upstream component wins on conflict,
 * which the merge (trimComponents) records by unioning rather than discarding.
 *
 * @param {Object} input Discovery inputs
 * @param {string[]} [input.metadataFiles] Installed `*.dist-info/METADATA` paths
 * @param {string[]} [input.whlFiles] Wheel file paths
 * @returns {Promise<{components: Object[], dependencies: Object[], citations: Object[]}>}
 */
export async function collectEmbeddedSboms({
  metadataFiles = [],
  whlFiles = [],
} = {}) {
  const components = [];
  const dependencies = [];
  const citations = [];

  const collect = (parsed, distribution, source, distributionRef) => {
    components.push(...parsed.components);
    dependencies.push(
      ...rebaseDependencies(
        parsed.dependencies,
        distributionRef,
        parsed.rootRef,
      ),
    );
    const citation = buildEmbeddedCitation(
      distribution,
      source,
      distributionRef,
    );
    if (citation) {
      citations.push(citation);
    }
  };

  // Installed distributions: `<dist>.dist-info/sboms/*` lives on disk next to
  // the METADATA file that cdxgen already locates.
  for (const metadataFile of metadataFiles || []) {
    const distribution = distInfoStem(metadataFile);
    if (!distribution) {
      continue;
    }
    const sbomsDir = join(metadataFile, "..", "sboms");
    if (!safeExistsSync(sbomsDir)) {
      continue;
    }
    const sbomFiles = embeddedSbomFiles(sbomsDir);
    if (!sbomFiles.length) {
      continue;
    }
    // The METADATA sibling carries the canonical name cdxgen uses for the
    // distribution component's bom-ref; the embedded graph is rebased onto it
    // so bundled components become dependencies *of* the distribution.
    let distributionRef;
    try {
      const headers = distNameVersionFromMetadata(
        readFileSync(metadataFile, "utf-8"),
      );
      distributionRef = headers
        ? pypiBomRef(headers.name, headers.version)
        : undefined;
    } catch (_err) {
      distributionRef = undefined;
    }
    for (const sbomFile of sbomFiles) {
      let text;
      try {
        text = readFileSync(sbomFile, "utf-8");
      } catch (_err) {
        continue;
      }
      const parsed = parseEmbeddedSbom(text, sbomFile, distribution);
      if (parsed) {
        collect(parsed, distribution, sbomFile, distributionRef);
      }
    }
  }

  // Wheels: enumerate `<dist>.dist-info/sboms/` entries inside the archive.
  for (const whlFile of whlFiles || []) {
    const metadataEntries = await readZipEntriesMatching(
      whlFile,
      METADATA_SEGMENT,
    );
    const distributionRefByStem = new Map();
    for (const entry of metadataEntries) {
      const stem = distInfoStem(entry.name);
      const headers = distNameVersionFromMetadata(entry.data);
      if (stem && headers) {
        distributionRefByStem.set(
          stem,
          pypiBomRef(headers.name, headers.version),
        );
      }
    }
    const entries = await readZipEntriesMatching(whlFile, SBOMS_DIR_SEGMENT);
    for (const entry of entries) {
      const stem = distInfoStem(entry.name);
      const distribution = stem || distInfoStem(whlFile);
      const parsed = parseEmbeddedSbom(entry.data, entry.name, distribution);
      if (parsed) {
        collect(
          parsed,
          distribution,
          entry.name,
          stem ? distributionRefByStem.get(stem) : undefined,
        );
      }
    }
  }

  return { components, dependencies, citations };
}

/**
 * Test-only export exposing internal helpers and constants for unit testing.
 *
 * Underscore-prefixed to signal that it is not part of the public API.
 *
 * @type {{ MAX_EMBEDDED_SBOM_BYTES: number, buildEmbeddedCitation: Function, distInfoStem: Function, parseEmbeddedSbom: Function, rebaseDependencies: Function, pypiBomRef: Function, distNameVersionFromMetadata: Function }}
 */
export const _internals = {
  MAX_EMBEDDED_SBOM_BYTES: MAX_SBOM_DOCUMENT_BYTES,
  buildEmbeddedCitation,
  distInfoStem,
  parseEmbeddedSbom,
  rebaseDependencies,
  pypiBomRef,
  distNameVersionFromMetadata,
};
