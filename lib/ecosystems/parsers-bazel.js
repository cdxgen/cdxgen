import { readFileSync } from "node:fs";

import { npmPurl, tryBuildPurl } from "../inventory/purl.js";

/**
 * Bazel bzlmod dependency extraction.
 *
 * bzlmod (`MODULE.bazel` + `MODULE.bazel.lock`) pulls dependencies from many
 * ecosystems. The whole point of parsing it for an SBOM is to map each
 * resolved dependency onto its true ecosystem purl so vulnerability
 * advisories match — a Maven dependency pulled through bzlmod is a `pkg:maven`
 * package, not a `pkg:bazel` one.
 *
 * Two sources are consulted:
 *
 *   - `MODULE.bazel` (Starlark): the manifest. `bazel_dep(name, version)`
 *     declares Bazel Central Registry modules, which ARE the registered
 *     `bazel` purl type's intended target (flat name, no namespace, default
 *     `repository_url = https://bcr.bazel.build`). Extension calls such as
 *     `maven.artifact(...)` declare dependencies in their native ecosystem.
 *
 *   - `MODULE.bazel.lock` (JSON): the resolved lock. Its structure has changed
 *     across `lockFileVersion`, so this parser reads defensively — a legacy
 *     `modules` array when present, and the modern `moduleExtensions` whose
 *     `generatedRepoSpecs` carry resolved Maven coordinates.
 *
 * `pkg:bazel/...` is used only for BCR modules. Squatting it for a Maven
 * artifact would silently break every vulnerability match.
 */

const BCR_DEFAULT_REPOSITORY_URL = "https://bcr.bazel.build";

/**
 * Module extensions that resolve the build environment rather than the
 * project's dependencies. They dominate a real lock — a `flatbuffers` lock
 * generates 48 repositories from `rules_java`'s `toolchains` extension alone,
 * every one of them a JDK or a Java tools archive — and listing them as
 * components describes the machine that ran the build, not the software being
 * built.
 *
 * Only `toolchains`-suffixed extensions are excluded by name. The
 * `*_configure_extension` families (cc, xcode, sh, apple_cc) also describe the
 * environment, but they generate `local_config_*` repositories with no
 * coordinates, so they drop out on their own — whereas an extension named
 * `internal_configure_extension` is how pybind11 declares a real dependency.
 */
const TOOLCHAIN_EXTENSION = /%(?:[a-z_]*_)?toolchains?$/i;

/**
 * Parse a `MODULE.bazel` manifest and return its BCR modules and ecosystem
 * dependencies. The MODULE.bazel file is Starlark; this extractor finds calls
 * by name and reads their keyword/string arguments using a balanced-paren scan
 * rather than a regex, because MODULE.bazel calls can nest.
 *
 * @param {string} moduleFile Path to `MODULE.bazel`
 * @returns {{ pkgList: object[], parentComponent: object, rootInputs: string[] }}
 */
