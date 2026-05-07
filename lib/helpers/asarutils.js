import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import process from "node:process";

import { PackageURL } from "packageurl-js";
import { xml2js } from "xml-js";

import {
  analyzeJsCapabilitiesSource,
  analyzeSuspiciousJsSource,
} from "./analyzer.js";
import { thoughtLog } from "./logger.js";
import { sanitizeBomPropertyValue } from "./propertySanitizer.js";
import {
  DEBUG_MODE,
  getTmpDir,
  isDryRun,
  recordActivity,
  safeCopyFileSync,
  safeExistsSync,
  safeExtractArchive,
  safeMkdirSync,
  safeMkdtempSync,
  safeRmSync,
  safeWriteSync,
} from "./utils.js";

const ASAR_JS_ANALYSIS_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const ASAR_LOCKFILE_NAMES = new Set([
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const ASAR_LIFECYCLE_SCRIPT_NAMES = new Set([
  "install",
  "postinstall",
  "preinstall",
  "prepare",
  "prepublish",
]);
const PICKLE_UINT32_SIZE = 4;
const PICKLE_SIZE_PICKLE_BYTES = 8;
const MAX_ASAR_HEADER_BYTES = 64 * 1024 * 1024;
const MAX_ASAR_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ASAR_OFFSET = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_ASAR_HEADER_DEPTH = 256;
const MAX_ELECTRON_APP_BUNDLE_SEARCH_DEPTH = 20;

function addSanitizedProperty(properties, name, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  const sanitizedValue = sanitizeBomPropertyValue(name, value);
  if (
    sanitizedValue === undefined ||
    sanitizedValue === null ||
    sanitizedValue === ""
  ) {
    return;
  }
  properties.push({
    name,
    value: String(sanitizedValue),
  });
}

function toArchiveOccurrence(archivePath, entryPath) {
  return `${archivePath}#/${entryPath.replaceAll("\\", "/")}`;
}

function normalizeArchiveRelativePath(entryPath) {
  return String(entryPath || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
}

function isPathWithin(baseDir, candidatePath) {
  const relativePath = relative(resolve(baseDir), resolve(candidatePath))
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.split("/").includes(".."))
  );
}

function parseScopedPackageName(packageName) {
  if (!packageName || typeof packageName !== "string") {
    return { group: "", name: "" };
  }
  if (packageName.startsWith("@")) {
    const [group, ...nameParts] = packageName.slice(1).split("/");
    return {
      group,
      name: nameParts.join("/"),
    };
  }
  return { group: "", name: packageName };
}

function createAsarPackagePurl(packageName, version) {
  const parsedName = parseScopedPackageName(packageName);
  if (!parsedName.name) {
    return undefined;
  }
  return new PackageURL(
    "npm",
    parsedName.group || null,
    parsedName.name,
    version || null,
    null,
    null,
  ).toString();
}

function createGenericArchivePurl(archivePath, version) {
  return new PackageURL(
    "generic",
    null,
    basename(archivePath, ".asar"),
    version || null,
    { type: "asar" },
    null,
  ).toString();
}

function parseAsarJson(headerString) {
  return JSON.parse(headerString, (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const nullPrototypeObject = Object.create(null);
    for (const [entryKey, entryValue] of Object.entries(value)) {
      nullPrototypeObject[entryKey] = entryValue;
    }
    return nullPrototypeObject;
  });
}

function validateHeaderEntry(entry, entryPath, depth = 0) {
  if (depth > MAX_ASAR_HEADER_DEPTH) {
    throw new Error(
      `ASAR header nesting exceeds ${MAX_ASAR_HEADER_DEPTH} levels at ${entryPath || "/"}`,
    );
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Invalid ASAR entry at ${entryPath}`);
  }
  const hasFiles = Object.hasOwn(entry, "files");
  const hasLink = Object.hasOwn(entry, "link");
  const hasOffset = Object.hasOwn(entry, "offset");
  const hasSize = Object.hasOwn(entry, "size");
  if (hasLink) {
    if (
      typeof entry.link !== "string" ||
      !entry.link ||
      hasFiles ||
      entry.unpacked === true ||
      hasOffset ||
      hasSize
    ) {
      throw new Error(`Invalid ASAR symlink entry at ${entryPath}`);
    }
    return;
  }
  if (hasFiles) {
    if (
      !entry.files ||
      typeof entry.files !== "object" ||
      Array.isArray(entry.files) ||
      entry.unpacked === true ||
      hasOffset ||
      hasSize
    ) {
      throw new Error(`Invalid ASAR directory entry at ${entryPath}`);
    }
    for (const [name, child] of Object.entries(entry.files)) {
      if (
        !name ||
        name === "." ||
        name === ".." ||
        name === "__proto__" ||
        name === "constructor" ||
        name === "prototype" ||
        name.includes("/") ||
        name.includes("\\")
      ) {
        throw new Error(`Invalid ASAR child name "${name}" at ${entryPath}`);
      }
      validateHeaderEntry(child, `${entryPath}/${name}`, depth + 1);
    }
    return;
  }
  if (entry.unpacked === true) {
    if (
      hasOffset ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > MAX_ASAR_ENTRY_BYTES
    ) {
      throw new Error(`Invalid ASAR unpacked file entry at ${entryPath}`);
    }
    return;
  }
  if (
    typeof entry.offset !== "string" ||
    !/^\d+$/.test(entry.offset) ||
    typeof entry.size !== "number" ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    entry.size > MAX_ASAR_ENTRY_BYTES
  ) {
    throw new Error(`Invalid ASAR file entry at ${entryPath}`);
  }
}

function parseAsarHeaderString(headerBuffer) {
  if (headerBuffer.length < PICKLE_UINT32_SIZE * 2) {
    throw new Error("ASAR header pickle is too small.");
  }
  const payloadSize = headerBuffer.readUInt32LE(0);
  if (payloadSize > headerBuffer.length - PICKLE_UINT32_SIZE) {
    throw new Error("ASAR header payload exceeds archive header size.");
  }
  const stringLength = headerBuffer.readInt32LE(PICKLE_UINT32_SIZE);
  if (stringLength < 0 || stringLength > payloadSize - PICKLE_UINT32_SIZE) {
    throw new Error("ASAR header string length is invalid.");
  }
  return headerBuffer.toString(
    "utf8",
    PICKLE_UINT32_SIZE * 2,
    PICKLE_UINT32_SIZE * 2 + stringLength,
  );
}

export function readAsarArchiveHeaderSync(archivePath) {
  const fd = openSync(archivePath, "r");
  try {
    const sizeBuffer = Buffer.alloc(PICKLE_SIZE_PICKLE_BYTES);
    const sizeRead = readSync(fd, sizeBuffer, 0, PICKLE_SIZE_PICKLE_BYTES, 0);
    if (sizeRead !== PICKLE_SIZE_PICKLE_BYTES) {
      throw new Error(
        `Unable to read ASAR header size from ${archivePath}: expected ${PICKLE_SIZE_PICKLE_BYTES} bytes, got ${sizeRead}`,
      );
    }
    const headerPickleSize = sizeBuffer.readUInt32LE(PICKLE_UINT32_SIZE);
    if (
      headerPickleSize < PICKLE_UINT32_SIZE * 2 ||
      headerPickleSize > MAX_ASAR_HEADER_BYTES
    ) {
      throw new Error(
        `Unsupported ASAR header size ${headerPickleSize} for ${archivePath}`,
      );
    }
    const headerBuffer = Buffer.alloc(headerPickleSize);
    const headerRead = readSync(
      fd,
      headerBuffer,
      0,
      headerPickleSize,
      PICKLE_SIZE_PICKLE_BYTES,
    );
    if (headerRead !== headerPickleSize) {
      throw new Error(
        `Unable to read ASAR header from ${archivePath}: expected ${headerPickleSize} bytes, got ${headerRead}`,
      );
    }
    const headerString = parseAsarHeaderString(headerBuffer);
    const header = parseAsarJson(headerString);
    if (!header?.files || typeof header.files !== "object") {
      throw new Error(`Invalid ASAR header root for ${archivePath}`);
    }
    validateHeaderEntry(header, "", 0);
    return {
      archiveDataOffset: BigInt(PICKLE_SIZE_PICKLE_BYTES + headerPickleSize),
      header,
      headerSize: headerPickleSize,
      headerString,
    };
  } finally {
    closeSync(fd);
  }
}

export function listAsarEntries(archivePath) {
  const parsedHeader = readAsarArchiveHeaderSync(archivePath);
  const entries = [];
  const visitEntries = (filesNode, currentPath = "") => {
    for (const [name, child] of Object.entries(filesNode || {})) {
      const childPath = currentPath ? `${currentPath}/${name}` : name;
      if (child?.files) {
        entries.push({
          path: childPath,
          type: "directory",
          unpacked: child.unpacked === true,
        });
        visitEntries(child.files, childPath);
        continue;
      }
      if (child?.link) {
        entries.push({
          link: child.link,
          path: childPath,
          type: "link",
          unpacked: child.unpacked === true,
        });
        continue;
      }
      entries.push({
        executable: child?.executable === true,
        integrity: child?.integrity,
        offset: child?.offset,
        path: childPath,
        size: Number(child?.size || 0),
        type: "file",
        unpacked: child?.unpacked === true,
      });
    }
  };
  visitEntries(parsedHeader.header.files);
  return {
    ...parsedHeader,
    entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function resolveUnpackedEntryPath(archivePath, entryPath) {
  const unpackedBaseDir = `${archivePath}.unpacked`;
  const normalizedEntryPath = normalizeArchiveRelativePath(entryPath);
  const resolvedEntryPath = resolve(
    unpackedBaseDir,
    ...normalizedEntryPath.split("/"),
  );
  if (!isPathWithin(unpackedBaseDir, resolvedEntryPath)) {
    throw new Error(
      `Unpacked ASAR entry path escapes archive root: ${normalizedEntryPath}`,
    );
  }
  return resolvedEntryPath;
}

function resolveArchiveLinkPath(entryPath, linkTarget) {
  if (!linkTarget || typeof linkTarget !== "string") {
    throw new Error(`Invalid ASAR symlink target for ${entryPath}`);
  }
  const normalizedEntryPath = normalizeArchiveRelativePath(entryPath);
  const archiveRoot = "/__asar_root__";
  const resolvedLinkPath = resolve(
    archiveRoot,
    dirname(normalizedEntryPath),
    linkTarget,
  );
  if (!isPathWithin(archiveRoot, resolvedLinkPath)) {
    throw new Error(
      `ASAR symlink ${entryPath} target escapes archive root: ${linkTarget}`,
    );
  }
  const archiveRelativeLinkPath = normalizeArchiveRelativePath(
    relative(archiveRoot, resolvedLinkPath),
  );
  if (!archiveRelativeLinkPath || archiveRelativeLinkPath.startsWith("..")) {
    throw new Error(
      `ASAR symlink ${entryPath} target escapes archive root: ${linkTarget}`,
    );
  }
  return archiveRelativeLinkPath;
}

function validateArchiveSymlinkEntries(entries) {
  const symlinkTargets = new Map();
  for (const entry of entries) {
    if (entry.type !== "link") {
      continue;
    }
    symlinkTargets.set(
      normalizeArchiveRelativePath(entry.path),
      resolveArchiveLinkPath(entry.path, entry.link),
    );
  }
  const visitedPaths = new Set();
  const visitingPaths = new Set();
  const detectCycle = (entryPath) => {
    if (visitedPaths.has(entryPath)) {
      return;
    }
    if (visitingPaths.has(entryPath)) {
      throw new Error(`Circular ASAR symlink chain detected at ${entryPath}`);
    }
    const linkTarget = symlinkTargets.get(entryPath);
    if (!linkTarget) {
      return;
    }
    visitingPaths.add(entryPath);
    detectCycle(linkTarget);
    visitingPaths.delete(entryPath);
    visitedPaths.add(entryPath);
  };
  for (const entryPath of symlinkTargets.keys()) {
    detectCycle(entryPath);
  }
  return symlinkTargets;
}

function readPackedEntryBuffer(archivePath, archiveDataOffset, entry, fd) {
  const archiveFd = fd ?? openSync(archivePath, "r");
  try {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(
        `Invalid packed ASAR entry size ${entry.size} for ${entry.path}`,
      );
    }
    if (entry.size > MAX_ASAR_ENTRY_BYTES) {
      throw new Error(
        `ASAR entry ${entry.path} exceeds the maximum supported size of ${MAX_ASAR_ENTRY_BYTES} bytes`,
      );
    }
    const absoluteOffset =
      archiveDataOffset + BigInt(String(entry.offset || "0"));
    if (absoluteOffset > MAX_ASAR_OFFSET) {
      throw new Error(
        `ASAR entry ${entry.path} offset exceeds the safe read limit`,
      );
    }
    const buffer = Buffer.alloc(entry.size);
    const bytesRead = readSync(
      archiveFd,
      buffer,
      0,
      entry.size,
      Number(absoluteOffset),
    );
    if (bytesRead !== entry.size) {
      throw new Error(
        `Unable to read complete ASAR entry ${entry.path} from ${archivePath}: expected ${entry.size} bytes, got ${bytesRead}`,
      );
    }
    return buffer;
  } finally {
    if (fd === undefined) {
      closeSync(archiveFd);
    }
  }
}

function readAsarEntryBufferSync(archivePath, archiveDataOffset, entry, fd) {
  if (entry.unpacked) {
    return readFileSync(resolveUnpackedEntryPath(archivePath, entry.path));
  }
  return readPackedEntryBuffer(archivePath, archiveDataOffset, entry, fd);
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function readXmlText(node) {
  return (node?.elements || [])
    .filter((child) => ["text", "cdata"].includes(child?.type))
    .map((child) => child.text || child.cdata || "")
    .join("");
}

function parsePlistElement(node) {
  if (!node || node.type !== "element") {
    return undefined;
  }
  switch (node.name) {
    case "array":
      return (node.elements || [])
        .filter((child) => child?.type === "element")
        .map((child) => parsePlistElement(child));
    case "data":
    case "date":
    case "string":
      return readXmlText(node);
    case "dict": {
      const plistObject = Object.create(null);
      const childElements = (node.elements || []).filter(
        (child) => child?.type === "element",
      );
      for (let index = 0; index < childElements.length - 1; index += 2) {
        const keyElement = childElements[index];
        const valueElement = childElements[index + 1];
        if (keyElement?.name !== "key" || !valueElement) {
          continue;
        }
        const keyName = readXmlText(keyElement);
        if (!keyName) {
          continue;
        }
        plistObject[keyName] = parsePlistElement(valueElement);
      }
      return plistObject;
    }
    case "false":
      return false;
    case "integer":
      return Number.parseInt(readXmlText(node), 10);
    case "true":
      return true;
    default:
      return readXmlText(node);
  }
}

function parsePlistFile(plistPath) {
  const plistXml = readFileSync(plistPath, "utf8");
  const plistJson = xml2js(plistXml, {
    compact: false,
    ignoreCdata: false,
    ignoreComment: true,
    ignoreDoctype: true,
    ignoreInstruction: true,
    trim: true,
  });
  const plistElement = plistJson?.elements?.find(
    (element) => element?.type === "element" && element?.name === "plist",
  );
  const rootElement = plistElement?.elements?.find(
    (element) => element?.type === "element",
  );
  return parsePlistElement(rootElement);
}

function findEnclosingElectronInfoPlist(archivePath) {
  let currentDir = dirname(resolve(archivePath));
  let currentDepth = 0;
  while (currentDir && currentDir !== dirname(currentDir)) {
    if (currentDepth >= MAX_ELECTRON_APP_BUNDLE_SEARCH_DEPTH) {
      thoughtLog(
        "Stopping Electron app bundle search after",
        MAX_ELECTRON_APP_BUNDLE_SEARCH_DEPTH,
        "levels for",
        archivePath,
      );
      return undefined;
    }
    if (basename(currentDir).endsWith(".app")) {
      const infoPlistPath = join(currentDir, "Contents", "Info.plist");
      if (safeExistsSync(infoPlistPath)) {
        return {
          appDir: currentDir,
          infoPlistPath,
        };
      }
    }
    currentDepth += 1;
    currentDir = dirname(currentDir);
  }
  return undefined;
}

function collectAsarSigningInfo(archivePath, headerString) {
  const bundleInfo = findEnclosingElectronInfoPlist(archivePath);
  if (!bundleInfo?.infoPlistPath) {
    return undefined;
  }
  const archiveRelativePath = relative(
    join(bundleInfo.appDir, "Contents"),
    resolve(archivePath),
  ).replaceAll("\\", "/");
  if (!archiveRelativePath || archiveRelativePath.startsWith("..")) {
    return undefined;
  }
  let plistData;
  try {
    plistData = parsePlistFile(bundleInfo.infoPlistPath);
  } catch {
    return undefined;
  }
  const asarIntegrityRecord =
    plistData?.ElectronAsarIntegrity?.[archiveRelativePath];
  if (!asarIntegrityRecord || typeof asarIntegrityRecord !== "object") {
    return undefined;
  }
  const computedHash = sha256Buffer(Buffer.from(headerString, "utf8"));
  const algorithm = String(asarIntegrityRecord.algorithm || "").toUpperCase();
  const declaredHash = String(asarIntegrityRecord.hash || "").toLowerCase();
  return {
    algorithm,
    archiveRelativePath,
    computedHash,
    declaredHash,
    infoPlistPath: bundleInfo.infoPlistPath,
    scope: "header-only",
    source: "electron-info-plist",
    verified:
      algorithm === "SHA256" &&
      /^[a-f0-9]{64}$/i.test(declaredHash) &&
      declaredHash === computedHash,
  };
}

function createAsarSigningComponent(archivePath, signingInfo, options = {}) {
  const specVersionNumber = Number(options.specVersion || 0);
  const componentType =
    specVersionNumber > 0 && specVersionNumber < 1.6
      ? "data"
      : "cryptographic-asset";
  const properties = [{ name: "SrcFile", value: archivePath }];
  addSanitizedProperty(
    properties,
    "cdx:asar:signingAlgorithm",
    signingInfo.algorithm,
  );
  addSanitizedProperty(
    properties,
    "cdx:asar:signingDeclaredHash",
    signingInfo.declaredHash,
  );
  addSanitizedProperty(
    properties,
    "cdx:asar:headerHash",
    signingInfo.computedHash,
  );
  addSanitizedProperty(
    properties,
    "cdx:asar:signingSource",
    signingInfo.source,
  );
  addSanitizedProperty(properties, "cdx:asar:signingScope", signingInfo.scope);
  addSanitizedProperty(
    properties,
    "cdx:asar:signingVerified",
    String(signingInfo.verified),
  );
  addSanitizedProperty(
    properties,
    "cdx:asar:signingArchivePath",
    signingInfo.archiveRelativePath,
  );
  const component = {
    "bom-ref": `crypto/asar-signature/${encodeURIComponent(archivePath)}@sha256:${signingInfo.declaredHash || signingInfo.computedHash}`,
    hashes: [
      {
        alg: "SHA-256",
        content: signingInfo.declaredHash || signingInfo.computedHash,
      },
    ],
    name: `${basename(archivePath)} asar integrity record`,
    properties,
    type: componentType,
    version: signingInfo.declaredHash || signingInfo.computedHash,
  };
  if (componentType === "cryptographic-asset") {
    component.cryptoProperties = {
      assetType: "related-crypto-material",
      relatedCryptoMaterialProperties: {
        type: "digest",
        value: signingInfo.declaredHash || signingInfo.computedHash,
      },
    };
  }
  return component;
}

function toFileComponentRef(archivePath, entryPath) {
  return `file:${archivePath}#/${normalizeArchiveRelativePath(entryPath)}`;
}

function inferPrimaryPackagePath(entries) {
  const packageEntries = entries
    .filter(
      (entry) =>
        entry.type === "file" &&
        basename(entry.path) === "package.json" &&
        !entry.path.includes("/node_modules/"),
    )
    .sort((left, right) => left.path.length - right.path.length);
  return packageEntries[0]?.path;
}

function inferMainEntryFlags(packageJson) {
  const properties = [];
  addSanitizedProperty(properties, "cdx:asar:main", packageJson?.main);
  addSanitizedProperty(properties, "cdx:asar:module", packageJson?.module);
  addSanitizedProperty(properties, "cdx:asar:browser", packageJson?.browser);
  addSanitizedProperty(
    properties,
    "cdx:asar:productName",
    packageJson?.productName,
  );
  const lifecycleScripts = Object.keys(packageJson?.scripts || {}).filter(
    (name) => ASAR_LIFECYCLE_SCRIPT_NAMES.has(name),
  );
  if (lifecycleScripts.length) {
    addSanitizedProperty(
      properties,
      "cdx:asar:lifecycleScripts",
      lifecycleScripts.join(", "),
    );
  }
  return properties;
}

function toArchiveVirtualPath(extractedDir, archivePath, candidatePath) {
  if (!candidatePath || typeof candidatePath !== "string") {
    return candidatePath;
  }
  const normalizedExtractedDir = resolve(extractedDir);
  const normalizedCandidate = resolve(candidatePath);
  if (!isPathWithin(normalizedExtractedDir, normalizedCandidate)) {
    return candidatePath;
  }
  const relativePath = relative(normalizedExtractedDir, normalizedCandidate);
  return `${archivePath}#/${relativePath.replaceAll("\\", "/")}`;
}

export function rewriteExtractedArchivePaths(
  subject,
  extractedDir,
  archivePath,
) {
  if (!subject || typeof subject !== "object") {
    return subject;
  }
  if (Array.isArray(subject)) {
    subject.forEach((entry) => {
      rewriteExtractedArchivePaths(entry, extractedDir, archivePath);
    });
    return subject;
  }
  if (subject.properties?.length) {
    subject.properties.forEach((property) => {
      if (typeof property?.value === "string") {
        property.value = toArchiveVirtualPath(
          extractedDir,
          archivePath,
          property.value,
        );
      }
    });
  }
  if (subject.evidence?.identity?.methods?.length) {
    subject.evidence.identity.methods.forEach((method) => {
      if (typeof method?.value === "string") {
        method.value = toArchiveVirtualPath(
          extractedDir,
          archivePath,
          method.value,
        );
      }
    });
  }
  if (subject.evidence?.occurrences?.length) {
    subject.evidence.occurrences.forEach((occurrence) => {
      if (typeof occurrence?.location === "string") {
        occurrence.location = toArchiveVirtualPath(
          extractedDir,
          archivePath,
          occurrence.location,
        );
      }
    });
  }
  if (subject.components?.length) {
    rewriteExtractedArchivePaths(subject.components, extractedDir, archivePath);
  }
  return subject;
}

function collectArchiveSummaryProperties(
  archivePath,
  summary,
  primaryPackageJson,
  primaryPackagePath,
) {
  const properties = [{ name: "SrcFile", value: archivePath }];
  addSanitizedProperty(properties, "cdx:file:kind", "asar-archive");
  addSanitizedProperty(
    properties,
    "cdx:asar:entryCount",
    `${summary.entryCount}`,
  );
  addSanitizedProperty(
    properties,
    "cdx:asar:fileCount",
    `${summary.fileCount}`,
  );
  addSanitizedProperty(
    properties,
    "cdx:asar:directoryCount",
    `${summary.directoryCount}`,
  );
  addSanitizedProperty(
    properties,
    "cdx:asar:symlinkCount",
    `${summary.symlinkCount}`,
  );
  addSanitizedProperty(
    properties,
    "cdx:asar:jsFileCount",
    `${summary.jsFileCount}`,
  );
  addSanitizedProperty(
    properties,
    "cdx:asar:packageJsonCount",
    `${summary.packageJsonCount}`,
  );
  addSanitizedProperty(
    properties,
    "cdx:asar:lockfileCount",
    `${summary.lockfileCount}`,
  );
  if (summary.nestedArchiveCount > 0) {
    addSanitizedProperty(properties, "cdx:asar:hasNestedArchives", "true");
    addSanitizedProperty(
      properties,
      "cdx:asar:nestedArchiveCount",
      `${summary.nestedArchiveCount}`,
    );
  }
  if (summary.unpackedFileCount > 0) {
    addSanitizedProperty(properties, "cdx:asar:hasUnpackedEntries", "true");
    addSanitizedProperty(
      properties,
      "cdx:asar:unpackedFileCount",
      `${summary.unpackedFileCount}`,
    );
  }
  if (summary.nativeAddonCount > 0) {
    addSanitizedProperty(properties, "cdx:asar:hasNativeAddons", "true");
    addSanitizedProperty(
      properties,
      "cdx:asar:nativeAddonCount",
      `${summary.nativeAddonCount}`,
    );
  }
  if (summary.integrityMismatchCount > 0) {
    addSanitizedProperty(properties, "cdx:asar:hasIntegrityMismatch", "true");
    addSanitizedProperty(
      properties,
      "cdx:asar:integrityMismatchCount",
      `${summary.integrityMismatchCount}`,
    );
  }
  if (summary.capabilities.length) {
    addSanitizedProperty(
      properties,
      "cdx:asar:capabilities",
      summary.capabilities.join(", "),
    );
    summary.capabilities.forEach((capability) => {
      addSanitizedProperty(
        properties,
        `cdx:asar:capability:${capability}`,
        "true",
      );
    });
  }
  if (summary.executionIndicators.length) {
    addSanitizedProperty(
      properties,
      "cdx:asar:executionIndicators",
      summary.executionIndicators.join(", "),
    );
  }
  if (summary.networkIndicators.length) {
    addSanitizedProperty(
      properties,
      "cdx:asar:networkIndicators",
      summary.networkIndicators.join(", "),
    );
  }
  if (summary.obfuscationIndicators.length) {
    addSanitizedProperty(
      properties,
      "cdx:asar:obfuscationIndicators",
      summary.obfuscationIndicators.join(", "),
    );
  }
  if (summary.hasEval) {
    addSanitizedProperty(properties, "cdx:asar:hasEval", "true");
  }
  if (summary.hasDynamicFetch) {
    addSanitizedProperty(properties, "cdx:asar:hasDynamicFetch", "true");
  }
  if (summary.hasDynamicImport) {
    addSanitizedProperty(properties, "cdx:asar:hasDynamicImport", "true");
  }
  if (summary.headerHash) {
    addSanitizedProperty(properties, "cdx:asar:headerHash", summary.headerHash);
  }
  if (summary.signingInfo) {
    addSanitizedProperty(properties, "cdx:asar:hasSigningMetadata", "true");
    addSanitizedProperty(
      properties,
      "cdx:asar:signingAlgorithm",
      summary.signingInfo.algorithm,
    );
    addSanitizedProperty(
      properties,
      "cdx:asar:signingDeclaredHash",
      summary.signingInfo.declaredHash,
    );
    addSanitizedProperty(
      properties,
      "cdx:asar:signingSource",
      summary.signingInfo.source,
    );
    addSanitizedProperty(
      properties,
      "cdx:asar:signingScope",
      summary.signingInfo.scope,
    );
    addSanitizedProperty(
      properties,
      "cdx:asar:signingVerified",
      String(summary.signingInfo.verified),
    );
  }
  if (primaryPackagePath) {
    addSanitizedProperty(
      properties,
      "cdx:asar:primaryManifest",
      `${archivePath}#/${primaryPackagePath}`,
    );
  }
  if (primaryPackageJson) {
    inferMainEntryFlags(primaryPackageJson).forEach((property) => {
      properties.push(property);
    });
  }
  return properties;
}

function createArchiveParentComponent(
  archivePath,
  summary,
  primaryPackageJson,
  primaryPackagePath,
) {
  const archivePurl =
    createAsarPackagePurl(
      primaryPackageJson?.name,
      primaryPackageJson?.version,
    ) || createGenericArchivePurl(archivePath, primaryPackageJson?.version);
  const component = {
    "bom-ref": decodeURIComponent(archivePurl),
    description:
      primaryPackageJson?.description ||
      `Electron ASAR archive ${basename(archivePath)}`,
    name:
      primaryPackageJson?.productName ||
      primaryPackageJson?.name ||
      basename(archivePath, ".asar"),
    purl: archivePurl,
    type: "application",
    version: primaryPackageJson?.version || "",
  };
  const parsedName = parseScopedPackageName(primaryPackageJson?.name);
  if (parsedName.group) {
    component.group = parsedName.group;
  }
  if (primaryPackageJson?.author) {
    component.author =
      typeof primaryPackageJson.author === "string"
        ? primaryPackageJson.author
        : primaryPackageJson.author?.name || "";
  }
  if (primaryPackageJson?.license) {
    component.license = primaryPackageJson.license;
  }
  if (primaryPackageJson?.repository) {
    const repositoryUrl =
      typeof primaryPackageJson.repository === "string"
        ? primaryPackageJson.repository
        : primaryPackageJson.repository?.url;
    if (repositoryUrl) {
      component.externalReferences = component.externalReferences || [];
      component.externalReferences.push({
        type: "vcs",
        url: repositoryUrl,
      });
    }
  }
  if (primaryPackageJson?.homepage) {
    component.externalReferences = component.externalReferences || [];
    component.externalReferences.push({
      type: "website",
      url: primaryPackageJson.homepage,
    });
  }
  component.properties = collectArchiveSummaryProperties(
    archivePath,
    summary,
    primaryPackageJson,
    primaryPackagePath,
  );
  component.evidence = {
    identity: {
      confidence: 1,
      field: "purl",
      methods: [
        {
          confidence: 1,
          technique: primaryPackagePath ? "manifest-analysis" : "filename",
          value: primaryPackagePath
            ? `${archivePath}#/${primaryPackagePath}`
            : archivePath,
        },
      ],
    },
  };
  return component;
}

function createArchiveEntryComponent(
  archivePath,
  entry,
  computedHash,
  jsAnalysis,
  suspiciousAnalysis,
) {
  const archiveLocation = toArchiveOccurrence(archivePath, entry.path);
  const properties = [{ name: "SrcFile", value: archivePath }];
  addSanitizedProperty(properties, "cdx:file:kind", "asar-entry");
  addSanitizedProperty(properties, "cdx:asar:path", entry.path);
  addSanitizedProperty(properties, "cdx:asar:size", `${entry.size || 0}`);
  addSanitizedProperty(
    properties,
    "cdx:asar:unpacked",
    String(entry.unpacked === true),
  );
  if (entry.offset !== undefined) {
    addSanitizedProperty(properties, "cdx:asar:offset", entry.offset);
  }
  if (entry.executable) {
    addSanitizedProperty(properties, "cdx:asar:executable", "true");
  }
  if (entry.link) {
    addSanitizedProperty(properties, "cdx:asar:linkTarget", entry.link);
  }
  if (entry.integrity?.algorithm) {
    addSanitizedProperty(
      properties,
      "cdx:asar:integrityAlgorithm",
      entry.integrity.algorithm,
    );
  }
  if (entry.integrity?.hash) {
    addSanitizedProperty(
      properties,
      "cdx:asar:declaredIntegrityHash",
      entry.integrity.hash,
    );
  }
  if (entry.integrity?.blockSize) {
    addSanitizedProperty(
      properties,
      "cdx:asar:integrityBlockSize",
      `${entry.integrity.blockSize}`,
    );
  }
  if (Array.isArray(entry.integrity?.blocks)) {
    addSanitizedProperty(
      properties,
      "cdx:asar:integrityBlockCount",
      `${entry.integrity.blocks.length}`,
    );
  }
  if (computedHash && entry.integrity?.hash) {
    addSanitizedProperty(
      properties,
      "cdx:asar:integrityVerified",
      String(computedHash === String(entry.integrity.hash).toLowerCase()),
    );
  }
  if (jsAnalysis?.capabilities?.length) {
    addSanitizedProperty(
      properties,
      "cdx:asar:js:capabilities",
      jsAnalysis.capabilities.join(", "),
    );
    jsAnalysis.capabilities.forEach((capability) => {
      addSanitizedProperty(
        properties,
        `cdx:asar:js:capability:${capability}`,
        "true",
      );
    });
  }
  if (jsAnalysis?.hasEval) {
    addSanitizedProperty(properties, "cdx:asar:js:hasEval", "true");
  }
  if (jsAnalysis?.hasDynamicFetch) {
    addSanitizedProperty(properties, "cdx:asar:js:hasDynamicFetch", "true");
  }
  if (jsAnalysis?.hasDynamicImport) {
    addSanitizedProperty(properties, "cdx:asar:js:hasDynamicImport", "true");
  }
  if (jsAnalysis?.indicatorMap?.fileAccess?.length) {
    addSanitizedProperty(
      properties,
      "cdx:asar:js:fileAccessIndicators",
      jsAnalysis.indicatorMap.fileAccess.join(", "),
    );
  }
  if (jsAnalysis?.indicatorMap?.network?.length) {
    addSanitizedProperty(
      properties,
      "cdx:asar:js:networkIndicators",
      jsAnalysis.indicatorMap.network.join(", "),
    );
  }
  if (jsAnalysis?.indicatorMap?.hardware?.length) {
    addSanitizedProperty(
      properties,
      "cdx:asar:js:hardwareIndicators",
      jsAnalysis.indicatorMap.hardware.join(", "),
    );
  }
  if (suspiciousAnalysis?.executionIndicators?.length) {
    addSanitizedProperty(
      properties,
      "cdx:asar:js:executionIndicators",
      suspiciousAnalysis.executionIndicators.join(", "),
    );
  }
  if (suspiciousAnalysis?.obfuscationIndicators?.length) {
    addSanitizedProperty(
      properties,
      "cdx:asar:js:obfuscationIndicators",
      suspiciousAnalysis.obfuscationIndicators.join(", "),
    );
  }
  return {
    "bom-ref": toFileComponentRef(archivePath, entry.path),
    evidence: {
      identity: {
        confidence: 1,
        field: "name",
        methods: [
          {
            confidence: 1,
            technique: "filename",
            value: archiveLocation,
          },
        ],
      },
      occurrences: [{ location: archiveLocation }],
    },
    hashes: computedHash
      ? [{ alg: "SHA-256", content: computedHash }]
      : undefined,
    name: basename(entry.path),
    properties,
    type: "file",
    version: computedHash || undefined,
  };
}

/**
 * Parse an Electron ASAR archive and emit inventory, metadata, and optional
 * signing information.
 *
 * @param {string} archivePath Absolute or relative path to an ASAR archive
 * @param {Object} [options={}] Parse options
 * @param {string} [options.asarVirtualPath] Virtual archive identity to use in
 * BOM references and evidence for nested ASAR recursion
 * @param {number} [options.specVersion] CycloneDX spec version used to choose
 * compatible component types
 * @returns {Promise<Object>} Parsed archive analysis result
 */
export async function parseAsarArchive(archivePath, options = {}) {
  const resolvedArchivePath = resolve(archivePath);
  const parsedArchive = listAsarEntries(resolvedArchivePath);
  const archiveIdentityPath =
    typeof options?.asarVirtualPath === "string" && options.asarVirtualPath
      ? options.asarVirtualPath
      : resolvedArchivePath;
  const signingInfo = collectAsarSigningInfo(
    resolvedArchivePath,
    parsedArchive.headerString,
  );
  const summary = {
    capabilities: new Set(),
    directoryCount: 0,
    entryCount: parsedArchive.entries.length,
    executionIndicators: new Set(),
    fileCount: 0,
    headerHash: sha256Buffer(Buffer.from(parsedArchive.headerString, "utf8")),
    hasDynamicFetch: false,
    hasDynamicImport: false,
    hasEval: false,
    integrityMismatchCount: 0,
    jsFileCount: 0,
    lockfileCount: 0,
    nativeAddonCount: 0,
    nestedArchiveCount: 0,
    networkIndicators: new Set(),
    obfuscationIndicators: new Set(),
    packageJsonCount: 0,
    signingInfo,
    symlinkCount: 0,
    unpackedFileCount: 0,
  };
  const components = [];
  const dependencies = [];
  const packageManifestPaths = [];
  let primaryPackageJson;
  const primaryPackagePath = inferPrimaryPackagePath(parsedArchive.entries);
  let archiveFd;
  try {
    for (const entry of parsedArchive.entries) {
      if (entry.type === "directory") {
        summary.directoryCount += 1;
        continue;
      }
      if (entry.type === "link") {
        summary.symlinkCount += 1;
        components.push(
          createArchiveEntryComponent(archiveIdentityPath, entry, undefined),
        );
        continue;
      }
      summary.fileCount += 1;
      if (entry.unpacked) {
        summary.unpackedFileCount += 1;
      }
      if (basename(entry.path) === "package.json") {
        summary.packageJsonCount += 1;
        packageManifestPaths.push(entry.path);
      }
      if (ASAR_LOCKFILE_NAMES.has(basename(entry.path))) {
        summary.lockfileCount += 1;
      }
      if (extname(entry.path) === ".asar") {
        summary.nestedArchiveCount += 1;
      }
      if (extname(entry.path) === ".node") {
        summary.nativeAddonCount += 1;
      }
      let computedHash;
      let fileBuffer;
      let jsAnalysis;
      let suspiciousAnalysis;
      try {
        if (!entry.unpacked && archiveFd === undefined) {
          archiveFd = openSync(resolvedArchivePath, "r");
        }
        fileBuffer = readAsarEntryBufferSync(
          resolvedArchivePath,
          parsedArchive.archiveDataOffset,
          entry,
          archiveFd,
        );
        computedHash = sha256Buffer(fileBuffer);
        if (
          entry.integrity?.hash &&
          computedHash !== String(entry.integrity.hash).toLowerCase()
        ) {
          summary.integrityMismatchCount += 1;
        }
        if (
          entry.path === primaryPackagePath &&
          basename(entry.path) === "package.json"
        ) {
          try {
            primaryPackageJson = JSON.parse(fileBuffer.toString("utf8"));
          } catch {
            // Ignore malformed package metadata and fall back to archive name.
          }
        }
      } catch (error) {
        thoughtLog("Error reading ASAR entry", entry.path, error.message);
        throw error;
      }
      if (ASAR_JS_ANALYSIS_EXTENSIONS.has(extname(entry.path))) {
        summary.jsFileCount += 1;
        const sourceBuffer =
          fileBuffer ||
          (entry.unpacked
            ? readFileSync(
                resolveUnpackedEntryPath(resolvedArchivePath, entry.path),
              )
            : undefined);
        if (sourceBuffer) {
          const sourceText = sourceBuffer.toString("utf8");
          jsAnalysis = analyzeJsCapabilitiesSource(sourceText);
          suspiciousAnalysis = analyzeSuspiciousJsSource(sourceText);
        }
      }
      jsAnalysis?.capabilities?.forEach((capability) => {
        summary.capabilities.add(capability);
      });
      suspiciousAnalysis?.executionIndicators?.forEach((indicator) => {
        summary.executionIndicators.add(indicator);
        if (indicator === "eval") {
          summary.hasEval = true;
        }
      });
      suspiciousAnalysis?.networkIndicators?.forEach((indicator) => {
        summary.networkIndicators.add(indicator);
      });
      suspiciousAnalysis?.obfuscationIndicators?.forEach((indicator) => {
        summary.obfuscationIndicators.add(indicator);
      });
      if (jsAnalysis?.hasDynamicFetch) {
        summary.hasDynamicFetch = true;
      }
      if (jsAnalysis?.hasDynamicImport) {
        summary.hasDynamicImport = true;
      }
      components.push(
        createArchiveEntryComponent(
          archiveIdentityPath,
          entry,
          computedHash,
          jsAnalysis,
          suspiciousAnalysis,
        ),
      );
    }
  } finally {
    if (archiveFd !== undefined) {
      closeSync(archiveFd);
    }
  }
  const normalizedSummary = {
    ...summary,
    capabilities: Array.from(summary.capabilities).sort(),
    executionIndicators: Array.from(summary.executionIndicators).sort(),
    networkIndicators: Array.from(summary.networkIndicators).sort(),
    obfuscationIndicators: Array.from(summary.obfuscationIndicators).sort(),
  };
  const parentComponent = createArchiveParentComponent(
    archiveIdentityPath,
    normalizedSummary,
    primaryPackageJson,
    primaryPackagePath,
  );
  if (signingInfo) {
    const signingComponent = createAsarSigningComponent(
      archiveIdentityPath,
      signingInfo,
      options,
    );
    components.push(signingComponent);
    if (parentComponent?.["bom-ref"] && signingComponent?.["bom-ref"]) {
      dependencies.push({
        ref: parentComponent["bom-ref"],
        dependsOn: [signingComponent["bom-ref"]],
      });
    }
  }
  recordActivity({
    capability: "archive-analysis",
    kind: "read",
    reason: `Cataloged ${normalizedSummary.fileCount} ASAR file entr${normalizedSummary.fileCount === 1 ? "y" : "ies"} from ${resolvedArchivePath}.`,
    status: "completed",
    target: resolvedArchivePath,
  });
  return {
    components,
    dependencies,
    entries: parsedArchive.entries,
    packageManifestPaths,
    parentComponent,
    primaryPackageJson,
    primaryPackagePath,
    summary: normalizedSummary,
  };
}

function extractAsarArchive(archivePath, targetDir) {
  const parsedArchive = listAsarEntries(archivePath);
  const validatedSymlinkTargets = validateArchiveSymlinkEntries(
    parsedArchive.entries,
  );
  safeMkdirSync(targetDir, { recursive: true });
  let archiveFd;
  try {
    for (const entry of parsedArchive.entries) {
      const destinationPath = resolve(
        targetDir,
        ...normalizeArchiveRelativePath(entry.path).split("/"),
      );
      if (!isPathWithin(targetDir, destinationPath)) {
        throw new Error(
          `Refusing to extract ASAR entry outside target dir: ${entry.path}`,
        );
      }
      if (entry.type === "directory") {
        safeMkdirSync(destinationPath, { recursive: true });
        continue;
      }
      safeMkdirSync(dirname(destinationPath), { recursive: true });
      if (entry.type === "link") {
        const validatedLinkTarget = validatedSymlinkTargets.get(
          normalizeArchiveRelativePath(entry.path),
        );
        const resolvedLinkTargetPath = resolve(
          targetDir,
          ...validatedLinkTarget.split("/"),
        );
        if (!isPathWithin(targetDir, resolvedLinkTargetPath)) {
          throw new Error(
            `ASAR symlink ${entry.path} target escapes extraction root: ${validatedLinkTarget}`,
          );
        }
        const relativeLinkTarget = relative(
          dirname(destinationPath),
          resolvedLinkTargetPath,
        );
        try {
          symlinkSync(relativeLinkTarget, destinationPath);
        } catch (error) {
          if (process.platform === "win32") {
            thoughtLog(
              "Unable to recreate ASAR symlink on Windows; falling back",
              entry.path,
              error.message,
            );
            try {
              const linkTargetStats = statSync(resolvedLinkTargetPath);
              if (linkTargetStats.isDirectory()) {
                safeMkdirSync(destinationPath, { recursive: true });
              } else if (linkTargetStats.isFile()) {
                safeCopyFileSync(resolvedLinkTargetPath, destinationPath);
              }
              continue;
            } catch {
              continue;
            }
          }
          throw new Error(
            `Failed to recreate ASAR symlink ${entry.path} -> ${validatedLinkTarget} at ${destinationPath}: ${error.message}`,
          );
        }
        continue;
      }
      if (entry.unpacked) {
        safeCopyFileSync(
          resolveUnpackedEntryPath(archivePath, entry.path),
          destinationPath,
        );
        continue;
      }
      if (archiveFd === undefined) {
        archiveFd = openSync(archivePath, "r");
      }
      const fileBuffer = readPackedEntryBuffer(
        archivePath,
        parsedArchive.archiveDataOffset,
        entry,
        archiveFd,
      );
      safeWriteSync(destinationPath, fileBuffer);
      if (entry.executable && process.platform !== "win32") {
        try {
          chmodSync(destinationPath, 0o755);
        } catch (error) {
          throw new Error(
            `Failed to mark extracted ASAR entry ${entry.path} executable at ${destinationPath}: ${error.message}`,
          );
        }
      }
    }
  } finally {
    if (archiveFd !== undefined) {
      closeSync(archiveFd);
    }
  }
}

export async function extractAsarToTempDir(archivePath) {
  let tempDir;
  try {
    tempDir = safeMkdtempSync(join(getTmpDir(), "asar-deps-"));
    const extracted = await safeExtractArchive(
      archivePath,
      tempDir,
      async () => {
        extractAsarArchive(archivePath, tempDir);
      },
      "asar",
      {
        metadata: { archivePath },
      },
    );
    if (!extracted) {
      return undefined;
    }
    return tempDir;
  } catch (error) {
    if (DEBUG_MODE) {
      console.log(
        `Error extracting ASAR archive ${archivePath}:`,
        error.message,
      );
    }
    cleanupAsarTempDir(tempDir);
    return undefined;
  }
}

export function cleanupAsarTempDir(tempDir) {
  if (!tempDir) {
    return;
  }
  const resolvedDir = resolve(tempDir);
  const expectedBase = resolve(getTmpDir());
  if (
    basename(resolvedDir).startsWith("asar-deps-") &&
    resolve(resolvedDir, "..") === expectedBase
  ) {
    safeRmSync(resolvedDir, { force: true, recursive: true });
  }
}

export function buildAsarExtractionSummary(
  archiveAnalysis,
  extractionPerformed,
) {
  const properties = [];
  if (archiveAnalysis?.packageManifestPaths?.length) {
    addSanitizedProperty(
      properties,
      "cdx:asar:embeddedManifests",
      archiveAnalysis.packageManifestPaths
        .map((manifestPath) =>
          toArchiveOccurrence("", manifestPath).replace(/^#/, ""),
        )
        .join(", "),
    );
  }
  if (archiveAnalysis?.summary?.packageJsonCount) {
    addSanitizedProperty(
      properties,
      "cdx:asar:manifestInventoryComplete",
      String(!isDryRun || extractionPerformed),
    );
  }
  return properties;
}
