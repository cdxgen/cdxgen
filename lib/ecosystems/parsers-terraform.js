import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { DEBUG_MODE } from "../core/activity.js";
import { getAllFiles, safeExistsSync } from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { applyPurl, tryBuildPurl } from "../inventory/purl.js";
import { isSafeGitRefName } from "../inventory/source.js";
import { licenseIdFromText } from "../inventory/spdx.js";
import { submodulePurlCoordinates } from "../parsers/gitmodules.js";
import {
  mergeTerraformConfigs,
  parseTerraformConfig,
  terraformConfigFileSet,
} from "../parsers/terraformConfig.js";
import {
  classifyVcsRef,
  classifyVersionConstraint,
  OPENTOFU_REGISTRY_HOST,
  parseModuleSource,
  parseProviderSource,
  TERRAFORM_REGISTRY_HOST,
} from "../parsers/terraformSource.js";

/**
 * Terraform and OpenTofu parsing: the provider lock file, the module
 * manifest `init` writes, and the configuration files that declare modules
 * and required providers.
 *
 * The lock file is written in a small, regular subset of HCL: provider
 * blocks, `version` and `constraints` attributes, and a `hashes` list of
 * prefixed digests. A line scanner is sufficient and avoids a general HCL
 * parser (see {@link parseTerraformLockFile}); configuration files go
 * through the dedicated extractor in `lib/parsers/terraformConfig.js`.
 *
 * Modules are not in the lock file — Terraform designed it that way — so the
 * workspace assembly reads `.terraform/modules/modules.json` when `init` has
 * run and falls back to a static walk of `module` blocks. Provider addresses
 * look like `registry.terraform.io/hashicorp/aws`; the registry host and
 * namespace identify the provider upstream, so they are kept in the
 * component group and a generic purl
 * (`pkg:generic/<host>/<namespace>/<type>@<version>`), with the intended type
 * recorded as a `cdx:purl:proposedType` property because no `terraform`
 * purl type is registered. Local modules are flattened into their calling
 * package: they are part of the project, not dependencies.
 *
 * Everything this module reads comes from untrusted trees, so every read is
 * bounds-checked by {@link readFileWithin} (realpath containment, regular
 * files only, byte caps) and module source strings are sanitized upstream in
 * `terraformSource.js`. No network I/O happens here; remote enrichment lives
 * in `terraformRegistry.js`.
 */

const CONFIG_MAX_BYTES = 5 * 1024 * 1024;
const MODULES_JSON_MAX_BYTES = 20 * 1024 * 1024;
const LICENSE_MAX_BYTES = 256 * 1024;
const GIT_HEAD_MAX_BYTES = 1024;
const MAX_MODULE_RECORDS = 10000;
const MAX_LOCAL_DEPTH = 64;
const MAX_OCCURRENCES = 25;
const REMOTE_KINDS = new Set(["registry", "git", "hg", "http", "s3", "gcs"]);
const LICENSE_CANDIDATES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENCE.md",
  "LICENCE.txt",
  "COPYING",
  "COPYING.md",
  "COPYING.txt",
];
/** Longest archive extensions first so `.tar.gz` survives `.tar` checks. */
const ARCHIVE_EXTENSIONS = [
  ".tar.gz",
  ".tar.bz2",
  ".tar.xz",
  ".tbz2",
  ".tgz",
  ".txz",
  ".zip",
  ".tar",
];
/**
 * Trees Terraform discovery never descends into. `.terraform` and
 * `.terragrunt-cache` are download caches whose contents the workspace reads
 * through exact paths only. `node_modules` holds other packages' files: a
 * `.tf` shipped inside an npm package is not a configuration of the scanned
 * project, and a local module call that points into `node_modules` is still
 * followed. Listing it explicitly matters because another collector in the
 * same multi-type scan may have set `includeNodeModulesDir` on the shared
 * options, which otherwise makes every glob walk it.
 */
const TERRAFORM_EXCLUDES = [
  "**/.terraform/**",
  "**/.terragrunt-cache/**",
  "**/node_modules/**",
];

/**
 * The configuration and lock files Terraform discovery considers under a
 * path, with the discovery exclusions applied.
 *
 * @param {string} scanPath Directory to scan
 * @param {Object} [options] CLI options
 * @returns {string[]} Matching files
 */
function terraformDiscoveryFiles(scanPath, options = {}) {
  const opts = {
    ...options,
    exclude: [...(options.exclude || []), ...TERRAFORM_EXCLUDES],
  };
  const prefix = options.multiProject ? "**/" : "";
  return [
    ...getAllFiles(scanPath, `${prefix}*.{tf,tf.json,tofu,tofu.json}`, opts),
    ...getAllFiles(scanPath, `${prefix}.terraform.lock.hcl`, opts),
  ];
}

/**
 * Whether a path holds any Terraform or OpenTofu configuration or lock file
 * the workspace assembly would consider; used by project-type autodetection.
 *
 * @param {string} scanPath Directory to scan
 * @param {Object} [options] CLI options
 * @returns {boolean}
 */
export function hasTerraformConfiguration(scanPath, options = {}) {
  return terraformDiscoveryFiles(scanPath, options).length > 0;
}

/**
 * Parse a `.terraform.lock.hcl` file.
 *
 * @param {string} lockFile Path to the lock file
 * @returns {{ pkgList: object[] }} Provider components
 */
export function parseTerraformLockFile(lockFile) {
  let text;
  try {
    text = readFileSync(lockFile, "utf-8");
  } catch (error) {
    console.warn(`Failed to read ${lockFile}: ${error.message}`);
    return { pkgList: [] };
  }

  const pkgList = [];
  let current;
  let inHashes = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (inHashes) {
      if (line.startsWith("]")) {
        inHashes = false;
        continue;
      }
      const hash = line.match(/^"([^"]+)"/u);
      if (hash && current) {
        current.candidates.push(hash[1]);
      }
      continue;
    }
    const block = line.match(/^provider\s+"([^"]+)"\s*\{/u);
    if (block) {
      current = { address: block[1], candidates: [] };
      continue;
    }
    if (line.startsWith("}")) {
      if (current) {
        const pkg = buildProviderComponent(current, lockFile);
        if (pkg) {
          pkgList.push(pkg);
        }
        current = undefined;
      }
      continue;
    }
    const version = matchAttribute(line, "version");
    if (version && current) {
      current.version = version;
      continue;
    }
    const constraints = matchAttribute(line, "constraints");
    if (constraints && current) {
      current.constraints = constraints;
      continue;
    }
    if (/^hashes\s*=\s*\[/u.test(line) && current) {
      inHashes = true;
      // Some writers put the first digest on the same line as the bracket.
      const inline = line.replace(/^hashes\s*=\s*\[\s*/u, "");
      const inlineHash = inline.match(/^"([^"]+)"/u);
      if (inlineHash) {
        current.candidates.push(inlineHash[1]);
      }
    }
  }
  return { pkgList };
}

