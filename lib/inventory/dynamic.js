import {
  closeSync,
  constants as fsConstants,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename } from "node:path";

import { checksumFile } from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { mapWithConcurrency } from "../core/parallel.js";
import { resolvePackageForFile } from "./osPackageResolver.js";
import { applyPurl, tryBuildPurl } from "./purl.js";
import {
  cryptoLibrariesByPath,
  normalizeTracedCryptoComponents,
  observedChainComponents,
} from "./tracedCrypto.js";
import { executeAndTrace, groupHttpEntriesToServices } from "./traceRunner.js";

/**
 * Converts a traced library path into a purl subpath. Windows paths
 * ("C:\Windows\System32\bcrypt.dll", "\\server\share\x.dll") use forward
 * slashes and drop the drive or UNC prefix, which a purl subpath cannot carry;
 * the full path stays in the cdx:dynamic:filePath property.
 *
 * @param {string} libPath - Absolute path of the loaded library
 * @returns {string|null} Subpath without leading separators, or null
 */
export function librarySubpath(libPath) {
  if (!libPath) {
    return null;
  }
  let subpath = libPath;
  const isDrivePath = /^[A-Za-z]:[\\/]/.test(subpath);
  if (isDrivePath || subpath.startsWith("\\\\")) {
    subpath = subpath.replaceAll("\\", "/");
    if (isDrivePath) {
      subpath = subpath.substring(3);
    }
  }
  return subpath.replace(/^\/+/, "") || null;
}

// The first bytes of the object files a loader maps: ELF, thin Mach-O in
// both byte orders and word sizes, universal Mach-O, and a Windows PE image.
const LIBRARY_MAGIC_NUMBERS = [
  [0x7f, 0x45, 0x4c, 0x46],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xca, 0xfe, 0xba, 0xbf],
  [0x4d, 0x5a],
];

/**
 * The largest library file that is hashed.
 *
 * @type {number}
 */
export const MAX_TRACED_LIBRARY_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The most bytes hashed for all the libraries of one trace together.
 *
 * @type {number}
 */
export const MAX_TRACED_LIBRARIES_TOTAL_BYTES = 16 * 1024 * 1024 * 1024;

function startsWithLibraryMagic(filePath) {
  const header = Buffer.alloc(4);
  let bytesRead = 0;
  // O_NONBLOCK keeps a FIFO put in place after the check from blocking.
  const fd = openSync(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0),
  );
  try {
    bytesRead = readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  return LIBRARY_MAGIC_NUMBERS.some(
    (magic) =>
      bytesRead >= magic.length &&
      magic.every((byte, index) => header[index] === byte),
  );
}

/**
 * Resolves a library path reported by the trace to the file that is hashed.
 *
 * The path named a file inside the sandbox when the library was loaded, but it
 * is opened again here, after the traced command has exited, with this
 * process's view of the file system and privileges. The command can forge
 * library entries or leave a link, a device or a FIFO at its library's path,
 * so only a regular file of bounded size that starts like a shared object is
 * accepted.
 *
 * @param {string} libPath Library path reported by the trace
 * @returns {{realPath: string, size: number}|undefined} The file to hash, or
 *   undefined
 */
function tracedLibraryFile(libPath) {
  try {
    const realPath = realpathSync(libPath);
    const stats = statSync(realPath);
    if (
      !stats.isFile() ||
      stats.size > MAX_TRACED_LIBRARY_BYTES ||
      !startsWithLibraryMagic(realPath)
    ) {
      return undefined;
    }
    return { realPath, size: stats.size };
  } catch {
    return undefined;
  }
}

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
 * The certificate chains servers presented in TLS ≤ 1.2 handshakes become the
 * shared certificate model, with `provides` edges from the TLS protocol
 * components.
 *
 * @param {string} commandStr - Shell command to execute and trace (e.g. "node --version")
 * @param {string} workingDir - Working directory for the traced process
 * @param {Object} [traceOptions] - Additional sandbox options forwarded to executeAndTrace
 * @returns {Promise<{components: Array<Object>, services: Array<Object>, dependencies: Array<Object>}>} Components, services and dependencies
 */
