import { basename } from "node:path";

import { PackageURL } from "packageurl-js";

import { resolvePackageForFile } from "./osPackageResolver.js";
import { executeAndTrace, groupHttpEntriesToServices } from "./traceRunner.js";
import { checksumFile } from "./utils.js";

/**
 * Builds a flat list of CycloneDX component objects and services by executing
 * the given command and inspecting which shared libraries it loads at runtime
 * and which HTTP URLs it accesses.
 *
 * Each component receives:
 *  - type: "library"
 *  - scope: "required"  (loaded at runtime — definitely required)
 *  - hashes: SHA-256 of the on-disk file
 *  - evidence.identity[].methods[].technique: "instrumentation"
 *  - confidence: 0.8 when the OS package manager reports a version, 0.5 otherwise
 *
 * Services are detected from HTTP request URLs collected during tracing and
 * follow the CycloneDX service schema with endpoints.
 *
 * @param {string} commandStr - Shell command to execute and trace (e.g. "node --version")
 * @param {string} workingDir - Working directory for the traced process
 * @param {Object} [traceOptions] - Additional sandbox options forwarded to executeAndTrace
 * @returns {Promise<{components: Array<Object>, services: Array<Object>}>} Components and services
 */
export async function buildDynamicComponents(
  commandStr,
  workingDir,
  traceOptions = {},
) {
  const result = await executeAndTrace(commandStr, workingDir, traceOptions);
  const libPaths = result.libPaths || [];
  const httpAccessEntries = result.httpAccessEntries || [];
  const cryptoComponents = result.cryptoComponents || [];
  const components = [];

  for (const libPath of libPaths) {
    let fileHash;
    try {
      fileHash = await checksumFile("sha256", libPath);
    } catch (_err) {
      // Cannot hash the file — skip it
      continue;
    }

    const pkgInfo = resolvePackageForFile(libPath);
    let name = basename(libPath);
    let version = "";
    let purlStr = "";
    let confidence = 0.5;

    if (pkgInfo) {
      name = pkgInfo.name;
      version = pkgInfo.version || "";
      confidence = version ? 0.8 : 0.5;

      // pkgInfo.purl is already computed by resolvePackageForFile using the
      // correct distro-aware namespace derived from /etc/os-release.
      purlStr =
        pkgInfo.purl ||
        new PackageURL(
          pkgInfo.type,
          "",
          name,
          version || undefined,
          pkgInfo.arch ? { arch: pkgInfo.arch } : undefined,
          undefined,
        ).toString();
    } else {
      // Fall back to a generic purl carrying the raw file path
      purlStr = new PackageURL(
        "generic",
        undefined,
        name,
        undefined,
        { path: libPath },
        undefined,
      ).toString();
    }

    /** @type {Object} */
    const component = {
      name,
      type: "library",
      scope: "required",
      purl: purlStr,
      "bom-ref": purlStr,
      hashes: [
        {
          alg: "SHA-256",
          content: fileHash,
        },
      ],
      properties: [
        {
          name: "cdx:dynamic:filePath",
          value: libPath,
        },
      ],
      evidence: {
        identity: [
          {
            field: "purl",
            confidence,
            methods: [
              {
                technique: "instrumentation",
                confidence,
                value: purlStr,
              },
            ],
          },
        ],
      },
    };

    if (version) {
      component.version = version;
    }

    components.push(component);
  }

  // Append cryptographic assets
  for (const comp of cryptoComponents) {
    components.push(comp);
  }

  // Build services from collected HTTP URLs
  const servicesMap = groupHttpEntriesToServices(httpAccessEntries);
  const services = Object.keys(servicesMap).map((serviceName) => {
    const entry = servicesMap[serviceName];
    return {
      name: serviceName,
      bomRef: `urn:service:dynamic:${serviceName}`,
      endpoints: Array.from(entry.endpoints).sort(),
      properties: entry.properties,
    };
  });

  return { components, services };
}