/**
 * Match a string attribute assignment such as `version = "5.80.0"`.
 *
 * @param {string} line Trimmed line
 * @param {string} name Attribute name
 * @returns {string|undefined} Attribute value when present
 */
function matchAttribute(line, name) {
  const match = line.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "u"));
  return match ? match[1] : undefined;
}

/**
 * Build a provider component from one parsed block.
 *
 * @param {{address: string, version?: string, constraints?: string, candidates: string[]}} block
 *   Parsed provider block
 * @param {string} srcFile Lock file path
 * @returns {object|undefined} Component record
 */
function buildProviderComponent(block, srcFile) {
  const segments = block.address.split("/").filter(Boolean);
  if (segments.length < 2) {
    return undefined;
  }
  const name = segments[segments.length - 1];
  const namespace = segments.slice(0, -1).join("/");
  const purl = tryBuildPurl({
    type: "generic",
    namespace,
    name,
    version: block.version,
  });
  const properties = [
    { name: "internal:SrcFile", value: srcFile },
    { name: "cdx:purl:proposedType", value: "terraform-provider" },
    { name: "cdx:tf:kind", value: "provider" },
    { name: "cdx:tf:address", value: block.address },
  ];
  if (block.constraints) {
    properties.push({ name: "cdx:tf:constraints", value: block.constraints });
  }
  const contentHash = block.candidates.find((candidate) =>
    candidate.startsWith("h1:"),
  );
  if (contentHash) {
    properties.push({ name: "cdx:tf:h1", value: contentHash });
  }
  const pkg = {
    group: namespace,
    name,
    ...(block.version ? { version: block.version } : {}),
    type: "library",
    scope: "required",
    properties,
  };
  const sha256 = zipDigestsHex(block.candidates);
  if (sha256.length) {
    pkg.hashes = sha256.map((content) => ({ alg: "SHA-256", content }));
  }
  if (purl) {
    pkg.purl = purl;
    pkg["bom-ref"] = decodeURIComponent(purl);
  } else {
    pkg["bom-ref"] = `library:${block.address}:${block.version || ""}`;
  }
  return pkg;
}

/**
 * Collect the `zh:` package digests of a provider block.
 *
 * A provider is published as one zip per platform and the lock records a
 * digest for each, so a block yields several digests for the same version.
 * All of them are returned: each is a genuine SHA-256 of a distributed
 * artifact for this component, and the lock does not say which platform a
 * given digest belongs to.
 *
 * @param {string[]} candidates Prefixed digests from the hashes list
 * @returns {string[]} Lowercase hex digests, in file order and deduplicated
 */
function zipDigestsHex(candidates) {
  const digests = new Set();
  for (const candidate of candidates) {
    if (!candidate.startsWith("zh:")) {
      continue;
    }
    const digest = candidate.slice(3).toLowerCase();
    if (/^[0-9a-f]{64}$/u.test(digest)) {
      digests.add(digest);
    }
  }
  return [...digests];
}

/**
 * Read a file only when it stays inside `allowedRoot` (by realpath), is a
 * regular file, and is under `maxBytes`.
 *
 * @param {string} file Absolute path to read
 * @param {string} allowedRoot Absolute directory the file must live under
 * @param {number} maxBytes Byte cap
 * @returns {string|undefined} File contents, or undefined on any failure
 */