export async function buildDynamicComponents(
  commandStr,
  workingDir,
  traceOptions = {},
) {
  const result = await executeAndTrace(commandStr, workingDir, traceOptions);
  // A crypto library is a loaded library too, even when library tracing
  // missed it.
  const cryptoLibraries = cryptoLibrariesByPath(result.cryptoEntries);
  const libPaths = Array.from(
    new Set([...(result.libPaths || []), ...cryptoLibraries.keys()]),
  );
  const httpAccessEntries = result.httpAccessEntries || [];
  const egressEntries = result.egressEntries || [];
  const cryptoComponents = result.cryptoComponents || [];
  const components = [];

  let hashedBytes = 0;
  const libFiles = libPaths.map((libPath) => {
    const libFile = tracedLibraryFile(libPath);
    if (!libFile) {
      thoughtLog(`Not hashing traced library ${libPath}.`);
      return undefined;
    }
    if (hashedBytes + libFile.size > MAX_TRACED_LIBRARIES_TOTAL_BYTES) {
      thoughtLog(
        `Not hashing traced library ${libPath}: the trace's libraries exceed ${MAX_TRACED_LIBRARIES_TOTAL_BYTES} bytes.`,
      );
      return undefined;
    }
    hashedBytes += libFile.size;
    return libFile;
  });
  const libHashes = await mapWithConcurrency(libFiles, (libFile) =>
    libFile ? checksumFile("sha256", libFile.realPath).catch(() => null) : null,
  );

  for (let li = 0; li < libPaths.length; li++) {
    const libPath = libPaths[li];
    const fileHash = libHashes[li];
    if (!fileHash) {
      continue;
    }

    const pkgInfo = resolvePackageForFile(libPath);
    const cryptoLibrary = cryptoLibraries.get(libPath);
    // The subpath uses forward slashes, so this also names a Windows DLL
    // correctly when the BOM is built on another host.
    let name = basename(librarySubpath(libPath) || libPath);
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
        tryBuildPurl({
          type: pkgInfo.type,
          name: name,
          version: version || null,
          qualifiers: pkgInfo.arch ? { arch: pkgInfo.arch } : null,
        });
    } else {
      // A crypto library's version is its file version (Windows reports one
      // for each DLL it classifies).
      version = cryptoLibrary?.version || "";
      // Fall back to a generic purl carrying the file path as a subpath. It was
      // previously a `path` qualifier, which generic does not permit.
      purlStr = tryBuildPurl({
        type: "generic",
        name: name,
        version: version || null,
        subpath: librarySubpath(libPath),
      });
    }

    /** @type {Object} */
    const component = {
      name,
      type: "library",
      scope: "required",
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
    if (cryptoLibrary) {
      component.properties.push({
        name: "cdx:dynamic:cryptoLibrary",
        value: cryptoLibrary.name,
      });
    }
    // applyPurl sets a unique fallback bom-ref when no valid purl exists, so a
    // library that cannot be expressed as a purl still participates correctly in
    // the dependency graph.
    applyPurl(component, purlStr);

    components.push(component);
  }

  // Append cryptographic assets
  const normalizedCryptoComponents =
    normalizeTracedCryptoComponents(cryptoComponents);
  // The chains servers presented in TLS ≤ 1.2 handshakes become the shared
  // certificate model, linked from the TLS protocol components.
  const protocolRefs = new Set(
    normalizedCryptoComponents
      .filter((comp) => comp.cryptoProperties?.assetType === "protocol")
      .map((comp) => comp["bom-ref"]),
  );
  const observedModel = observedChainComponents(
    result.cryptoResult,
    protocolRefs,
  );
  // The traced CBOM names post-quantum algorithms after crypto-oid.json
  // (ml-dsa-44) while the certificate model follows PLAN section 2.5
  // (ML-DSA-44); one OID must still be one component, and the certificates
  // reference the model's name, so a traced duplicate yields to it.
  const observedAlgorithmOids = new Set(
    observedModel.components
      .filter((comp) => comp.cryptoProperties?.assetType === "algorithm")
      .map((comp) => comp.cryptoProperties.oid),
  );
  for (const comp of normalizedCryptoComponents) {
    if (
      comp.cryptoProperties?.assetType === "algorithm" &&
      observedAlgorithmOids.has(comp.cryptoProperties.oid)
    ) {
      continue;
    }
    components.push(comp);
  }
  for (const comp of observedModel.components) {
    components.push(comp);
  }
  const dependencies = observedModel.dependencies;

  // Build services from collected HTTP URLs
  const servicesMap = groupHttpEntriesToServices(httpAccessEntries);
  const services = Object.keys(servicesMap).map((serviceName) => {
    const entry = servicesMap[serviceName];
    return {
      name: serviceName,
      "bom-ref": `urn:service:dynamic:${serviceName}`,
      endpoints: Array.from(entry.endpoints).sort(),
      properties: entry.properties,
    };
  });

  // Egress seen by the safer-exec proxy: hostnames the command connected to
  // (allowed) or tried to reach (denied). This works on every platform,
  // including macOS where eBPF URL tracing is unavailable.
  const servicesByName = new Map(services.map((svc) => [svc.name, svc]));
  for (const egress of egressEntries) {
    const name = `dynamic-${egress.host}-${egress.port}`;
    const defaultPort = egress.protocol === "http" ? 80 : 443;
    const endpoint = `${egress.protocol}://${egress.host}${egress.port !== defaultPort ? `:${egress.port}` : ""}`;
    let svc = servicesByName.get(name);
    if (!svc) {
      svc = {
        name,
        "bom-ref": `urn:service:dynamic:${name}`,
        endpoints: [],
        properties: [],
      };
      servicesByName.set(name, svc);
      services.push(svc);
    }
    if (!svc.endpoints.some((e) => e.startsWith(endpoint))) {
      svc.endpoints.push(endpoint);
      svc.endpoints.sort();
    }
    if (
      !svc.properties.some(
        (p) =>
          p.name === "cdx:dynamic:egressDecision" &&
          p.value === egress.decision,
      )
    ) {
      svc.properties.push({
        name: "cdx:dynamic:egressDecision",
        value: egress.decision,
      });
    }
  }

  return {
    components,
    services,
    dependencies,
    dryRunSummary: result.dryRunSummary,
  };
}