export function parseModuleBazel(moduleFile) {
  let src;
  try {
    src = readFileSync(moduleFile, "utf-8");
  } catch (error) {
    console.warn(`Failed to parse ${moduleFile}: ${error.message}`);
    return { pkgList: [], parentComponent: {}, rootInputs: [] };
  }

  const pkgList = [];
  const parentComponent = {};

  const moduleName = scalarArg(findFirstCall(src, "module"), "name");
  const moduleVersion = scalarArg(findFirstCall(src, "module"), "version");
  if (moduleName) {
    Object.assign(parentComponent, {
      type: "application",
      name: moduleName,
      ...(moduleVersion ? { version: moduleVersion } : {}),
      description: `Bazel module: ${moduleName}`,
      properties: [{ name: "internal:SrcFile", value: moduleFile }],
    });
  }

  // Overrides replace where a bazel_dep comes from, and Bazel then ignores
  // the version the bazel_dep names.
  // https://bazel.build/external/module#overrides
  const overrides = new Map();
  for (const kind of [
    "local_path_override",
    "git_override",
    "archive_override",
    "single_version_override",
  ]) {
    for (const call of findAllCalls(src, kind)) {
      const moduleName = scalarArg(call, "module_name");
      if (moduleName && !overrides.has(moduleName)) {
        overrides.set(moduleName, {
          kind,
          version: scalarArg(call, "version"),
        });
      }
    }
  }

  for (const call of findAllCalls(src, "bazel_dep")) {
    const name = scalarArg(call, "name");
    let version = scalarArg(call, "version");
    const repoName = scalarArg(call, "repo_name");
    if (!name || !version) continue;
    const override = overrides.get(name);
    // A module taken from a local directory is the project's own tree, not a
    // BCR release, and the version it declares is not what gets built.
    if (override?.kind === "local_path_override") continue;
    if (override?.kind === "single_version_override" && override.version) {
      version = override.version;
    }
    const pkg = buildBcrPackage(
      repoName || name,
      name,
      override?.kind === "git_override" || override?.kind === "archive_override"
        ? null
        : version,
      moduleFile,
    );
    if (override && override.kind !== "single_version_override") {
      pkg.properties.push({
        name: "cdx:bazel:override",
        value: override.kind.replace(/_override$/, ""),
      });
    }
    pkgList.push(pkg);
  }

  for (const call of findAllCalls(src, "maven.artifact")) {
    const pkg = mavenPackageFromCall(call, moduleFile);
    if (pkg) pkgList.push(pkg);
  }
  // rules_jvm_external exposes `maven.artifact`; some projects call it on a
  // locally aliased handle. Catch the common alias shapes too.
  for (const call of findAllCalls(src, "artifact")) {
    if (looksLikeMavenArtifactCall(call)) {
      const pkg = mavenPackageFromCall(call, moduleFile);
      if (pkg) pkgList.push(pkg);
    }
  }

  const rootInputs = pkgList.map((p) => p["bom-ref"]);
  return { pkgList, parentComponent, rootInputs };
}

/**
 * Parse a `MODULE.bazel.lock` for resolved dependencies and the module graph.
 *
 * @param {string} lockFile Path to `MODULE.bazel.lock`
 * @returns {{ pkgList: object[], dependencies: object[] }}
 */
export function parseModuleBazelLock(lockFile) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockFile, "utf-8"));
  } catch (error) {
    console.warn(`Failed to parse ${lockFile}: ${error.message}`);
    return { pkgList: [], dependencies: [] };
  }

  const pkgList = [];
  const dependencies = [];

  // Legacy lockFileVersion (<= ~9) carries a resolved `modules` array.
  if (Array.isArray(lock.modules)) {
    const byKey = new Map();
    for (const mod of lock.modules) {
      const name = mod.name;
      const version = mod.version;
      if (!name || !version) continue;
      const pkg = buildBcrPackage(
        mod.repoName || name,
        name,
        version,
        lockFile,
      );
      pkgList.push(pkg);
      byKey.set(`${name}@${version}`, pkg["bom-ref"]);
    }
    for (const mod of lock.modules) {
      const ref = byKey.get(`${mod.name}@${mod.version}`);
      if (!ref) continue;
      const dependsOn = (mod.deps || [])
        .map((d) => byKey.get(`${d.name}@${d.version}`))
        .filter(Boolean);
      dependencies.push({ ref, dependsOn: [...new Set(dependsOn)].sort() });
    }
  }

  // Module extensions record what each extension resolved. The entries are
  // keyed by the repository name the build sees; the rule that generated them
  // says which ecosystem the dependency belongs to.
  for (const spec of iterateRepoSpecs(lock)) {
    const pkg = packageFromRepoSpec(spec.repoName, spec.spec, lockFile);
    if (pkg) pkgList.push(pkg);
  }

  return { pkgList, dependencies };
}

/**
 * Walk every generated repository spec in a lock, whichever shape the lock
 * uses.
 *
 * A module extension's results are grouped per platform key: `general` when
 * the extension is platform-independent, and an os/arch key otherwise. Reading
 * only `general` would miss every platform-specific dependency, so all groups
 * are walked and duplicates are collapsed by repository name.
 *
 * @param {object} lock Parsed lock file
 * @returns {Array<{repoName: string, spec: object}>} repository specs
 */