function readFileWithin(file, allowedRoot, maxBytes) {
  try {
    const realFile = realpathSync(file);
    const realRoot = realpathSync(allowedRoot);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
      return undefined;
    }
    const stats = statSync(realFile);
    if (!stats.isFile() || stats.size > maxBytes) {
      return undefined;
    }
    return readFileSync(realFile, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * List a directory's entry names, or undefined when unreadable.
 *
 * @param {string} dir Directory
 * @returns {string[]|undefined} Entry names
 */
function listDirNames(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return undefined;
  }
}

/**
 * POSIX-style path of `target` relative to `from`.
 *
 * @param {string} from Base directory
 * @param {string} target Absolute path
 * @returns {string} Relative path with `/` separators
 */
function posixRelative(from, target) {
  return relative(from, target).split(sep).join("/");
}

/**
 * Whether `child` is `parent` or lives underneath it (lexical check; real
 * paths are enforced separately by {@link readFileWithin}).
 *
 * @param {string} parent Absolute directory
 * @param {string} child Absolute path
 * @returns {boolean}
 */
function isInsideDir(parent, child) {
  const rel = relative(parent, child);
  if (!rel) {
    return true;
  }
  if (isAbsolute(rel)) {
    return false;
  }
  const first = rel.split(sep)[0];
  return first !== ".." && first !== ".";
}

/** Parent key of a dotted manifest key. */
function parentKeyOf(key) {
  const dot = key.lastIndexOf(".");
  return dot === -1 ? "" : key.slice(0, dot);
}

/** Safe realpath wrapper. */
function realpathOf(target) {
  try {
    return realpathSync(target);
  } catch {
    return undefined;
  }
}

/**
 * Locate the Terraform roots under `scanPath`: directories that own a
 * configuration — those with a lock file or module manifest, plus config
 * directories no other config directory references through a local module
 * call.
 *
 * @param {string} scanPath Directory to scan
 * @param {Object} options CLI options
 * @returns {{ dir: string, lockFile?: string, manifestFile?: string }[]} Roots sorted by relative POSIX path
 */
export function findTerraformRoots(scanPath, options = {}) {
  const configFiles = terraformDiscoveryFiles(scanPath, options);
  const scanReal = realpathOf(scanPath);
  if (!scanReal) {
    return [];
  }
  const candidates = new Set();
  for (const file of configFiles) {
    const dir = join(file, "..");
    const dirReal = realpathOf(dir);
    if (!dirReal || !isInsideDir(scanReal, dirReal)) {
      continue;
    }
    const rel = relative(scanPath, dir).split(sep);
    if (
      rel.includes(".terraform") ||
      rel.includes(".terragrunt-cache") ||
      rel.includes("node_modules")
    ) {
      continue;
    }
    candidates.add(dir);
  }
  const candidateList = [...candidates].sort();
  if (!candidateList.length) {
    return [];
  }
  const configs = new Map();
  for (const dir of candidateList) {
    configs.set(dir, loadMergedConfig(dir, scanReal));
  }
  const referenced = new Set();
  for (const dir of candidateList) {
    for (const call of configs.get(dir).moduleCalls) {
      if (!call.source || call.sourceLiteral !== true) {
        continue;
      }
      const parsed = parseModuleSource(call.source);
      if (parsed?.kind !== "local") {
        continue;
      }
      const target = resolve(dir, parsed.path);
      if (target !== dir && candidates.has(target)) {
        referenced.add(target);
      }
    }
  }
  let roots = candidateList.filter(
    (dir) =>
      safeExistsSync(join(dir, ".terraform.lock.hcl")) ||
      safeExistsSync(join(dir, ".terraform", "modules", "modules.json")) ||
      !referenced.has(dir),
  );
  if (!roots.length) {
    roots = candidateList;
  }
  return roots
    .map((dir) => rootDescriptor(dir))
    .sort((a, b) =>
      posixRelative(scanPath, a.dir) < posixRelative(scanPath, b.dir) ? -1 : 1,
    );
}

/**
 * Build the root descriptor with its lock and manifest paths.
 *
 * @param {string} dir Root directory
 * @param {string} scanPath Scan root
 * @returns {{ dir: string, lockFile?: string, manifestFile?: string }}
 */
function rootDescriptor(dir) {
  const lockFile = join(dir, ".terraform.lock.hcl");
  const manifestFile = join(dir, ".terraform", "modules", "modules.json");
  return {
    dir,
    ...(safeExistsSync(lockFile) ? { lockFile } : {}),
    ...(safeExistsSync(manifestFile) ? { manifestFile } : {}),
  };
}

/**
 * Load and merge one directory's configuration files. Only the exact files
 * Terraform itself would load are read (OpenTofu `.tofu` precedence and
 * override ordering included), each through the bounded reader.
 *
 * @param {string} dir Directory to read
 * @param {string} scanReal Realpath of the scan root (read containment)
 * @returns {object} Merged configuration
 */
function loadMergedConfig(dir, scanReal) {
  const names = listDirNames(dir) || [];
  const fileSet = terraformConfigFileSet(names);
  const parsedFiles = [];
  for (const base of [...fileSet.primary, ...fileSet.overrides]) {
    const abs = join(dir, base);
    const text = readFileWithin(abs, scanReal, CONFIG_MAX_BYTES);
    if (text === undefined) {
      continue;
    }
    parsedFiles.push({
      file: base,
      override: fileSet.overrides.includes(base),
      result: parseTerraformConfig(text, { json: base.endsWith(".json") }),
    });
  }
  return mergeTerraformConfigs(parsedFiles);
}

/**
 * Read `.terraform/modules/modules.json` for one root.
 *
 * @param {string} manifestFile Absolute manifest path
 * @param {string} rootDir Root directory
 * @returns {undefined|{ records: object[] }} Manifest records, or undefined when absent/invalid
 */
function readModulesManifest(manifestFile, rootDir) {
  const text = readFileWithin(
    manifestFile,
    join(rootDir, ".terraform"),
    MODULES_JSON_MAX_BYTES,
  );
  if (text === undefined) {
    return undefined;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  const modules = doc?.Modules;
  if (!Array.isArray(modules) || modules.length > MAX_MODULE_RECORDS) {
    return undefined;
  }
  const records = [];
  for (const record of modules) {
    if (!record || typeof record !== "object") {
      continue;
    }
    if (
      typeof record.Key !== "string" ||
      typeof record.Source !== "string" ||
      typeof record.Dir !== "string"
    ) {
      continue;
    }
    records.push({
      key: record.Key,
      source: record.Source,
      ...(typeof record.Version === "string"
        ? { version: record.Version }
        : {}),
      dirRaw: record.Dir,
    });
  }
  return { records };
}

/**
 * Inventory a Terraform workspace: providers from the lock file and
 * `required_providers`, modules from the manifest or the configuration, the
 * dependency graph between them, and offline licenses from the installed
 * packages.
 *
 * @param {string} scanPath Directory to scan
 * @param {Object} options CLI options
 * @param {string} parentRef `bom-ref` of the parent component the CLI built
 * @returns {{ pkgList: object[], dependencies: object[], parentProperties: object[], srcFiles: string[] }}
 */
export function parseTerraformWorkspace(scanPath, options, parentRef) {
  const roots = parentRef ? findTerraformRoots(scanPath, options) : [];
  const state = {
    byRef: new Map(),
    edges: new Map(),
    parentProperties: [],
    srcFiles: [],
    parentRef,
    scanPath,
    scanReal: realpathOf(scanPath),
    // Lexical root for path *resolution* (module sources resolve against the
    // path the caller gave, which may itself sit behind a symlink; the real
    // path is enforced where files are actually read).
    scanLexRoot: resolve(scanPath),
  };
  if (!roots.length) {
    return {
      pkgList: [],
      dependencies: [],
      parentProperties: [],
      srcFiles: [],
    };
  }
  if (DEBUG_MODE) {
    console.log(
      `Found ${roots.length} terraform root(s) at ${scanPath}: ${roots
        .map((root) => posixRelative(scanPath, root.dir))
        .join(", ")}`,
    );
  }
  state.singleRoot = roots.length === 1;
  for (const root of roots) {
    processRoot(state, root);
  }
  const pkgList = [...state.byRef.values()].sort((a, b) =>
    a["bom-ref"] < b["bom-ref"] ? -1 : 1,
  );
  const allRefs = new Set([...state.byRef.keys(), parentRef]);
  const dependencies = [...allRefs].sort().map((ref) => ({
    ref,
    dependsOn: [...(state.edges.get(ref) || new Set())]
      .filter((dep) => dep !== ref && allRefs.has(dep))
      .sort(),
  }));
  return {
    pkgList,
    dependencies,
    parentProperties: state.parentProperties,
    srcFiles: state.srcFiles,
  };
}

/**
 * Process one root directory into components and edges.
 *
 * @param {object} state Accumulator shared across roots
 * @param {{ dir: string, lockFile?: string, manifestFile?: string }} root Root descriptor
 */
function processRoot(state, root) {
  const { scanPath, scanReal, parentRef } = state;
  const rootDir = root.dir;
  const rootRel = posixRelative(scanPath, rootDir) || ".";
  const configCache = new Map();
  const configOf = (dir) => {
    if (!configCache.has(dir)) {
      configCache.set(dir, loadMergedConfig(dir, scanReal));
    }
    return configCache.get(dir);
  };
  const parsedDirs = new Map();
  const parseConfigInto = (dir) => {
    if (!parsedDirs.has(dir)) {
      parsedDirs.set(dir, configOf(dir));
    }
    return parsedDirs.get(dir);
  };

  const rootConfig = parseConfigInto(rootDir);

  // Providers from the lock file, indexed by full address and by
  // namespace/type (the host is not always spelled out in the config).
  const lockProviders = [];
  if (root.lockFile) {
    for (const pkg of parseTerraformLockFile(root.lockFile).pkgList) {
      pkg.evidence = {
        identity: {
          field: "purl",
          confidence: 1,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 1,
              value: posixRelative(scanPath, root.lockFile),
            },
          ],
        },
      };
      lockProviders.push(pkg);
    }
  }
  const lockByAddress = new Map(
    lockProviders
      .map((pkg) => [findProperty(pkg, "cdx:tf:address"), pkg])
      .filter(([address]) => address),
  );
  const lockByNsType = new Map();
  for (const [address, pkg] of lockByAddress) {
    const parts = address.split("/");
    if (parts.length === 3) {
      lockByNsType.set(`${parts[1]}/${parts[2]}`, pkg);
    }
  }
  const ctx = {
    state,
    rootDir,
    rootRel,
    scanLexRoot: state.scanLexRoot,
    terraformDir: join(rootDir, ".terraform"),
    defaultHost: defaultRegistryHostFor(rootDir, lockByAddress),
    lockByAddress,
    lockByNsType,
    unresolved: 0,
    configOf,
  };
  const rootRef = state.singleRoot ? parentRef : `terraform-root:${rootRel}`;
  ctx.rootRef = rootRef;
  ctx.singleRoot = state.singleRoot;

  // Every locked provider is a component up front, with its offline license.
  for (const pkg of lockProviders) {
    applyProviderLicense(ctx, pkg);
    mergeIntoState(state, pkg);
  }

  const manifest = root.manifestFile
    ? readModulesManifest(root.manifestFile, rootDir)
    : undefined;
  const records = [];
  if (manifest) {
    collectManifestRecords(ctx, manifest, records, parseConfigInto);
  } else {
    collectStaticRecords(ctx, records, parseConfigInto, new Set([rootDir]));
  }
  records.sort((a, b) => (a.key < b.key ? -1 : 1));
  const recordByKey = new Map(records.map((record) => [record.key, record]));
  const dirOwner = new Map();
  for (const record of records) {
    if (record.dirValid && record.dirAbs && !dirOwner.has(record.dirAbs)) {
      dirOwner.set(record.dirAbs, record.key);
    }
  }
  if (!dirOwner.has(rootDir)) {
    dirOwner.set(rootDir, "");
  }

  // Pass 1: components for remote records, so owners resolve regardless of
  // the order the manifest listed parents and children in.
  for (const record of records) {
    if (record.remote) {
      record.ref = emitModuleComponent(ctx, record)?.["bom-ref"];
    }
  }
  // Pass 2: module edges. A local record's owner is its parent's owner; a
  // remote record owns itself.
  const moduleRefs = new Map(
    records.filter((r) => r.ref).map((r) => [r.key, r.ref]),
  );
  const ownerRefForKey = (key) => {
    if (!key) {
      return rootRef;
    }
    const record = recordByKey.get(key);
    if (!record || record.remote) {
      return moduleRefs.get(key);
    }
    return ownerRefForKey(record.parentKey);
  };
  for (const record of records) {
    if (!record.remote || !record.ref) {
      continue;
    }
    const owner = ownerRefForKey(record.parentKey);
    addEdge(state, owner, record.ref);
  }

  // Required providers of every parsed directory, including the root's.
  for (const [dir, config] of parsedDirs) {
    const ownerKey = dirOwner.get(dir) ?? "";
    emitProviderEdges(ctx, config, dir, ownerRefForKey(ownerKey));
  }

  // Lock providers nothing in the configuration claims still belong to the
  // root, so the graph stays connected.
  connectOrphanLockProviders(ctx);

  // Root properties land on the parent for a single root, otherwise on the
  // root application component.
  const rootProperties = [
    { name: "cdx:tf:root", value: rootRel },
    ...[...new Set(rootConfig.requiredVersions)].map((value) => ({
      name: "cdx:tf:requiredVersion",
      value,
    })),
  ];
  if (ctx.unresolved > 0) {
    rootProperties.push({
      name: "cdx:tf:unresolvedModuleCalls",
      value: `${ctx.unresolved}`,
    });
  }
  if (ctx.singleRoot) {
    state.parentProperties.push(...rootProperties);
  } else {
    state.byRef.set(rootRef, {
      type: "application",
      name: rootRel === "." ? basename(resolve(scanPath)) : rootRel,
      "bom-ref": rootRef,
      properties: rootProperties,
    });
    addEdge(state, parentRef, rootRef);
  }

  const srcFiles = [];
  if (root.lockFile) {
    srcFiles.push(posixRelative(scanPath, root.lockFile));
  }
  if (root.manifestFile) {
    srcFiles.push(posixRelative(scanPath, root.manifestFile));
  }
  state.srcFiles.push(...(srcFiles.length ? srcFiles : [rootRel]));
}

