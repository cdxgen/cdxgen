import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { safeExistsSync, safeReadFileSync } from "../core/fs.js";

// Build systems can embed a CycloneDX document inside the artifact they
// produce. Quarkus stores the dependency SBOM of `quarkus.cyclonedx.embedded
// .enabled` builds under META-INF/sbom/ in the application jar (the resource
// name defaults to dependency.cdx.json and is configurable), and the GraalVM
// native image variant is read by blint from the sbom symbol instead. The
// embedded document describes the artifact's own dependencies, so a jar scan
// that finds one has a manifest-grade component list to merge.

/** The directory inside a jar where embedded SBOMs live. */
const EMBEDDED_SBOM_DIR = join("META-INF", "sbom");

/** An embedded SBOM larger than this is not read. Real dependency SBOMs are a
 * few hundred kilobytes; anything past this is not one. */
const MAX_EMBEDDED_SBOM_BYTES = 32 * 1024 * 1024;

/**
 * List the CycloneDX JSON documents a jar carries under META-INF/sbom.
 *
 * @param {string} extractedDir Directory the jar was extracted into
 * @returns {string[]} Absolute paths of the embedded SBOM candidates
 */
export function findEmbeddedSbomFiles(extractedDir) {
  const sbomDir = join(extractedDir, EMBEDDED_SBOM_DIR);
  if (!safeExistsSync(sbomDir)) {
    return [];
  }
  try {
    if (!statSync(sbomDir).isDirectory()) {
      return [];
    }
    return readdirSync(sbomDir)
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .map((name) => join(sbomDir, name));
  } catch {
    return [];
  }
}

/**
 * Read and validate an embedded CycloneDX JSON document.
 *
 * The document must be a JSON object whose bomFormat is CycloneDX. It is read
 * only up to {@link MAX_EMBEDDED_SBOM_BYTES}, and its metadata is never
 * returned: the scan's own metadata describes the scan, and an embedded
 * document has no business replacing it.
 *
 * @param {string} sbomFile Path of the extracted SBOM resource
 * @returns {Object|null} `{ components, dependencies }`, or null when the file
 *   is not a readable CycloneDX document
 */
export function readEmbeddedSbomFile(sbomFile) {
  try {
    const stats = statSync(sbomFile);
    if (!stats.isFile() || stats.size > MAX_EMBEDDED_SBOM_BYTES) {
      return null;
    }
    const parsed = JSON.parse(safeReadFileSync(sbomFile, "utf-8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.bomFormat !== "CycloneDX"
    ) {
      return null;
    }
    return {
      components: Array.isArray(parsed.components) ? parsed.components : [],
      dependencies: Array.isArray(parsed.dependencies)
        ? parsed.dependencies
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Record on each component where it came from, following the `internal:SrcFile`
 * convention every other component read from another BOM or artifact uses, with
 * the evidence method naming the SBOM resource inside the jar.
 *
 * @param {Object[]} components Components taken from the embedded document
 * @param {string} jarFile Path of the jar the SBOM was embedded in
 * @param {string} sbomFile Path of the extracted SBOM resource
 * @param {string} jarBasename Basename of the jar, for readable evidence values
 * @returns {Object[]} The same components with provenance attached
 */
export function decorateEmbeddedSbomComponents(
  components,
  jarFile,
  sbomFile,
  jarBasename,
) {
  for (const component of components) {
    if (!component || typeof component !== "object") {
      continue;
    }
    if (!component.evidence?.identity) {
      component.evidence = {
        ...(component.evidence || {}),
        identity: {
          field: "purl",
          confidence: 0.8,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.8,
              value: `${jarBasename}!${EMBEDDED_SBOM_DIR}/${basename(sbomFile)}`,
            },
          ],
        },
      };
    }
    if (!Array.isArray(component.properties)) {
      component.properties = [];
    }
    component.properties.push({
      name: "internal:SrcFile",
      value: jarFile,
    });
  }
  return components;
}