function iterateRepoSpecs(lock) {
  const out = [];
  const seen = new Set();
  const extensions = lock?.moduleExtensions;
  if (!extensions || typeof extensions !== "object") {
    return out;
  }
  for (const [extensionId, ext] of Object.entries(extensions)) {
    if (!ext || typeof ext !== "object") continue;
    if (TOOLCHAIN_EXTENSION.test(extensionId)) continue;
    for (const group of Object.values(ext)) {
      const specs = group?.generatedRepoSpecs;
      if (!specs || typeof specs !== "object") continue;
      for (const [repoName, spec] of Object.entries(specs)) {
        if (seen.has(repoName)) continue;
        seen.add(repoName);
        out.push({ repoName, spec });
      }
    }
  }
  return out;
}

/**
 * Name the repository rule that produced a generated repository.
 *
 * Lock format 20 and later name the rule in `repoRuleId`
 * (`@@repo//path:file.bzl%rule_name`); earlier formats split it across
 * `bzlFile` and `ruleClassName`. Both are still in circulation, so both are
 * read.
 *
 * @param {object} spec A generatedRepoSpec value
 * @returns {string} bare rule name, or an empty string
 */
function repoRuleName(spec) {
  const id = `${spec?.repoRuleId || ""}`;
  if (id) {
    return id.split("%").pop();
  }
  return `${spec?.ruleClassName || ""}`;
}

/**
 * Build a component from a generated repository spec, mapping it to the purl
 * type of the ecosystem it actually came from.
 *
 * Only rules whose coordinates are unambiguous produce a component. A
 * repository generated by a toolchain or platform-detection rule describes the
 * build environment rather than a dependency, and is skipped.
 *
 * @param {string} repoName Repository name the build sees
 * @param {object} spec A generatedRepoSpec value
 * @param {string} srcFile Lock file path for evidence
 * @returns {object|null} Package record, or null when the rule carries no dependency
 */
function packageFromRepoSpec(repoName, spec, srcFile) {
  if (!spec || typeof spec !== "object") return null;
  const rule = repoRuleName(spec);
  const attrs = spec.attributes || {};
  if (!rule) return null;

  if (/maven|jvm_import_external/.test(rule)) {
    const parsed = parseMavenCoordinates(attrs.artifact, attrs);
    return parsed
      ? buildMavenPackage(parsed.group, parsed.name, parsed.version, srcFile)
      : null;
  }
  if (rule === "go_repository" && attrs.importpath) {
    // A Go module path is a namespace plus a final segment, and the purl keeps
    // its slashes unescaped, exactly as the Go collectors build it.
    const importPath = `${attrs.importpath}`;
    const slash = importPath.lastIndexOf("/");
    return buildEcosystemPackage(
      {
        type: "golang",
        namespace: slash > -1 ? importPath.slice(0, slash) : null,
        name: slash > -1 ? importPath.slice(slash + 1) : importPath,
        version: attrs.version,
        displayName: importPath,
      },
      { ecosystem: "go", repoName, srcFile, sum: attrs.sum },
    );
  }
  if (rule === "whl_library" || rule === "pypi_file") {
    const parsed = parsePipRequirement(attrs.requirement || attrs.whl_name);
    return parsed
      ? buildEcosystemPackage(
          { type: "pypi", name: parsed.name, version: parsed.version },
          { ecosystem: "pypi", repoName, srcFile, sha256: attrs.sha256 },
        )
      : null;
  }
  if (rule === "npm_import" && attrs.package) {
    // A scoped npm name is a namespace plus a name; npmPurl owns that split.
    const packageName = `${attrs.package}`;
    return buildEcosystemPackage(
      {
        type: "npm",
        purlString: npmPurl(
          packageName,
          attrs.version ? `${attrs.version}` : undefined,
        ),
        name: packageName,
        version: attrs.version,
      },
      { ecosystem: "npm", repoName, srcFile, integrity: attrs.integrity },
    );
  }
  if (rule === "crate_repository" || rule === "cargo_bootstrap_repository") {
    // rules_rust vendors an entire crate universe behind one repository, so
    // the spec names the vendoring rule rather than any single crate. Cargo
    // dependencies are read from the vendored Cargo.lock by the Rust
    // collector instead.
    return null;
  }
  if (rule === "http_archive" || rule === "http_file") {
    return httpArchivePackage(repoName, attrs, srcFile);
  }
  return null;
}