/**
 * The registry host shorthand resolves against: OpenTofu's registry when the
 * lock file uses it or the directory has `.tofu` files.
 *
 * @param {string} rootDir Root directory
 * @param {Map} lockByAddress Lock providers by full address
 * @returns {string}
 */
function defaultRegistryHostFor(rootDir, lockByAddress) {
  for (const address of lockByAddress.keys()) {
    if (address.startsWith(`${OPENTOFU_REGISTRY_HOST}/`)) {
      return OPENTOFU_REGISTRY_HOST;
    }
  }
  const names = listDirNames(rootDir) || [];
  if (
    names.some((name) => name.endsWith(".tofu") || name.endsWith(".tofu.json"))
  ) {
    return OPENTOFU_REGISTRY_HOST;
  }
  return TERRAFORM_REGISTRY_HOST;
}

/**
 * Collect module records from `modules.json`, plus declared-only calls the
 * manifest does not list.
 *
 * @param {object} ctx Per-root context
 * @param {{ records: object[] }} manifest Parsed manifest
 * @param {object[]} records Output record list
 * @param {Function} parseConfigInto Bounded config loader
 */
function collectManifestRecords(ctx, manifest, records, parseConfigInto) {
  const { rootDir, scanLexRoot, defaultHost } = ctx;
  const modulesDir = join(rootDir, ".terraform", "modules");
  const byKey = new Map();
  for (const entry of manifest.records) {
    byKey.set(entry.key, { entry });
  }
  if (!byKey.has("")) {
    byKey.set("", { entry: { key: "", source: "", dirRaw: "." } });
  }
  // Resolve directories first so declarations can be found afterwards.
  for (const holder of byKey.values()) {
    const entry = holder.entry;
    const isRootRecord = entry.key === "";
    const parsed = entry.source
      ? parseModuleSource(entry.source, { defaultRegistryHost: defaultHost })
      : undefined;
    const local = isRootRecord || parsed?.kind === "local";
    const remote = !local && REMOTE_KINDS.has(parsed?.kind);
    let dirAbs;
    let dirValid = false;
    let packageRoot;
    if (isRootRecord) {
      dirAbs = rootDir;
      dirValid = true;
    } else if (
      entry.dirRaw &&
      !entry.dirRaw.includes("\0") &&
      !isAbsolute(entry.dirRaw)
    ) {
      const target = join(rootDir, ...entry.dirRaw.split("/"));
      if (isInsideDir(local ? scanLexRoot : modulesDir, target)) {
        dirAbs = target;
        dirValid = true;
      }
      if (entry.dirRaw.startsWith(".terraform/modules/")) {
        const first = entry.dirRaw
          .slice(".terraform/modules/".length)
          .split("/")[0];
        if (first) {
          packageRoot = join(modulesDir, first);
        }
      }
    }
    holder.record = {
      key: entry.key,
      parentKey: parentKeyOf(entry.key),
      name: entry.key.split(".").pop(),
      remote,
      parsed: remote ? parsed : undefined,
      version: entry.version,
      installed: true,
      dirAbs,
      dirValid,
      packageRoot,
    };
    records.push(holder.record);
    if (dirValid) {
      parseConfigInto(dirAbs);
    }
  }
  // Declarations live in the merged config of each record's parent.
  for (const record of records) {
    if (!record.remote) {
      continue;
    }
    const parentDir = byKey.get(record.parentKey)?.record?.dirValid
      ? byKey.get(record.parentKey).record.dirAbs
      : undefined;
    if (!parentDir) {
      continue;
    }
    const call = parseConfigInto(parentDir).moduleCalls.find(
      (candidate) => candidate.name === record.name,
    );
    if (call) {
      record.declaration = call;
      record.declarationDir = parentDir;
    }
  }
  // Remote calls the manifest does not list are declared-only components.
  for (const record of [...records]) {
    if (!record.dirValid || !record.dirAbs) {
      continue;
    }
    const ownerKey = manifestOwnerKey(records, record.dirAbs);
    for (const call of parseConfigInto(record.dirAbs).moduleCalls) {
      const expectedKey = ownerKey ? `${ownerKey}.${call.name}` : call.name;
      if (byKey.has(expectedKey)) {
        continue;
      }
      if (!call.source || call.sourceLiteral !== true) {
        continue;
      }
      const parsed = parseModuleSource(call.source, {
        defaultRegistryHost: defaultHost,
      });
      if (!REMOTE_KINDS.has(parsed?.kind)) {
        continue;
      }
      const declared = {
        key: expectedKey,
        parentKey: ownerKey,
        name: call.name,
        remote: true,
        parsed,
        installed: false,
        dirAbs: undefined,
        dirValid: false,
        declaration: call,
        declarationDir: record.dirAbs,
      };
      records.push(declared);
      byKey.set(expectedKey, { entry: declared, record: declared });
    }
  }
}

/**
 * Key of the record that owns a directory, preferring the shortest key so
 * the root record wins ties.
 *
 * @param {object[]} records Records with resolved directories
 * @param {string} dir Directory
 * @returns {string} Owning key ("" for the root)
 */
function manifestOwnerKey(records, dir) {
  let best;
  for (const record of records) {
    if (record.dirValid && record.dirAbs === dir) {
      if (best === undefined || record.key.length < best.length) {
        best = record.key;
      }
    }
  }
  return best || "";
}

/**
 * Walk the configuration statically when no manifest exists. Local module
 * calls are flattened into the calling root, so every edge produced here
 * hangs off the root ref.
 *
 * @param {object} ctx Per-root context
 * @param {object[]} records Output record list
 * @param {Function} parseConfigInto Bounded config loader
 * @param {Set<string>} visited Absolute directories already walked
 */
function collectStaticRecords(ctx, records, parseConfigInto, visited) {
  const { rootDir, scanLexRoot, defaultHost } = ctx;
  const walk = (dir, keyPrefix, depth) => {
    for (const call of parseConfigInto(dir).moduleCalls) {
      if (!call.source || call.sourceLiteral !== true) {
        ctx.unresolved += 1;
        continue;
      }
      const parsed = parseModuleSource(call.source, {
        defaultRegistryHost: defaultHost,
      });
      if (parsed.kind === "local") {
        const target = resolve(dir, parsed.path);
        if (!isInsideDir(scanLexRoot, target)) {
          ctx.unresolved += 1;
          continue;
        }
        if (visited.has(target) || depth >= MAX_LOCAL_DEPTH) {
          continue;
        }
        visited.add(target);
        walk(target, `${keyPrefix}${call.name}.`, depth + 1);
        continue;
      }
      if (!REMOTE_KINDS.has(parsed.kind)) {
        ctx.unresolved += 1;
        continue;
      }
      records.push({
        key: keyPrefix ? `${keyPrefix}${call.name}` : call.name,
        // Local children are flattened into the calling root, so every
        // static-flow module hangs off the root ref.
        parentKey: "",
        name: call.name,
        remote: true,
        parsed,
        installed: false,
        dirAbs: undefined,
        dirValid: false,
        declaration: call,
        declarationDir: dir,
      });
    }
  };
  walk(rootDir, "", 0);
  thoughtLog(
    `Terraform static walk from ${rootDir} produced ${records.length} remote module records.`,
  );
}

/**
 * Turn one remote module record into a component, or count it unresolved.
 *
 * @param {object} ctx Per-root context
 * @param {object} record Module record
 * @returns {object|undefined} The merged component
 */