/**
 * Build a component for a dependency fetched by `http_archive`/`http_file`.
 *
 * These carry no ecosystem identity — just a URL and a checksum — so they are
 * `pkg:generic` with a `download_url` qualifier. The version is taken from
 * `strip_prefix` (which conventionally embeds the release, as in
 * `buildtools-8.5.1`) or from a version-shaped segment of the URL.
 *
 * @param {string} repoName Repository name, used as the component name
 * @param {object} attrs Rule attributes
 * @param {string} srcFile Lock file path for evidence
 * @returns {object|null} Package record, or null without a usable URL
 */
function httpArchivePackage(repoName, attrs, srcFile) {
  const urls = Array.isArray(attrs.urls)
    ? attrs.urls
    : attrs.url
      ? [`${attrs.url}`]
      : [];
  const url = urls.find((u) => typeof u === "string" && u.length);
  if (!url) return null;
  const version = archiveVersion(attrs.strip_prefix, url);
  const pkg = buildEcosystemPackage(
    {
      type: "generic",
      name: repoName,
      version,
      qualifiers: { download_url: url },
    },
    { ecosystem: "http_archive", repoName, srcFile, sha256: attrs.sha256 },
  );
  return pkg;
}

/**
 * Derive a version for an archive dependency.
 *
 * @param {string|undefined} stripPrefix `strip_prefix` attribute
 * @param {string} url Download URL
 * @returns {string|undefined} version, or undefined when none is discernible
 */
function archiveVersion(stripPrefix, url) {
  const fromPrefix = `${stripPrefix || ""}`.match(/-(v?\d+(?:\.\d+)*)$/);
  if (fromPrefix) {
    return fromPrefix[1].replace(/^v/, "");
  }
  const cleaned = url
    .split("?")[0]
    .replace(/\.(tar\.gz|tgz|tar\.xz|zip)$/i, "");
  const last = cleaned.split("/").pop() || "";
  const fromUrl = last.match(/^v?(\d+(?:\.\d+)+)$/);
  return fromUrl ? fromUrl[1] : undefined;
}

/**
 * Split a pip requirement (`name==version`) into its parts.
 *
 * @param {string|undefined} requirement Requirement string
 * @returns {{name: string, version: string|undefined}|null}
 */
function parsePipRequirement(requirement) {
  const value = `${requirement || ""}`.trim();
  if (!value) return null;
  const match = value.match(/^([A-Za-z0-9._-]+)\s*==\s*([^\s;]+)/);
  if (match) {
    return { name: match[1], version: match[2] };
  }
  const bare = value.match(/^([A-Za-z0-9._-]+)$/);
  return bare ? { name: bare[1], version: undefined } : null;
}

/**
 * Build a component for a bzlmod dependency that belongs to a known ecosystem.
 *
 * @param {{type: string, name: string, version?: string, namespace?: string, qualifiers?: object}} coords purl coordinates
 * @param {{ecosystem: string, repoName: string, srcFile: string, sha256?: string, integrity?: string, sum?: string}} context Evidence context
 * @returns {object|null} Package record, or null when the purl cannot be built
 */
function buildEcosystemPackage(coords, context) {
  const version = coords.version ? `${coords.version}` : undefined;
  const { displayName, purlString, ...purlParts } = coords;
  // Go purls keep their path separators readable, matching the Go collectors
  // so one module resolves to one bom-ref however it was discovered.
  const purl =
    purlString ||
    tryBuildPurl({ ...purlParts, version })?.replace(
      coords.type === "golang" ? /%2F/g : /$^/,
      "/",
    );
  if (!purl) return null;
  const properties = [
    { name: "internal:SrcFile", value: context.srcFile },
    { name: "cdx:bazel:ecosystem", value: context.ecosystem },
    { name: "cdx:bazel:repo_name", value: context.repoName },
  ];
  const pkg = {
    name: displayName || coords.name,
    ...(version ? { version } : {}),
    type: "library",
    scope: "required",
    ...(coords.namespace ? { group: coords.namespace } : {}),
    purl,
    "bom-ref": decodeURIComponent(purl),
    properties,
    evidence: {
      identity: {
        field: "purl",
        confidence: 1.0,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1.0,
            value: context.srcFile,
          },
        ],
      },
    },
  };
  if (context.sha256 && /^[a-f0-9]{64}$/i.test(`${context.sha256}`)) {
    pkg.hashes = [{ alg: "SHA-256", content: `${context.sha256}` }];
  } else if (context.integrity) {
    // npm records an ssri string (`sha512-<base64>`). `processHashes` turns it
    // into a CycloneDX `hashes[]` entry with the digest hex-encoded.
    pkg._integrity = `${context.integrity}`;
  } else if (context.sum) {
    // A go.sum line is `h1:<base64>`, a SHA-256 dirhash over the module
    // contents. cdxgen carries it in the same `sha256-<base64>` form the Go
    // collectors use, so both paths produce identical hashes for one module.
    pkg._integrity = `${context.sum}`.replace(/^h1:/, "sha256-");
  }
  return pkg;
}