function emitModuleComponent(ctx, record) {
  const { state } = ctx;
  const { scanPath } = state;
  const parsed = record.parsed;
  const pkg = {
    type: "library",
    scope: "required",
    properties: [
      { name: "cdx:tf:kind", value: "module" },
      { name: "cdx:tf:module:sourceType", value: parsed.kind },
      {
        name: "cdx:tf:module:installed",
        value: record.installed ? "true" : "false",
      },
    ],
  };
  if (parsed.displaySource) {
    pkg.properties.push({
      name: "cdx:tf:module:source",
      value: parsed.displaySource,
    });
  }
  const manifestRel = posixRelative(
    scanPath,
    join(ctx.rootDir, ".terraform", "modules", "modules.json"),
  );
  let identityFile = manifestRel;
  let confidence = 0.6;
  if (parsed.kind === "registry") {
    let version;
    if (record.installed) {
      version = record.version;
      if (version) {
        confidence = 1;
      }
    } else {
      const exact = classifyVersionConstraint(record.declaration?.version);
      version = exact.pinning === "exact" ? exact.version : undefined;
      identityFile = declarationRelPath(scanPath, record) || manifestRel;
    }
    const purl = tryBuildPurl({
      type: "generic",
      namespace: `${parsed.host}/${parsed.namespace}/${parsed.name}`,
      name: parsed.system,
      version: version || null,
      subpath: parsed.subdir || null,
    });
    if (!purl) {
      ctx.unresolved += 1;
      return undefined;
    }
    pkg.group = `${parsed.host}/${parsed.namespace}`;
    pkg.name = `${parsed.name}/${parsed.system}`;
    if (version) {
      pkg.version = version;
    }
    pkg.properties.push(
      { name: "cdx:purl:proposedType", value: "terraform-module" },
      { name: "cdx:tf:address", value: parsed.address },
    );
    applyPurl(pkg, purl, `library:${parsed.address}:${version || ""}`);
  } else if (parsed.kind === "git" || parsed.kind === "hg") {
    const ref = parsed.ref;
    const safeRef = isSafeGitRefName(ref) ? ref : undefined;
    const commit =
      record.installed && record.dirValid
        ? installedCommitFor(ctx, record)
        : undefined;
    const version = safeRef || commit || undefined;
    const coordinates = parsed.url
      ? submodulePurlCoordinates(parsed.url, version)
      : null;
    const purl = coordinates
      ? tryBuildPurl({ ...coordinates, subpath: parsed.subdir || null })
      : null;
    if (!purl) {
      ctx.unresolved += 1;
      return undefined;
    }
    if (coordinates.namespace) {
      pkg.group = coordinates.namespace;
    }
    pkg.name = coordinates.name;
    if (version) {
      pkg.version = version;
    }
    if (safeRef) {
      pkg.properties.push({ name: "cdx:tf:module:ref", value: safeRef });
    }
    if (commit) {
      pkg.properties.push({ name: "cdx:tf:module:commit", value: commit });
    }
    pkg.properties.push({
      name: "cdx:tf:module:pinning",
      value: classifyVcsRef(ref),
    });
    applyPurl(pkg, purl, `library:${parsed.displaySource}:${version || ""}`);
    if (!record.installed) {
      identityFile = declarationRelPath(scanPath, record) || manifestRel;
    } else if (version) {
      confidence = 1;
    }
  } else {
    // Archive module over http/s3/gcs.
    const base = archiveBaseName(parsed.url);
    const host = urlHost(parsed.url);
    const purl =
      base && host
        ? tryBuildPurl({
            type: "generic",
            namespace: host,
            name: base,
            qualifiers: { download_url: parsed.url },
            subpath: parsed.subdir || null,
          })
        : null;
    if (!purl) {
      ctx.unresolved += 1;
      return undefined;
    }
    pkg.group = host;
    pkg.name = base;
    pkg.distribution = { url: parsed.url };
    if (parsed.checksum) {
      pkg.hashes = [
        { alg: parsed.checksum.alg, content: parsed.checksum.content },
      ];
    }
    pkg.properties.push({
      name: "cdx:tf:module:pinning",
      value: parsed.checksum ? "checksum" : "none",
    });
    applyPurl(pkg, purl, `library:${parsed.displaySource}`);
    if (!record.installed) {
      identityFile = declarationRelPath(scanPath, record) || manifestRel;
    }
  }
  if (record.declaration?.version) {
    pkg.properties.push({
      name: "cdx:tf:constraints",
      value: record.declaration.version,
    });
    if (parsed.kind === "registry") {
      pkg.properties.push({
        name: "cdx:tf:module:pinning",
        value: classifyVersionConstraint(record.declaration.version).pinning,
      });
    }
  } else if (parsed.kind === "registry" && record.declaration) {
    // The call was found but sets no version constraint.
    pkg.properties.push({ name: "cdx:tf:module:pinning", value: "none" });
  }
  if (parsed.credentialInSource) {
    pkg.properties.push({
      name: "cdx:tf:module:credentialInSource",
      value: "true",
    });
  }
  const srcFile =
    record.declaration && record.declarationDir
      ? join(record.declarationDir, record.declaration.file)
      : join(ctx.rootDir, ".terraform", "modules", "modules.json");
  pkg.properties.push({ name: "internal:SrcFile", value: srcFile });
  const occurrences = [];
  if (record.declaration && record.declarationDir) {
    const occurrence = {
      location: posixRelative(scanPath, srcFile),
      symbol: `module.${record.name}`,
    };
    if (!record.declaration.file.endsWith(".json") && record.declaration.line) {
      occurrence.line = record.declaration.line;
    }
    occurrences.push(occurrence);
  }
  pkg.evidence = {
    identity: {
      field: "purl",
      confidence,
      methods: [
        {
          technique: "manifest-analysis",
          confidence,
          value: identityFile,
        },
      ],
    },
    ...(occurrences.length ? { occurrences } : {}),
  };
  // Offline license from the installed package.
  if (record.installed && record.dirValid && record.dirAbs) {
    applyModuleLicense(ctx, pkg, record);
  }
  return mergeIntoState(state, pkg);
}

/**
 * Relative POSIX path of a record's declaration file.
 *
 * @param {string} scanPath Scan root
 * @param {object} record Module record
 * @returns {string|undefined}
 */
function declarationRelPath(scanPath, record) {
  if (record.declaration && record.declarationDir) {
    return posixRelative(
      scanPath,
      join(record.declarationDir, record.declaration.file),
    );
  }
  return undefined;
}

/**
 * Read the installed commit of a VCS module package from `.git/HEAD`.
 *
 * @param {object} ctx Per-root context
 * @param {object} record Module record
 * @returns {string|undefined} 40/64-hex commit
 */
function installedCommitFor(ctx, record) {
  if (!record.packageRoot) {
    return undefined;
  }
  const head = readFileWithin(
    join(record.packageRoot, ".git", "HEAD"),
    join(ctx.rootDir, ".terraform"),
    GIT_HEAD_MAX_BYTES,
  );
  if (head === undefined) {
    return undefined;
  }
  const trimmed = head.trim();
  // Never follow `ref:` lines; only a detached sha is usable.
  if (/^[0-9a-f]{40}$/u.test(trimmed) || /^[0-9a-f]{64}$/u.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

/**
 * Strip the archive extension from the last path segment of a URL.
 *
 * @param {string} url Sanitized archive URL
 * @returns {string|undefined} Basename without extension
 */
function archiveBaseName(url) {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (!last) {
      return undefined;
    }
    const lower = last.toLowerCase();
    for (const ext of ARCHIVE_EXTENSIONS) {
      if (lower.endsWith(ext)) {
        return last.slice(0, -ext.length) || undefined;
      }
    }
    return last;
  } catch {
    return undefined;
  }
}

/**
 * Hostname of a sanitized URL.
 *
 * @param {string} url URL
 * @returns {string|undefined}
 */
function urlHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Map one directory's required providers onto provider components and edges.
 *
 * @param {object} ctx Per-root context
 * @param {object} config Merged configuration of the directory
 * @param {string} dir Directory absolute path
 * @param {string} ownerRef Owner bom-ref
 */
function emitProviderEdges(ctx, config, dir, ownerRef) {
  for (const entry of config.requiredProviders || []) {
    let host;
    let namespace;
    let type;
    // A source that spells out its host (`registry.opentofu.org/hashicorp/aws`)
    // names exactly one provider; only shorthand may match a lock entry on
    // another host by namespace/type.
    let explicitHost = false;
    if (entry.source) {
      const parsed = parseProviderSource(entry.source, {
        defaultRegistryHost: ctx.defaultHost,
      });
      if (parsed?.builtin) {
        continue;
      }
      if (parsed) {
        host = parsed.host;
        namespace = parsed.namespace;
        type = parsed.type;
        explicitHost = entry.source.trim().split("/").length === 3;
      }
    }
    if (!type) {
      // Terraform's implied fallback for the legacy and source-less forms.
      host = ctx.defaultHost;
      namespace = "hashicorp";
      type = entry.localName;
    }
    const address = `${host}/${namespace}/${type}`;
    const pkg =
      ctx.lockByAddress.get(address) ||
      (explicitHost
        ? undefined
        : ctx.lockByNsType.get(`${namespace}/${type}`)) ||
      buildConfigOnlyProvider(ctx, host, namespace, type, entry, dir);
    if (!pkg) {
      continue;
    }
    const merged = mergeIntoState(ctx.state, pkg);
    const occurrence = {
      location: posixRelative(ctx.state.scanPath, join(dir, entry.file)),
      symbol: `required_providers.${entry.localName}`,
    };
    if (!entry.file.endsWith(".json") && entry.line) {
      occurrence.line = entry.line;
    }
    addOccurrence(merged, occurrence);
    addEdge(ctx.state, ownerRef, merged["bom-ref"]);
  }
}

/**
 * Build a provider component that only exists in `required_providers`.
 *
 * @param {object} ctx Per-root context
 * @param {string} host Registry host
 * @param {string} namespace Registry namespace
 * @param {string} type Provider type
 * @param {object} entry Merged required_providers entry
 * @param {string} dir Directory the requirement lives in
 * @returns {object|undefined} Component
 */
function buildConfigOnlyProvider(ctx, host, namespace, type, entry, dir) {
  const exact = classifyVersionConstraint(entry.version);
  const version = exact.pinning === "exact" ? exact.version : undefined;
  const address = `${host}/${namespace}/${type}`;
  const purl = tryBuildPurl({
    type: "generic",
    namespace: `${host}/${namespace}`,
    name: type,
    version: version || null,
  });
  if (!purl) {
    return undefined;
  }
  const srcFile = join(dir, entry.file);
  const occurrence = {
    location: posixRelative(ctx.state.scanPath, srcFile),
    symbol: `required_providers.${entry.localName}`,
  };
  if (!entry.file.endsWith(".json") && entry.line) {
    occurrence.line = entry.line;
  }
  const pkg = {
    group: `${host}/${namespace}`,
    name: type,
    ...(version ? { version } : {}),
    type: "library",
    scope: "required",
    properties: [
      { name: "internal:SrcFile", value: srcFile },
      { name: "cdx:purl:proposedType", value: "terraform-provider" },
      { name: "cdx:tf:kind", value: "provider" },
      { name: "cdx:tf:address", value: address },
      ...(entry.version
        ? [{ name: "cdx:tf:constraints", value: entry.version }]
        : []),
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.6,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.6,
            value: posixRelative(ctx.state.scanPath, srcFile),
          },
        ],
      },
      occurrences: [occurrence],
    },
  };
  applyPurl(pkg, purl, `library:${address}:${version || ""}`);
  return pkg;
}

/**
 * Give lock providers nothing in the configuration claims an edge to the
 * root, so the graph stays connected.
 *
 * @param {object} ctx Per-root context
 */