/**
 * Build a component record for a BCR (Bazel Central Registry) module.
 *
 * BCR modules are the registered `bazel` purl type's intended target: a flat
 * module name, no namespace, and the BCR as the default repository.
 *
 * @param {string} displayRepoName Repository name used in the build (for SrcFile context)
 * @param {string} moduleName Canonical module name
 * @param {string} version Resolved version
 * @param {string} srcFile Source file for evidence
 * @returns {object} Package record
 */
function buildBcrPackage(displayRepoName, moduleName, version, srcFile) {
  const purl = tryBuildPurl({
    type: "bazel",
    name: moduleName,
    version,
    qualifiers: { repository_url: BCR_DEFAULT_REPOSITORY_URL },
  });
  return {
    name: moduleName,
    ...(version ? { version } : {}),
    type: "library",
    scope: "required",
    purl,
    "bom-ref": decodeURIComponent(purl),
    properties: [
      { name: "internal:SrcFile", value: srcFile },
      { name: "cdx:bazel:module", value: moduleName },
      { name: "cdx:bazel:repository_url", value: BCR_DEFAULT_REPOSITORY_URL },
      ...(displayRepoName !== moduleName
        ? [{ name: "cdx:bazel:repo_name", value: displayRepoName }]
        : []),
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1.0,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1.0,
            value: srcFile,
          },
        ],
      },
    },
  };
}

/**
 * Build a Maven package from a Starlark `maven.artifact(...)` call.
 *
 * rules_jvm_external accepts either a coordinate string
 * (`"group:artifact:version"`) or separate `group`/`artifact`/`version`
 * keyword arguments.
 *
 * @param {Map<string, string|string[]>} call Parsed call arguments
 * @param {string} srcFile Source file for evidence
 * @returns {object|null} Package record, or null when no coordinates parse
 */
function mavenPackageFromCall(call, srcFile) {
  const parsed = parseMavenCoordinates(
    scalarArg(call, "artifact") ||
      scalarArg(call, "coord") ||
      scalarArg(call, "coordinates") ||
      scalarArg(call, ""),
    call,
  );
  if (!parsed) return null;
  return buildMavenPackage(parsed.group, parsed.name, parsed.version, srcFile);
}

/**
 * Parse Maven coordinates from a coordinate string or a set of attributes.
 *
 * @param {string|undefined} coordStr A `group:artifact:version` string
 * @param {object|Map} attrs Attribute map with group/artifact/version keys
 * @returns {{group: string, name: string, version: string}|null}
 */
function parseMavenCoordinates(coordStr, attrs) {
  if (coordStr && typeof coordStr === "string") {
    const parts = coordStr.split(":");
    if (parts.length >= 3) {
      return { group: parts[0], name: parts[1], version: parts[2] };
    }
  }
  const group = scalarArg(attrs, "group");
  const name = scalarArg(attrs, "artifact") || scalarArg(attrs, "name");
  const version = scalarArg(attrs, "version");
  if (group && name && version) {
    return { group, name, version };
  }
  return null;
}

/**
 * Construct a Maven package record. Maven purls require a group (namespace).
 *
 * @param {string} group Group ID
 * @param {string} name Artifact ID
 * @param {string} version Version
 * @param {string} srcFile Source file for evidence
 * @returns {object} Package record
 */