function connectOrphanLockProviders(ctx) {
  const { state, rootRef, lockByAddress } = ctx;
  const seen = new Set([rootRef]);
  const queue = [rootRef];
  while (queue.length) {
    const ref = queue.shift();
    for (const dep of state.edges.get(ref) || []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  // Every locked provider, keyed by full address: two providers that share a
  // namespace/type on different hosts are both components and both need an
  // owner.
  for (const pkg of lockByAddress.values()) {
    if (!seen.has(pkg["bom-ref"])) {
      addEdge(state, rootRef, pkg["bom-ref"]);
    }
  }
}

/**
 * Find and apply the offline license of an installed module package.
 *
 * @param {object} ctx Per-root context
 * @param {object} pkg Component under construction
 * @param {object} record Module record
 */
function applyModuleLicense(ctx, pkg, record) {
  const allowedRoot = join(ctx.rootDir, ".terraform");
  const searchDirs = [];
  if (record.dirAbs) {
    searchDirs.push(record.dirAbs);
  }
  if (record.packageRoot && record.packageRoot !== record.dirAbs) {
    searchDirs.push(record.packageRoot);
  }
  for (const dir of searchDirs) {
    const found = findLicenseInDir(dir, allowedRoot);
    if (found) {
      applyLicense(ctx, pkg, found.file, found.text);
      return;
    }
  }
}

/**
 * Find and apply the offline license of an installed provider.
 *
 * @param {object} ctx Per-root context
 * @param {object} pkg Provider component
 */
function applyProviderLicense(ctx, pkg) {
  if (!pkg.version) {
    return;
  }
  const groupParts = (pkg.group || "").split("/");
  if (groupParts.length !== 2) {
    return;
  }
  const segments = [...groupParts, pkg.name, pkg.version];
  for (const segment of segments) {
    if (
      !segment ||
      segment.length > 255 ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("..") ||
      segment.includes("\0")
    ) {
      return;
    }
  }
  const allowedRoot = join(ctx.rootDir, ".terraform");
  const providerDir = join(ctx.rootDir, ".terraform", "providers", ...segments);
  let entries;
  try {
    entries = readdirSync(providerDir, { withFileTypes: true });
  } catch {
    return;
  }
  const platforms = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.endsWith(".lock") &&
        !entry.isSymbolicLink(),
    )
    .map((entry) => entry.name)
    .sort();
  for (const platform of platforms) {
    const found = findLicenseInDir(join(providerDir, platform), allowedRoot);
    if (found) {
      applyLicense(ctx, pkg, found.file, found.text);
      return;
    }
  }
}

/**
 * Locate a license file in one directory, in the documented name order.
 *
 * @param {string} dir Directory to inspect
 * @param {string} allowedRoot Read containment root
 * @returns {undefined|{ file: string, text: string }} License descriptor
 */
function findLicenseInDir(dir, allowedRoot) {
  const names = listDirNames(dir);
  if (!names) {
    return undefined;
  }
  const lower = new Map(names.map((name) => [name.toLowerCase(), name]));
  for (const candidate of LICENSE_CANDIDATES) {
    const actual = lower.get(candidate.toLowerCase());
    if (!actual) {
      continue;
    }
    const file = join(dir, actual);
    const text = readFileWithin(file, allowedRoot, LICENSE_MAX_BYTES);
    if (text !== undefined) {
      return { file, text };
    }
  }
  return undefined;
}

/**
 * Record an identified license on a component.
 *
 * @param {object} ctx Per-root context
 * @param {object} pkg Component
 * @param {string} file Absolute license path
 * @param {string} text License text
 */
function applyLicense(ctx, pkg, file, text) {
  const rel = posixRelative(ctx.state.scanPath, file);
  const id = licenseIdFromText(text);
  if (id && !pkg.license) {
    pkg.license = id;
    pkg.properties.push({ name: "cdx:tf:licenseSource", value: "file" });
  }
  pkg.properties.push({ name: "cdx:tf:licenseFile", value: rel });
}

/**
 * Merge a component into the workspace state, deduplicating by bom-ref.
 *
 * @param {object} state Workspace accumulator
 * @param {object} pkg Component
 * @returns {object} The merged component
 */
function mergeIntoState(state, pkg) {
  const ref = pkg["bom-ref"];
  const existing = state.byRef.get(ref);
  if (!existing) {
    state.byRef.set(ref, pkg);
    if (!state.edges.has(ref)) {
      state.edges.set(ref, new Set());
    }
    return pkg;
  }
  mergeProperties(existing, pkg.properties || []);
  for (const occurrence of pkg.evidence?.occurrences || []) {
    addOccurrence(existing, occurrence);
  }
  // A component seen again (another root, or the installed copy of a module
  // first seen as declared-only) may carry what the first emission could not
  // read: a license file, more lock digests, a stronger identity. Its
  // `cdx:tf:licenseSource` property is merged above, so the license it names
  // must come along, or the BOM claims a file license it does not carry.
  if (!existing.license && pkg.license) {
    existing.license = pkg.license;
  }
  if (pkg.hashes?.length) {
    const known = new Set(
      (existing.hashes || []).map((hash) => `${hash.alg}:${hash.content}`),
    );
    for (const hash of pkg.hashes) {
      if (!known.has(`${hash.alg}:${hash.content}`)) {
        known.add(`${hash.alg}:${hash.content}`);
        (existing.hashes = existing.hashes || []).push(hash);
      }
    }
  }
  if (!existing.distribution && pkg.distribution) {
    existing.distribution = pkg.distribution;
  }
  const incomingIdentity = pkg.evidence?.identity;
  if (
    incomingIdentity &&
    (incomingIdentity.confidence || 0) >
      (existing.evidence?.identity?.confidence || 0)
  ) {
    existing.evidence = { ...existing.evidence, identity: incomingIdentity };
  }
  return existing;
}

/**
 * Union two property lists by name+value, with `installed=true` replacing
 * `installed=false`.
 *
 * @param {object} existing Component accumulated so far
 * @param {object[]} incoming Properties of the duplicate
 */
function mergeProperties(existing, incoming) {
  const merged = [...(existing.properties || [])];
  for (const prop of incoming) {
    if (prop.name === "cdx:tf:module:installed") {
      const index = merged.findIndex(
        (p) => p.name === "cdx:tf:module:installed",
      );
      if (index === -1) {
        merged.push(prop);
      } else if (merged[index].value !== "true" && prop.value === "true") {
        merged.splice(index, 1, prop);
      }
      continue;
    }
    if (!merged.some((p) => p.name === prop.name && p.value === prop.value)) {
      merged.push(prop);
    }
  }
  existing.properties = merged;
}

/**
 * Add one occurrence, deduplicated and capped.
 *
 * @param {object} pkg Component
 * @param {{ location: string, line?: number, symbol: string }} occurrence
 */
function addOccurrence(pkg, occurrence) {
  pkg.evidence = pkg.evidence || {
    identity: {
      field: "purl",
      confidence: 0.6,
      methods: [{ technique: "manifest-analysis", confidence: 0.6, value: "" }],
    },
  };
  const occurrences = (pkg.evidence.occurrences =
    pkg.evidence.occurrences || []);
  const key = `${occurrence.location}|${occurrence.line || ""}|${occurrence.symbol}`;
  if (
    occurrences.some((o) => `${o.location}|${o.line || ""}|${o.symbol}` === key)
  ) {
    return;
  }
  occurrences.push(occurrence);
  occurrences.sort(compareOccurrences);
  if (occurrences.length > MAX_OCCURRENCES) {
    occurrences.length = MAX_OCCURRENCES;
  }
}

/**
 * Order occurrences by location, then line, then symbol, so the list and the
 * cap applied to it are the same on every run.
 *
 * @param {{ location: string, line?: number, symbol: string }} a
 * @param {{ location: string, line?: number, symbol: string }} b
 * @returns {number}
 */
function compareOccurrences(a, b) {
  if (a.location !== b.location) {
    return a.location < b.location ? -1 : 1;
  }
  const lineDiff = (a.line || 0) - (b.line || 0);
  if (lineDiff) {
    return lineDiff;
  }
  if (a.symbol === b.symbol) {
    return 0;
  }
  return a.symbol < b.symbol ? -1 : 1;
}

/**
 * Add a dependency edge.
 *
 * @param {object} state Workspace accumulator
 * @param {string} from Ref that depends
 * @param {string} to Ref depended on
 */
function addEdge(state, from, to) {
  if (!from || !to || from === to) {
    return;
  }
  if (!state.edges.has(from)) {
    state.edges.set(from, new Set());
  }
  state.edges.get(from).add(to);
}

/**
 * Read a component property.
 *
 * @param {object} pkg Component
 * @param {string} name Property name
 * @returns {string|undefined}
 */
function findProperty(pkg, name) {
  return (pkg.properties || []).find((prop) => prop.name === name)?.value;
}