function buildMavenPackage(group, name, version, srcFile) {
  const purl = tryBuildPurl({
    type: "maven",
    namespace: group,
    name,
    version,
  });
  const pkg = {
    name,
    version,
    type: "library",
    scope: "required",
    group,
    properties: [
      { name: "internal:SrcFile", value: srcFile },
      { name: "cdx:bazel:ecosystem", value: "maven" },
    ],
  };
  if (purl) {
    pkg.purl = purl;
    pkg["bom-ref"] = decodeURIComponent(purl);
  } else {
    pkg["bom-ref"] = `library:${group}:${name}:${version}`;
  }
  return pkg;
}

/**
 * Heuristic: does an `artifact(...)` call look like a Maven artifact
 * declaration? Used to avoid treating unrelated `artifact` calls (e.g. test
 * fixtures) as Maven coordinates. A Maven coordinate string has at least two
 * colons; separate group/artifact/version args are a stronger signal.
 *
 * @param {Map<string, string|string[]>} call Parsed call arguments
 * @returns {boolean}
 */
function looksLikeMavenArtifactCall(call) {
  const coord =
    scalarArg(call, "artifact") ||
    scalarArg(call, "coord") ||
    scalarArg(call, "coordinates");
  if (coord && coord.split(":").length >= 3) {
    return true;
  }
  return !!(
    scalarArg(call, "group") &&
    (scalarArg(call, "artifact") || scalarArg(call, "name")) &&
    scalarArg(call, "version")
  );
}

// ---------------------------------------------------------------------------
// Starlark call extraction
// ---------------------------------------------------------------------------

/**
 * Find every top-level call to `name(...)` in Starlark source and return the
 * parsed keyword/string arguments of each. Scanning uses a balanced-paren
 * counter rather than a regex, because MODULE.bazel calls can nest other calls
 * inside their argument lists.
 *
 * @param {string} src Starlark source
 * @param {string} name Function name to match (dotted names supported)
 * @returns {Array<Map<string, string|string[]>>} one argument map per call
 */
export function findAllCalls(src, name) {
  const calls = [];
  let i = 0;
  while (i < src.length) {
    const hit = src.indexOf(name, i);
    if (hit === -1) break;
    // Ensure the match is a whole token, not a suffix of a longer identifier.
    const before = hit > 0 ? src[hit - 1] : "";
    if (/[A-Za-z0-9_.]/.test(before)) {
      i = hit + 1;
      continue;
    }
    let j = hit + name.length;
    while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
    if (src[j] !== "(") {
      i = hit + 1;
      continue;
    }
    const close = matchingParen(src, j);
    if (close === -1) break;
    const argSrc = src.substring(j + 1, close);
    calls.push(parseCallArgs(argSrc));
    i = close + 1;
  }
  return calls;
}

/**
 * Find the first call to `name(...)` and return its arguments, or null.
 *
 * @param {string} src Starlark source
 * @param {string} name Function name
 * @returns {Map<string, string|string[]>|null}
 */
function findFirstCall(src, name) {
  return findAllCalls(src, name)[0] || null;
}

/**
 * Return the index of the closing paren that matches the opening paren at
 * `open`, skipping string literals. Returns -1 if unbalanced.
 *
 * @param {string} src Source
 * @param {number} open Index of the opening `(`
 * @returns {number} index of the matching `)`, or -1
 */
function matchingParen(src, open) {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = skipString(src, i);
      continue;
    }
    if (c === "#") {
      // Line comment; skip to end of line.
      i = src.indexOf("\n", i);
      if (i === -1) return -1;
      i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Advance past a string literal starting at `start` (the opening quote),
 * respecting backslash escapes. Returns the index after the closing quote.
 *
 * @param {string} src Source
 * @param {number} start Index of the opening quote
 * @returns {number} index after the closing quote
 */
function skipString(src, start) {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === quote) {
      return i + 1;
    }
    i++;
  }
  return i;
}

/**
 * Parse the argument list of a Starlark call into a map of keyword arguments.
 *
 * Handles `key = "value"`, `key = [list, of, values]`, bare positional string
 * arguments (collected under the special `""` key), and nested calls (the
 * value is captured as the raw source span). Only the constructs that appear
 * in MODULE.bazel are supported.
 *
 * @param {string} argSrc Source inside the call's parentheses
 * @returns {Map<string, string|string[]>} parsed arguments
 */
function parseCallArgs(argSrc) {
  const args = new Map();
  let i = 0;
  while (i < argSrc.length) {
    i = skipSpaceAndComments(argSrc, i);
    if (i >= argSrc.length || argSrc[i] === ",") {
      i++;
      continue;
    }
    // Read a key (identifier) when followed by '='.
    let key = "";
    while (i < argSrc.length && /[A-Za-z0-9_.]/.test(argSrc[i])) {
      key += argSrc[i];
      i++;
    }
    const afterKey = skipSpaceAndComments(argSrc, i);
    if (key && argSrc[afterKey] === "=") {
      i = skipSpaceAndComments(argSrc, afterKey + 1);
      const { value, end } = readValue(argSrc, i);
      args.set(key, value);
      i = end;
    } else {
      // Positional argument; capture as a bare value under "".
      const { value, end } = readValue(argSrc, key ? i - key.length : i);
      const existing = args.get("");
      const next = value;
      args.set(
        "",
        Array.isArray(existing)
          ? [...existing, next]
          : existing !== undefined
            ? [existing, next]
            : next,
      );
      i = end;
    }
  }
  return args;
}

/**
 * Read a single Starlark value (string, list, or nested call span) starting at
 * `start`, returning the decoded value and the index past it.
 *
 * @param {string} src Source
 * @param {number} start Start index
 * @returns {{value: string|string[], end: number}}
 */
function readValue(src, start) {
  const i = skipSpaceAndComments(src, start);
  const c = src[i];
  if (c === '"' || c === "'") {
    const end = skipString(src, i);
    return { value: unquote(src.substring(i, end)), end };
  }
  if (c === "[") {
    return readList(src, i);
  }
  // A nested call or bare token: read until a top-level comma or closing paren.
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '"' || ch === "'") {
      j = skipString(src, j);
      continue;
    }
    if (ch === "[" || ch === "(") {
      depth++;
    } else if (ch === "]" || ch === ")") {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) {
      break;
    }
    j++;
  }
  return { value: src.substring(i, j).trim(), end: j };
}

/**
 * Read a Starlark list literal, returning its string elements.
 *
 * @param {string} src Source
 * @param {number} start Index of the opening `[`
 * @returns {{value: string[], end: number}}
 */
function readList(src, start) {
  const items = [];
  let i = start + 1;
  while (i < src.length && src[i] !== "]") {
    i = skipSpaceAndComments(src, i);
    if (src[i] === ",") {
      i++;
      continue;
    }
    if (src[i] === "]") break;
    const { value, end } = readValue(src, i);
    if (typeof value === "string" && value) {
      items.push(value);
    } else if (Array.isArray(value)) {
      items.push(...value);
    }
    i = end;
  }
  return { value: items, end: i < src.length ? i + 1 : i };
}

/**
 * Skip whitespace and Starlark line comments, returning the next significant
 * index.
 *
 * @param {string} src Source
 * @param {number} i Current index
 * @returns {number} next significant index
 */
function skipSpaceAndComments(src, i) {
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
    } else if (c === "#") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
    } else if (c === "\\" && src[i + 1] === "\n") {
      // Line continuation.
      i += 2;
    } else {
      return i;
    }
  }
  return i;
}

/**
 * Remove surrounding quotes and resolve backslash escapes from a string token.
 *
 * @param {string} token A quoted string token including the quotes
 * @returns {string} the decoded string value
 */
function unquote(token) {
  if (!token) return "";
  const quote = token[0];
  if (quote !== '"' && quote !== "'") return token;
  const inner = token.slice(1, -1);
  return inner.replace(/\\(.)/g, (_m, ch) =>
    ch === "n" ? "\n" : ch === "t" ? "\t" : ch,
  );
}

/**
 * Extract a scalar string value for a key from a parsed call argument map,
 * accepting either a plain object or a Map (so the same helper works for
 * Starlark call args and lock attribute objects).
 *
 * @param {Map|object} call Parsed arguments
 * @param {string} key Argument name
 * @returns {string|undefined}
 */
function scalarArg(call, key) {
  if (!call) return undefined;
  let v;
  if (typeof call.get === "function") {
    v = call.get(key);
  } else {
    v = call[key];
  }
  if (v == null) return undefined;
  if (Array.isArray(v)) return `${v[0]}`;
  return `${v}`;
}
