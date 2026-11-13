import { Buffer } from "node:buffer";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { Purl } from "@cdxgen/cdx-purl";
import { compare as compareSemver } from "semver";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { compareCodeUnits } from "../core/compare.js";
import { shouldFetchLicense, shouldFetchVCS } from "../core/env.js";
import {
  applyPurl,
  canonicalPurlFromLooseString,
  tryBuildPurl,
  tryParsePurl,
} from "../inventory/purl.js";
import { guessLicenseIds, isSpdxLicenseExpression } from "../inventory/spdx.js";
import {
  getGoPkgLicense,
  getGoPkgVCSUrl,
  prefetchGoPkgMetadata,
} from "./ecosystems.js";

/**
 * Method to encode hex string to base64 string
 *
 * @param {string} hexString hex string
 * @returns {string} base64 encoded string
 */
function toBase64(hexString) {
  return Buffer.from(hexString, "hex").toString("base64");
}

/**
 * The root of the Go module cache on this machine.
 *
 * @returns {string|undefined} `$GOMODCACHE`, or `$GOPATH/pkg/mod`, or the
 *   default `~/go/pkg/mod`.
 */
function goModuleCacheDir() {
  const gomodcache = readEnvironmentVariable("GOMODCACHE");
  if (gomodcache) {
    return gomodcache;
  }
  const gopath = readEnvironmentVariable("GOPATH");
  if (gopath) {
    return join(gopath.split(delimiter)[0], "pkg", "mod");
  }
  return join(homedir(), "go", "pkg", "mod");
}

/**
 * Escape a module path or version the way Go's module cache directory names
 * do (module.EscapePath and module.EscapeVersion): every upper-case letter
 * becomes `!` followed by the lower-case one, so the cache stays
 * case-preserving on case-insensitive file systems (`github.com/Azure` is
 * stored as `github.com/!azure`, and `v2.10.17-RC.1` as `v2.10.17-!r!c.1`).
 *
 * @param {string} value Module path or version
 * @returns {string} The escaped value
 */
function escapeGoCacheName(value) {
  let escaped = "";
  for (const ch of value) {
    if (ch >= "A" && ch <= "Z") {
      escaped += `!${ch.toLowerCase()}`;
    } else {
      escaped += ch;
    }
  }
  return escaped;
}

// Path elements Windows reserves, which Go rejects in every module path.
const GO_WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ..."123456789".split("").flatMap((n) => [`COM${n}`, `LPT${n}`]),
]);
// ASCII punctuation a file name element may hold, after module.fileNameOK.
const GO_FILE_NAME_PUNCTUATION = "!#$%&()+,-.=@[]^_{}~ ";

/**
 * Whether one character may appear in a path element of the given kind, as
 * module.modPathOK, module.importPathOK and module.fileNameOK decide.
 *
 * @param {string} ch One character
 * @param {"module"|"import"|"file"} kind What the element belongs to
 * @returns {boolean}
 */
function isGoPathCharOK(ch, kind) {
  if (/[A-Za-z0-9]/.test(ch)) {
    return true;
  }
  if (kind === "file") {
    return (
      GO_FILE_NAME_PUNCTUATION.includes(ch) ||
      (ch.charCodeAt(0) >= 0x80 && /\p{L}/u.test(ch))
    );
  }
  return "-._~".includes(ch) || (kind === "import" && ch === "+");
}

/**
 * Whether a path element is one the Go toolchain accepts, as module.checkElem
 * decides. No accepted element is `.` or `..`, or holds a path separator, so a
 * name that passes cannot leave the directory it is joined to.
 *
 * @param {string} elem Path element
 * @param {"module"|"import"|"file"} kind What the element belongs to
 * @returns {boolean}
 */
function isGoPathElementOK(elem, kind) {
  if (!elem || /^\.+$/.test(elem) || elem.endsWith(".")) {
    return false;
  }
  if (kind === "module" && elem.startsWith(".")) {
    return false;
  }
  for (const ch of elem) {
    if (!isGoPathCharOK(ch, kind)) {
      return false;
    }
  }
  const dot = elem.indexOf(".");
  const short = dot < 0 ? elem : elem.slice(0, dot);
  if (GO_WINDOWS_RESERVED_NAMES.has(short.toUpperCase())) {
    return false;
  }
  if (kind === "file") {
    return true;
  }
  // Names that look like Windows short names, such as PROGRA~1.
  const tilde = short.lastIndexOf("~");
  return !(tilde >= 0 && /^\d+$/.test(short.slice(tilde + 1)));
}

/**
 * Whether a slash-separated path is one the Go toolchain accepts, as
 * module.checkPath decides.
 *
 * @param {string} path Module or import path
 * @param {"module"|"import"} kind What the path is
 * @returns {boolean}
 */
function isGoPathOK(path, kind) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("-") &&
    path.split("/").every((elem) => isGoPathElementOK(elem, kind))
  );
}

/**
 * Whether a module path passes module.CheckPath: a valid path whose first
 * element is a lower-case host name with a dot in it. Go writes no module
 * cache directory for any other path.
 *
 * @param {string} path Module path
 * @returns {boolean}
 */
function isValidGoModulePath(path) {
  if (!isGoPathOK(path, "module")) {
    return false;
  }
  const host = path.split("/")[0];
  return host.includes(".") && /^[a-z0-9.-]+$/.test(host);
}

/**
 * Whether a version passes module.EscapeVersion: a single valid file name
 * element without `!`.
 *
 * @param {string} version Module version
 * @returns {boolean}
 */
function isValidGoVersion(version) {
  return (
    typeof version === "string" &&
    !version.includes("!") &&
    isGoPathElementOK(version, "file")
  );
}

// The licence notice file names pkg.go.dev reads, compared without regard to
// case (golang/pkgsite internal/licenses FileNames).
const GO_LICENSE_FILE_NAMES = new Set(
  [
    "COPYING",
    "COPYING.md",
    "COPYING.markdown",
    "COPYING.txt",
    "COPYING.LESSER",
    "COPYING.LESSER.md",
    "COPYING.LESSER.markdown",
    "COPYING.LESSER.txt",
    "LICENCE",
    "LICENCE.md",
    "LICENCE.markdown",
    "LICENCE.txt",
    "LICENSE",
    "LICENSE.md",
    "LICENSE.markdown",
    "LICENSE.txt",
    "LICENSE-2.0.txt",
    "LICENCE-2.0.txt",
    "LICENSE-APACHE",
    "LICENCE-APACHE",
    "LICENSE-APACHE-2.0.txt",
    "LICENCE-APACHE-2.0.txt",
    "LICENSE-MIT",
    "LICENCE-MIT",
    "LICENSE.MIT",
    "LICENCE.MIT",
    "LICENSE.code",
    "LICENCE.code",
    "LICENSE.docs",
    "LICENCE.docs",
    "LICENSE.rst",
    "LICENCE.rst",
    "MIT-LICENSE",
    "MIT-LICENCE",
    "MIT-LICENSE.md",
    "MIT-LICENCE.md",
    "MIT-LICENSE.markdown",
    "MIT-LICENCE.markdown",
    "MIT-LICENSE.txt",
    "MIT-LICENCE.txt",
    "MIT_LICENSE",
    "MIT_LICENCE",
    "UNLICENSE",
    "UNLICENCE",
  ].map((f) => f.toLowerCase()),
);

/**
 * Whether a file name is one of the licence notices pkg.go.dev reads, whose
 * text describes the module's licence without a registry round.
 *
 * @param {string} fileName Candidate file name
 * @returns {boolean}
 */
function isGoLicenseFileName(fileName) {
  return GO_LICENSE_FILE_NAMES.has(fileName.toLowerCase());
}

/**
 * The licence notices of a module that is already on this machine, from the
 * directory `go list` reported, from the project's `vendor/` tree, or from the
 * module cache. Reading them costs no network round trip, so they answer
 * before pkg.go.dev is asked. Every notice of the first directory holding
 * one is returned, as pkg.go.dev reads every notice of a module.
 *
 * The directory `go list` reported is always read. The vendor tree and the
 * module cache stand in for pkg.go.dev, so they are read only when licences
 * are being fetched. Their directories are built from a module path and
 * version read from modules.txt or go.sum, so a path or version the Go
 * toolchain would reject, such as one with a `..` element, is not looked up:
 * Go never writes such a directory, and joining it could leave the tree.
 *
 * @param {string} name Full module path
 * @param {string} [version] Module version, for the module cache layout
 * @param {Object} [options] Options
 * @param {string} [options.dir] The module's directory, as `go list` reports it
 * @param {string} [options.projectRoot] Project root holding a `vendor/` tree
 * @param {string} [options.vendorPath] The path the module is vendored under,
 *   when it differs from `name`: Go vendors a replaced module under the path
 *   it replaces
 * @param {Map<string, Object>} [options.noticeDirs] The directories whose
 *   notices this scan has read, by real path, with the module each was read
 *   for. Replace directives and vendored links can lead any number of modules
 *   to one directory; only the first module gets its notices as they are, and
 *   the others get them marked `shared`, so their text is embedded once
 * @returns {{fileName: string, text: string, shared?: boolean}[]} The
 *   notices, in file name order; empty when none is held locally
 */
export function readLocalGoLicenses(name, version, options = {}) {
  if (!name) {
    return [];
  }
  const candidateDirs = [];
  if (options.dir) {
    candidateDirs.push(options.dir);
  }
  const fetchingLicenses = shouldFetchLicense();
  const vendorPath = options.vendorPath || name;
  if (
    fetchingLicenses &&
    options.projectRoot &&
    isGoPathOK(vendorPath, "import")
  ) {
    candidateDirs.push(
      join(options.projectRoot, "vendor", ...vendorPath.split("/")),
    );
  }
  if (
    fetchingLicenses &&
    version &&
    isValidGoModulePath(name) &&
    isValidGoVersion(version)
  ) {
    const cacheRoot = goModuleCacheDir();
    if (cacheRoot) {
      candidateDirs.push(
        join(
          cacheRoot,
          `${escapeGoCacheName(name)}@${escapeGoCacheName(version)}`,
        ),
      );
    }
  }
  const owner = `${name}@${version || ""}`;
  for (const dir of candidateDirs) {
    const notices = options.noticeDirs
      ? readClaimedGoNotices(dir, owner, options.noticeDirs)
      : readGoNotices(dir);
    if (notices.length) {
      return notices;
    }
  }
  return [];
}

/**
 * The licence notices in one directory.
 *
 * @param {string} dir Directory to read
 * @returns {{fileName: string, text: string}[]} The notices, in file name
 *   order; empty when there is none or the directory cannot be read
 */
function readGoNotices(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  // Only regular files: a module zip holds no links, so a link named like
  // a notice did not come from the module.
  const fileNames = entries
    .filter((e) => e.isFile() && isGoLicenseFileName(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const notices = [];
  for (const fileName of fileNames) {
    try {
      const text = readFileSync(join(dir, fileName), {
        encoding: "utf-8",
      });
      if (text?.length) {
        notices.push({ fileName, text });
      }
    } catch {
      // An unreadable notice is the same as none.
    }
  }
  return notices;
}

/**
 * The licence notices in one directory, read once per scan. The directory is
 * known by its real path, so links and `..` steps that lead to it share the
 * reading. A module other than the one the directory was first read for gets
 * the notices marked `shared`.
 *
 * @param {string} dir Directory to read
 * @param {string} owner `name@version` of the module asking
 * @param {Map<string, Object>} noticeDirs The directories read in this scan
 * @returns {{fileName: string, text: string, shared?: boolean}[]} The notices
 */
function readClaimedGoNotices(dir, owner, noticeDirs) {
  let realDir;
  try {
    realDir = realpathSync(dir);
  } catch {
    return [];
  }
  let claimed = noticeDirs.get(realDir);
  if (!claimed) {
    claimed = { owner, notices: readGoNotices(dir) };
    noticeDirs.set(realDir, claimed);
  }
  if (claimed.owner === owner || !claimed.notices.length) {
    return claimed.notices;
  }
  claimed.shared ??= claimed.notices.map(({ fileName, text }) => ({
    fileName,
    text,
    shared: true,
  }));
  return claimed.shared;
}

/**
 * The text of the first licence notice {@link readLocalGoLicenses} finds.
 *
 * @param {string} name Full module path
 * @param {string} [version] Module version, for the module cache layout
 * @param {Object} [options] The options {@link readLocalGoLicenses} takes
 * @returns {string|undefined} The notice text, or undefined when none is held
 *   locally
 */
export function readLocalGoLicense(name, version, options = {}) {
  return readLocalGoLicenses(name, version, options)[0]?.text;
}

/**
 * Whether a registry can hold this module: a module path and version the Go
 * toolchain accepts. Any other module was never published, and its path in a
 * pkg.go.dev URL could resolve to a different module (`../x` would ask for
 * `x`).
 *
 * @param {string} name Full module path
 * @param {string} [version] Module version
 * @returns {boolean}
 */
function isGoRegistryModule(name, version) {
  return isValidGoModulePath(name) && (!version || isValidGoVersion(version));
}

/**
 * The modules the pkg.go.dev batch asks about, each marked when its licence
 * notice is held on this machine, so the batch skips its licence tab but
 * still fetches its module page for the repository URL. A module no registry
 * holds (the main module, local code, or a path Go rejects) is left out, as
 * getGoPkgComponent never looks it up.
 *
 * @param {Object[]} modules Modules with `name`, `version`,
 *   `skipRegistryLookups` and the options {@link readLocalGoLicenses} takes
 * @returns {Object[]} Copies of the modules to ask about, with
 *   `licenseKnown` set
 */
function goModulesToPrefetch(modules) {
  return modules
    .filter(
      (m) => !m.skipRegistryLookups && isGoRegistryModule(m.name, m.version),
    )
    .map((m) => ({
      ...m,
      licenseKnown: readLocalGoLicenses(m.name, m.version, m).length > 0,
    }));
}

// The licences each notice grants, worked out once for a notice that several
// modules share.
const goNoticeLicenseIds = new WeakMap();

/**
 * The CycloneDX licences of notices read from disk. Every licence each notice
 * grants is listed with the notice as its text, and a notice that names none
 * is a CUSTOM licence. A `shared` notice, whose text another module of the
 * scan already carries, gives its licences without the text. A licence with
 * an exception is an SPDX expression, which CycloneDX only carries as the
 * sole entry, so then every licence found is joined into one expression.
 *
 * @param {{text: string, shared?: boolean}[]} notices Notices read by
 *   {@link readLocalGoLicenses}
 * @returns {Object[]} CycloneDX licence choices
 */
function localGoLicenses(notices) {
  const licenses = [];
  const ids = [];
  for (const notice of notices) {
    const text = { contentType: "text/plain", content: notice.text };
    const license = (fields) =>
      notice.shared ? { license: fields } : { license: { ...fields, text } };
    let noticeIds = goNoticeLicenseIds.get(notice);
    if (!noticeIds) {
      noticeIds = guessLicenseIds(notice.text);
      goNoticeLicenseIds.set(notice, noticeIds);
    }
    if (!noticeIds.length) {
      licenses.push(license({ name: "CUSTOM" }));
      continue;
    }
    for (const id of noticeIds) {
      if (ids.includes(id)) {
        continue;
      }
      ids.push(id);
      licenses.push(license({ id }));
    }
  }
  if (ids.some((id) => isSpdxLicenseExpression(id))) {
    return [
      {
        expression: ids
          .map((id) => (ids.length > 1 && id.includes(" ") ? `(${id})` : id))
          .join(" AND "),
      },
    ];
  }
  return licenses;
}

/**
 * What a replace directive makes of one module, in the shape every Go parser
 * reports it. The Go toolchain builds the replacement, so a module replacement
 * is reported under the replacement's path and version, as govulncheck and
 * syft report it. A directory replacement is local code that no registry
 * holds: it keeps the module path it replaces and has no version, so its purl
 * names no registry release.
 *
 * @param {string} path The module path being replaced
 * @param {string} [version] The version being replaced, absent for a
 *   replacement of every version
 * @param {string} newPath The replacement module path or directory
 * @param {string} [newVersion] The replacement version, absent (or `(devel)`
 *   in build info) for a directory
 * @returns {Object|undefined} `name` and `version` to report, `local` for a
 *   directory, `localDir` the directory as written, and `replaces` the
 *   `path@version` it stands in for
 */
function goReplacement(path, version, newPath, newVersion) {
  if (!path || !newPath) {
    return undefined;
  }
  const replaces = version ? `${path}@${version}` : path;
  if (!newVersion || newVersion === "(devel)") {
    return {
      name: path,
      version: undefined,
      local: true,
      localDir: newPath,
      replaces,
    };
  }
  return { name: newPath, version: newVersion, local: false, replaces };
}

/**
 * Record on a component the module a replace directive put it in place of.
 *
 * @param {Object} component Component built for the replacement
 * @param {Object} [replacement] Result of {@link goReplacement}
 * @returns {Object} The same component
 */
function addGoReplacementProperties(component, replacement) {
  if (!replacement) {
    return component;
  }
  component.properties = component.properties || [];
  component.properties.push({
    name: "cdx:go:replaces",
    value: replacement.replaces,
  });
  if (replacement.localDir) {
    component.properties.push({
      name: "cdx:go:local_dir",
      value: replacement.localDir,
    });
  }
  return component;
}

/**
 * Order two Go module versions by semantic version precedence, as Go's semver
 * package does: a pre-release, pseudo-versions included, sorts before its
 * release, and build metadata such as `+incompatible` does not count.
 *
 * @param {string} a A module version
 * @param {string} b Another module version
 * @returns {number} Negative, zero or positive as `a` sorts before, with or
 *   after `b`
 */
export function compareGoVersions(a, b) {
  try {
    return compareSemver(a, b);
  } catch {
    return compareCodeUnits(a, b);
  }
}

/**
 * Convert a Go checksum (`h1:` followed by the base64 SHA-256) to the
 * integrity string components carry.
 *
 * @param {string} [sum] Go checksum
 * @returns {string|undefined} `sha256-…`, or undefined without a checksum
 */
function goSumIntegrity(sum) {
  return sum?.startsWith("h1:") ? `sha256-${sum.slice(3)}` : undefined;
}

/**
 * Builds a Go package component object containing purl, bom-ref, integrity hash,
 * and optionally license and VCS external reference information.
 *
 * @param {string} group Package group (module path prefix, may be empty)
 * @param {string} name Package name (full module path when group is empty)
 * @param {string} version Package version string
 * @param {string} hash Integrity hash (e.g. "sha256-…"), used as _integrity
 * @param {Object} [options] Options
 * @param {boolean} [options.skipRegistryLookups] Leave the licence and VCS
 *   URL unset instead of asking pkg.go.dev. Used for the main module, which
 *   no registry holds.
 * @param {string} [options.dir] The module's directory, as `go list` reports
 *   it, where a local licence notice is read first
 * @param {string} [options.projectRoot] Project root holding a `vendor/` tree
 *   the module may be vendored in
 * @param {string} [options.vendorPath] The path the module is vendored under,
 *   when it differs from `name`
 * @returns {Promise<Object>} Component object ready for inclusion in a BOM package list
 */
export async function getGoPkgComponent(
  group,
  name,
  version,
  hash,
  options = {},
) {
  let license;
  let licenses;
  const registryLookups =
    !options.skipRegistryLookups &&
    isGoRegistryModule(group ? `${group}/${name}` : name, version);
  // Notices held on this machine answer before pkg.go.dev is asked, and the
  // registry is consulted only when there is none.
  const notices = readLocalGoLicenses(name, version, options);
  if (notices.length) {
    licenses = localGoLicenses(notices);
  } else if (shouldFetchLicense() && registryLookups) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch go package license information for ${group}:${name}`,
      );
    }
    license = await getGoPkgLicense({
      group: group,
      name: name,
      version: version,
    });
  }
  // Split the full module path into namespace and name, since the caller
  // normally passes the whole path in `name`:
  // pkg:golang/github.com/foo/bar → namespace "github.com/foo", name "bar".
  let purlNamespace = group;
  let purlName = name;
  if (!group && name.includes("/")) {
    const slash = name.lastIndexOf("/");
    purlNamespace = name.slice(0, slash);
    purlName = name.slice(slash + 1);
  }
  // Single-segment module paths (`go4.org`, `go.opencensus.io`) are real Go
  // modules with no namespace. cdx-purl 0.0.3 rejected them, which cost them
  // their purl; 0.0.4 relaxed the golang namespace rule, so they are now built
  // like any other module. Replacing %2F with / keeps the namespace readable as
  // the spec intends.
  const purlString =
    tryBuildPurl({
      type: "golang",
      namespace: purlNamespace || null,
      name: purlName,
      version: version || null,
    })?.replace(/%2F/g, "/") || null;
  let vcs;
  if (shouldFetchVCS() && registryLookups) {
    vcs = await getGoPkgVCSUrl(group, name, version);
  }
  const packageInfo = {
    group: group,
    name: name,
    version: version,
    _integrity: hash,
    license: license,
  };
  if (licenses) {
    packageInfo.licenses = licenses;
  }
  applyPurl(packageInfo, purlString);
  if (vcs) {
    packageInfo.externalReferences = [{ type: "vcs", url: vcs }];
  }
  return packageInfo;
}

/**
 * Method to parse go.mod files
 *
 * @param {String} goModData Contents of go.mod file
 * @param {Object} gosumMap Data from go.sum files
 *
 * @returns {Object} Object containing parent component, rootList, packages
 *   list, and the replace directives as `replacements`
 */
export async function parseGoModData(goModData, gosumMap) {
  const pkgComponentsList = [];
  const rootList = [];

  if (!goModData) {
    return {};
  }
  const { parentComponent, entries, replacements } = decodeGoModData(
    goModData,
    gosumMap,
  );
  // A module whose licence notice is read locally is not asked for its
  // licence; getGoPkgComponent reads the same notice for each entry below.
  await prefetchGoPkgMetadata(goModulesToPrefetch(entries));
  for (const entry of entries) {
    const component = await getGoPkgComponent(
      "",
      entry.name,
      entry.version,
      entry.hash,
    );
    if (entry.replacement) {
      pkgComponentsList.push(component);
      rootList.push(component);
      continue;
    }
    if (entry.indirect) {
      component.scope = "optional";
    } else {
      rootList.push(component);
    }
    pkgComponentsList.push(component);
  }
  return {
    parentComponent,
    pkgList: pkgComponentsList.sort((a, b) =>
      // Sort on bom-ref, which every component has, rather than falling back
      // from purl to name. A mixed key sorts purl-less components under their
      // bare name and everything else under "pkg:...", so whether a purl could
      // be built silently reorders the output.
      compareCodeUnits(a["bom-ref"], b["bom-ref"]),
    ),
    rootList,
    replacements,
  };
}

/**
 * Read a go.mod into its parent component and an ordered list of module
 * entries, without touching the network.
 *
 * Separated from {@link parseGoModData} so the whole module set is known before
 * the first licence lookup, which is what makes one batched round possible.
 *
 * @param {String} goModData Contents of go.mod file
 * @param {Object} gosumMap Data from go.sum files
 * @returns {{parentComponent: Object, entries: Array<Object>, replacements: Array<Object>}}
 *   Parent component, module entries in file order, and every replace
 *   directive as `path`, `version`, `newPath` and `newVersion`
 */
function decodeGoModData(goModData, gosumMap) {
  const parentComponent = {};
  const entries = [];
  const replacements = [];
  // The verb of the parenthesised block being read: undefined outside a block,
  // and "" inside one whose header is not a single verb, which Go rejects.
  let blockVerb;

  for (const line of goModData.split("\n")) {
    const { tokens, comment } = tokenizeGoModLine(line);
    if (!tokens.length) {
      continue;
    }
    let verb;
    let args;
    if (blockVerb !== undefined) {
      if (tokens.length === 1 && tokens[0] === ")") {
        blockVerb = undefined;
        continue;
      }
      verb = blockVerb;
      args = tokens;
    } else if (tokens.at(-1) === "(") {
      // `require (` opens a block whose lines all carry the verb.
      blockVerb = tokens.length === 2 ? tokens[0] : "";
      continue;
    } else if (tokens.at(-2) === "(" && tokens.at(-1) === ")") {
      // `require ( )` is an empty block.
      continue;
    } else {
      verb = tokens[0];
      args = tokens.slice(1);
    }
    switch (verb) {
      case "module":
        if (args.length) {
          parentComponent.name = unquoteGoModToken(args[0]);
          parentComponent.type = "application";
          // Single-segment module paths are valid golang purls as of cdx-purl 0.0.4.
          applyPurl(
            parentComponent,
            tryParsePurl(`pkg:golang/${parentComponent.name}`),
          );
        }
        break;
      case "toolchain":
        if (args.length) {
          parentComponent.properties = [
            { name: "cdx:go:toolchain", value: args[0] },
          ];
        }
        break;
      case "require": {
        // module/path v1.2.3
        const name = unquoteGoModToken(args[0]);
        const version = args[1];
        if (!name || !version) {
          break;
        }
        entries.push({
          group: "",
          name,
          version,
          hash: gosumMap[`${name}@${version}`],
          indirect: isGoModIndirectComment(comment),
          replacement: false,
        });
        break;
      }
      case "replace": {
        // module/path [v1.2.3] => other/module v1.4.5
        // module/path [v1.2.3] => ../local/directory
        // Only the first form names a module version; a directory
        // replacement leaves the required module as the component.
        const arrow = args[1] === "=>" ? 1 : 2;
        if (
          args[arrow] !== "=>" ||
          (args.length !== arrow + 2 && args.length !== arrow + 3)
        ) {
          break;
        }
        const oldPath = unquoteGoModToken(args[0]);
        const name = unquoteGoModToken(args[arrow + 1]);
        const version = args[arrow + 2];
        if (oldPath && name) {
          replacements.push({
            path: oldPath,
            version: arrow === 2 ? args[1] : undefined,
            newPath: name,
            newVersion: version,
          });
        }
        if (!name || args.length !== arrow + 3) {
          break;
        }
        entries.push({
          group: "",
          name,
          version,
          hash: gosumMap[`${name}@${version}`],
          indirect: false,
          replacement: true,
        });
        break;
      }
      // `go`, `godebug`, `exclude`, `retract`, `ignore` and `tool` name no
      // dependency: an excluded or retracted version is kept out of the build,
      // and a tool's module is listed under `require` once the module is tidy.
      default:
        break;
    }
  }
  return { parentComponent, entries, replacements };
}

// Characters the go.mod lexer always reads as a token of their own.
const GO_MOD_PUNCTUATION = "()[]{},";

/**
 * Split one go.mod line into tokens the way the Go toolchain's modfile lexer
 * does: whitespace separates tokens, `(`, `)`, `[`, `]`, `{`, `}` and `,`
 * stand alone, a quoted string is one token, and `//` starts a comment that
 * runs to the end of the line.
 *
 * @param {string} line A single line of a go.mod file
 * @returns {{tokens: string[], comment: string}} The tokens, quoted strings
 *   still quoted, and the trailing comment text without its `//`
 */
function tokenizeGoModLine(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (/\s/.test(c)) {
      i++;
    } else if (line.startsWith("//", i)) {
      return { tokens, comment: line.slice(i + 2).trim() };
    } else if (GO_MOD_PUNCTUATION.includes(c)) {
      tokens.push(c);
      i++;
    } else if (c === '"' || c === "`") {
      let end = i + 1;
      while (end < line.length && line[end] !== c) {
        // A double-quoted string escapes its quote with a backslash.
        end += c === '"' && line[end] === "\\" ? 2 : 1;
      }
      tokens.push(line.slice(i, end + 1));
      i = end + 1;
    } else {
      let end = i;
      while (
        end < line.length &&
        !/\s/.test(line[end]) &&
        !GO_MOD_PUNCTUATION.includes(line[end]) &&
        !line.startsWith("//", end)
      ) {
        end++;
      }
      tokens.push(line.slice(i, end));
      i = end;
    }
  }
  return { tokens, comment: "" };
}

/**
 * Read a module path or directory token, which go.mod allows in double
 * quotes. Like the Go toolchain, any other quote character makes it invalid.
 *
 * @param {string|undefined} token A go.mod token
 * @returns {string|undefined} The unquoted value, or undefined when invalid
 */
function unquoteGoModToken(token) {
  if (token?.startsWith('"')) {
    return token.length >= 2 && token.endsWith('"')
      ? token.slice(1, -1)
      : undefined;
  }
  if (/["'`]/.test(token || "")) {
    return undefined;
  }
  return token;
}

/**
 * Whether a require line's comment marks it indirect, as the Go toolchain
 * reads it: `// indirect`, or `// indirect; ` followed by a reason.
 *
 * @param {string} comment Comment text without its `//`
 * @returns {boolean} True for an indirect requirement
 */
function isGoModIndirectComment(comment) {
  const fields = comment.split(/\s+/).filter(Boolean);
  return (
    (fields.length === 1 && fields[0] === "indirect") ||
    (fields.length > 1 && fields[0] === "indirect;")
  );
}

// A semantic version as golang.org/x/mod/semver accepts it, used to tell a
// module line's version from the `=>` of a replacement.
const GO_SEMVER_PATTERN =
  /^v(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,2}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * Read one `# ` module line of a vendor/modules.txt file the way the Go
 * toolchain does (modload.readVendorList):
 *
 *   # module/path v1.2.3
 *   # module/path v1.2.3 => other/module v1.4.5
 *   # module/path v1.2.3 => ../local/directory
 *   # module/path => other/module v1.4.5     (a replacement of every version)
 *
 * @param {string} line A line starting with `# `
 * @returns {Object|undefined} `path`, `version` and, for a replaced module,
 *   `newPath` and `newVersion`; undefined for a line Go ignores
 */
function parseModulesTxtModuleLine(line) {
  const fields = line.split(/\s+/).filter(Boolean);
  if (fields.length < 3) {
    return undefined;
  }
  let rest;
  const module = { path: fields[1] };
  if (GO_SEMVER_PATTERN.test(fields[2])) {
    module.version = fields[2];
    rest = fields.slice(3);
  } else if (fields[2] === "=>") {
    rest = fields.slice(2);
  } else {
    return undefined;
  }
  if (rest[0] === "=>") {
    if (rest.length === 2) {
      module.newPath = rest[1];
    } else if (rest.length === 3 && GO_SEMVER_PATTERN.test(rest[2])) {
      module.newPath = rest[1];
      module.newVersion = rest[2];
    }
  }
  return module;
}

/**
 * Parses a Go modules text file (e.g. vendor/modules.txt) and returns a list of
 * Go package components. Cross-references the go.sum map for integrity hashes and
 * sets scope and confidence based on hash availability.
 *
 * Only the modules the vendor tree holds become components: a module line
 * followed by its `##` annotations or its packages. `go mod vendor` also
 * records every replace directive of go.mod at the end of the file, as a
 * module line with nothing after it, so the consumer can tell that the
 * replacement had no effect; those lines name no vendored module.
 *
 * @param {string} txtFile Path to the modules.txt file
 * @param {Object} gosumMap Map of "module@version" keys to sha256 hash values from go.sum
 * @param {Object} [options] Options
 * @param {Map<string, Object>} [options.noticeDirs] The licence notice
 *   directories this scan has read, shared with the other Go parsers of the
 *   scan (see {@link readLocalGoLicenses})
 * @returns {Promise<Object[]>} List of Go package component objects with evidence
 */
export async function parseGoModulesTxt(txtFile, gosumMap, options = {}) {
  const pkgList = [];
  const txtData = readFileSync(txtFile, { encoding: "utf-8" });
  // A modules.txt file lives in the vendor/ tree, so the modules it lists are
  // vendored one directory up from it.
  const projectRoot = dirname(dirname(txtFile));
  const records = [];
  let current;
  for (const rawLine of txtData.split("\n")) {
    // A checkout with CRLF line endings must read the same as the LF file
    // go mod vendor wrote.
    const line = rawLine.replaceAll("\r", "");
    if (line.startsWith("# ")) {
      current = parseModulesTxtModuleLine(line);
      if (current) {
        records.push(current);
      }
      continue;
    }
    if (current && line.trim()) {
      current.vendored = true;
    }
  }
  const modules = [];
  const noticeDirs = options.noticeDirs || new Map();
  for (const record of records) {
    // A replacement record of every version names no module version, and a
    // record with nothing after it was not vendored.
    if (!record.version || !record.vendored) {
      continue;
    }
    const replacement = goReplacement(
      record.path,
      record.version,
      record.newPath,
      record.newVersion,
    );
    modules.push({
      group: "",
      name: replacement?.name ?? record.path,
      version: replacement ? replacement.version : record.version,
      replacement,
      projectRoot,
      // Go vendors a replaced module under the path it replaces.
      vendorPath: record.path,
      skipRegistryLookups: !!replacement?.local,
      noticeDirs,
    });
  }
  // A module whose vendored licence notice is read is not asked for its
  // licence; getGoPkgComponent reads the same file. Local code is never
  // asked about.
  await prefetchGoPkgMetadata(goModulesToPrefetch(modules));
  for (const m of modules) {
    const gosumHash = m.version
      ? gosumMap[`${m.name}@${m.version}`]
      : undefined;
    const component = await getGoPkgComponent(
      "",
      m.name,
      m.version,
      gosumHash,
      m,
    );
    addGoReplacementProperties(component, m.replacement);
    let confidence = 0.7;
    if (gosumHash) {
      component.scope = "required";
    } else {
      confidence = 0.3;
    }
    pkgList.push(_addGoComponentEvidence(component, txtFile, confidence));
  }
  return pkgList;
}

/**
 * Whether two paths name the same directory. `go list` prints the real path
 * of a directory, which differs from the one cdxgen was given when that runs
 * through a symbolic link (macOS /tmp is /private/tmp).
 *
 * @param {string} [a] A directory
 * @param {string} [b] Another directory
 * @returns {boolean}
 */
function isSameGoDir(a, b) {
  if (!a || !b) {
    return false;
  }
  if (resolve(a) === resolve(b)) {
    return true;
  }
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Parse go list output
 *
 * Each row is printed by the template in createGoBom:
 * `Path|Version|Indirect|GoMod|GoVersion|Main|Time|Deprecated|GoModSum|Dir|Sum|
 * Replace.Path|Replace.Version|Replace.Sum`. Rows from older templates end
 * after `Dir`.
 *
 * A replaced module is reported as the module Go builds (see
 * {@link goReplacement}), with the checksum of the replacement. A go.work
 * workspace makes every member a main module, so the parent is the main
 * module in `options.mainModuleDir`, and the other members are returned as
 * `workspaceModules`.
 *
 * @param {string} rawOutput Output from go list invocation
 * @param {Object} gosumMap go.sum data
 * @param {Object} [options] Options
 * @param {string} [options.mainModuleDir] Directory `go list` ran in, whose
 *   main module is the parent component
 * @param {Map<string, Object>} [options.noticeDirs] The licence notice
 *   directories this scan has read, shared with the other Go parsers of the
 *   scan (see {@link readLocalGoLicenses})
 * @returns Object with parent component, list of packages, and the other main
 *   modules of a workspace
 */
export async function parseGoListDep(rawOutput, gosumMap, options = {}) {
  let parentComponent = {};
  const deps = [];
  const workspaceModules = [];
  if (typeof rawOutput === "string") {
    const rows = [];
    const seen = new Set();
    for (const l of rawOutput.split("\n")) {
      const verArr = l.trim().replace(/["']/g, "").split("|");
      if (verArr.length < 5) {
        continue;
      }
      // Every package of a module repeats the module's row.
      const key = `${verArr[0]}-${verArr[1]}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push(verArr);
    }
    // The main module is the project itself, which no registry holds. In a
    // go.work workspace every member is a main module, and the one go list
    // ran in is the parent.
    const mainRows = rows.filter((verArr) => verArr[5] === "true");
    const mainRow =
      mainRows.find((verArr) =>
        isSameGoDir(verArr[9], options.mainModuleDir),
      ) || mainRows[0];
    // The directory of the main module, which is the project root, under
    // which the vendored copies of the dependencies live.
    const mainModuleDir = mainRow?.[9] || undefined;
    const noticeDirs = options.noticeDirs || new Map();
    const modules = rows.map((verArr) => {
      const isMainModule = verArr[5] === "true";
      const replacement = isMainModule
        ? undefined
        : goReplacement(verArr[0], verArr[1], verArr[11], verArr[12]);
      const name = replacement?.name ?? verArr[0];
      const version = replacement ? replacement.version : verArr[1];
      return {
        verArr,
        isMainModule,
        replacement,
        group: "",
        name,
        version,
        // Module.Sum is the checksum of the module content, the hash of what
        // is built. GoModSum hashes only its go.mod file.
        hash:
          (version && gosumMap[`${name}@${version}`]) ||
          goSumIntegrity(replacement ? verArr[13] : verArr[10]),
        dir: verArr[9]?.length ? verArr[9] : undefined,
        projectRoot: mainModuleDir,
        // Go vendors a replaced module under the path it replaces.
        vendorPath: verArr[0],
        skipRegistryLookups: isMainModule || !!replacement?.local,
        noticeDirs,
      };
    });
    // A module whose licence notice is held on this machine is not asked for
    // its licence: getGoPkgComponent reads the same notices, so the batch
    // covers exactly what the loop will look up.
    await prefetchGoPkgMetadata(goModulesToPrefetch(modules));
    // The parent component reads the notices of its own directory before a
    // dependency replaced into that directory can.
    const parentFirst = [
      ...modules.filter((m) => m.verArr === mainRow),
      ...modules.filter((m) => m.verArr !== mainRow),
    ];
    for (const m of parentFirst) {
      const { verArr } = m;
      const component = await getGoPkgComponent(
        "",
        m.name,
        m.version,
        m.hash,
        m,
      );
      // This is misusing the scope attribute to represent direct vs indirect
      if (verArr[2] === "false") {
        component.scope = "required";
      } else if (verArr[2] === "true") {
        component.scope = "optional";
      }
      component.properties = [
        {
          name: "internal:SrcGoMod",
          value: verArr[3] || "",
        },
        {
          name: "internal:ModuleGoVersion",
          value: verArr[4] || "",
        },
        {
          name: "cdx:go:indirect",
          value: verArr[2],
        },
      ];
      if (verArr.length >= 6 && verArr[6]?.length && verArr[6] !== "<nil>") {
        component.properties.push({
          name: "cdx:go:creation_time",
          value: verArr[6],
        });
      }
      if (verArr.length >= 7 && verArr[7]?.length) {
        component.properties.push({
          name: "cdx:go:deprecated",
          value: verArr[7],
        });
      }
      addGoReplacementProperties(component, m.replacement);
      if (verArr === mainRow) {
        parentComponent = component;
      } else if (m.isMainModule) {
        workspaceModules.push(component);
      } else {
        deps.push(component);
      }
    }
  }
  return {
    parentComponent,
    pkgList: deps.sort((a, b) =>
      // Sort on bom-ref, which every component has, rather than falling back
      // from purl to name. A mixed key sorts purl-less components under their
      // bare name and everything else under "pkg:...", so whether a purl could
      // be built silently reorders the output.
      compareCodeUnits(a["bom-ref"], b["bom-ref"]),
    ),
    workspaceModules,
  };
}

function _addGoComponentEvidence(component, goModFile, confidence = 0.8) {
  if (goModFile) {
    component.evidence = {
      identity: {
        field: "purl",
        confidence,
        methods: [
          {
            technique: "manifest-analysis",
            confidence,
            value: goModFile,
          },
        ],
      },
    };
    if (!component.properties) {
      component.properties = [];
    }
    component.properties.push({
      name: "internal:SrcFile",
      value: goModFile,
    });
  }
  return component;
}

/**
 * Build the purl of one `module@version` token from `go mod graph` output.
 *
 * The version is written the way Go prints it, so `+incompatible` and the build
 * metadata of a pseudo-version are unescaped. Reading the token strictly would
 * reject it and leave a reference that keeps the module path's upper-case
 * letters, which then never matches the lower-cased component and drops the
 * dependency edge.
 *
 * @param {string} token Module path, optionally followed by `@version`
 * @returns {Purl|null} Parsed purl, or null when the token forms no valid golang purl
 */
function goModGraphTokenPurl(token) {
  const canonical = canonicalPurlFromLooseString(`pkg:golang/${token}`);
  return canonical ? Purl.parse(canonical) : null;
}

/**
 * Split a `go mod graph` token into its module path and version, exactly as
 * Go printed them. A main module is printed without a version.
 *
 * @param {string} token `module/path@version` or `module/path`
 * @returns {{path: string, version: string|undefined}}
 */
function splitGoModGraphToken(token) {
  const at = token.indexOf("@");
  return at < 0
    ? { path: token, version: undefined }
    : { path: token.slice(0, at), version: token.slice(at + 1) };
}

/**
 * Value of the first property with the given name.
 *
 * @param {Object} component Component
 * @param {string} name Property name
 * @returns {string|undefined}
 */
function goComponentProperty(component, name) {
  return component?.properties?.find((p) => p.name === name)?.value;
}

/**
 * Parse go mod graph
 *
 * `go mod graph` names every module by the path and version its requirement
 * names, whatever replaces it. A replaced module is mapped to the module Go
 * builds: from the components `go list` reported, which record what they
 * replace, or else from the replace directives of go.mod.
 *
 * @param {string} rawOutput Output from go mod graph invocation
 * @param {string} goModFile go.mod file
 * @param {Object} gosumMap Hashes from gosum for lookups
 * @param {Array} epkgList Existing package list
 * @param {Object} parentComponent Current parent component
 *
 * @returns Object containing List of packages and dependencies
 */
export async function parseGoModGraph(
  rawOutput,
  goModFile,
  gosumMap,
  epkgList = [],
  parentComponent = {},
) {
  const pkgList = [];
  const dependenciesList = [];
  const addedPkgs = {};
  const depsMap = {};
  // Useful for filtering out invalid components
  const existingPkgMap = {};
  // Package map by manually parsing the go.mod data
  let goModPkgMap = {};
  // Direct dependencies by manually parsing the go.mod data
  const goModDirectDepsMap = {};
  // The same direct dependencies by module path, which stays correct when
  // the version the go.mod text names has drifted from the selected one.
  const goModDirectDepNames = new Set();
  // Indirect dependencies by manually parsing the go.mod data
  const goModOptionalDepsMap = {};
  const excludedRefs = new Set();
  // The module versions `go list` reported are the ones MVS selected, and the
  // only ones the BOM carries components for. `go mod graph` instead prints
  // the requirement graph, where each edge names the version the source's
  // go.mod asks for, so the two routinely disagree for the same module. They
  // are keyed by the module path exactly as Go prints it, which keeps its
  // upper-case letters; a replaced module is keyed by the path it replaces,
  // which is the one the graph prints.
  const selectedVersions = {};
  // `path@version` as the graph prints it, for every module a replace
  // directive put another module in place of.
  const replacedModules = new Map();
  for (const epkg of epkgList) {
    const replaces = goComponentProperty(epkg, "cdx:go:replaces");
    if (replaces) {
      const { path, version } = splitGoModGraphToken(replaces);
      replacedModules.set(replaces, {
        name: epkg.name,
        version: epkg.version,
        local: !epkg.version,
        localDir: goComponentProperty(epkg, "cdx:go:local_dir"),
        replaces,
      });
      if (version) {
        selectedVersions[path] = version;
      }
    } else if (epkg?.name && epkg?.version) {
      selectedVersions[epkg.name] = epkg.version;
    }
  }
  if (goModFile) {
    goModPkgMap = await parseGoModData(
      readFileSync(goModFile, { encoding: "utf-8" }),
      gosumMap,
    );
    if (goModPkgMap?.rootList) {
      for (const epkg of goModPkgMap.rootList) {
        goModDirectDepsMap[epkg["bom-ref"]] = true;
        // The bom-ref above names the version the go.mod text requires,
        // which an untidy module can leave older than the version MVS
        // selected. Root-edge validation below also asks by module path,
        // so a drifted direct require still counts as direct (#4497).
        goModDirectDepNames.add(epkg.name);
      }
    }
    if (goModPkgMap?.pkgList) {
      for (const epkg of goModPkgMap.pkgList) {
        if (epkg?.scope === "optional") {
          goModOptionalDepsMap[epkg["bom-ref"]] = true;
        }
      }
    }
  }
  // What the replace directives of go.mod make of a module the graph names. A
  // directive for one version wins over one for every version, as in Go.
  // Indexed by module path once, since every token of the graph is looked up.
  const goModReplacementsByPath = new Map();
  for (const r of goModPkgMap?.replacements || []) {
    let forPath = goModReplacementsByPath.get(r.path);
    if (!forPath) {
      forPath = { wildcard: undefined, versions: new Map() };
      goModReplacementsByPath.set(r.path, forPath);
    }
    if (r.version === undefined) {
      forPath.wildcard = r;
    } else if (!forPath.versions.has(r.version)) {
      forPath.versions.set(r.version, r);
    }
  }
  const goModReplacement = (path, version) => {
    const forPath = goModReplacementsByPath.get(path);
    const r = forPath?.versions.get(version) ?? forPath?.wildcard;
    return r
      ? goReplacement(path, version, r.newPath, r.newVersion)
      : undefined;
  };
  // The module Go builds for one graph token, with the reference of the
  // component that stands for it.
  const graphModule = (path, version) => {
    const replacement = version
      ? replacedModules.get(`${path}@${version}`) ||
        goModReplacement(path, version)
      : undefined;
    const name = replacement ? replacement.name : path;
    const moduleVersion = replacement ? replacement.version : version;
    const token = moduleVersion ? `${name}@${moduleVersion}` : name;
    // Some golang modules (e.g. go4.org) have no path separator and
    // cdx-purl requires a namespace. Use the raw ref when parsing fails.
    const purl = goModGraphTokenPurl(token);
    return {
      path,
      name,
      version: moduleVersion,
      token,
      replacement,
      ref: purl ? decodeURIComponent(purl.toString()) : `pkg:golang/${token}`,
    };
  };
  for (const epkg of epkgList) {
    existingPkgMap[epkg["bom-ref"]] = true;
  }
  if (parentComponent && Object.keys(parentComponent).length) {
    existingPkgMap[parentComponent["bom-ref"]] = true;
  }
  const filterByExisting = Object.keys(existingPkgMap).length > 0;
  // goModDirectDepsMap is complete by now, and the loop below only reads it.
  const hasGoModDirectDeps = Object.keys(goModDirectDepsMap).length > 0;
  if (typeof rawOutput === "string") {
    const lines = rawOutput.split("\n");
    // Each line is of the form ref dependsOn
    // github.com/spf13/afero@v1.2.2 golang.org/x/text@v0.3.0
    for (const l of lines) {
      const tmpA = l.replaceAll("\r", "").split(" ");
      if (tmpA && tmpA.length === 2) {
        try {
          const sourceToken = splitGoModGraphToken(tmpA[0]);
          const dependsToken = splitGoModGraphToken(tmpA[1]);
          const source = graphModule(sourceToken.path, sourceToken.version);
          let depends = graphModule(dependsToken.path, dependsToken.version);
          // An edge whose target names a version the build did not select is
          // rewritten to the selected one rather than dropped: the selected
          // module is the one actually linked, and dropping the edge silently
          // disconnects it from every dependent that asked for an older
          // version (#4497). Only the target is rewritten; an edge from a
          // version that was not selected describes the requirements of a
          // module the build never used, so it stays filtered out.
          if (filterByExisting && !existingPkgMap[depends.ref]) {
            const selectedVersion = selectedVersions[dependsToken.path];
            if (selectedVersion && selectedVersion !== dependsToken.version) {
              const rewritten = graphModule(dependsToken.path, selectedVersion);
              if (existingPkgMap[rewritten.ref]) {
                depends = rewritten;
              }
            }
          }
          const sourceRefString = source.ref;
          const dependsRefString = depends.ref;
          // Since go mod graph over-reports direct dependencies we use the existing list
          // from go deps to filter the result
          if (
            filterByExisting &&
            (!existingPkgMap[sourceRefString] ||
              !existingPkgMap[dependsRefString])
          ) {
            continue;
          }
          // Add the source and depends to the pkgList
          if (
            !addedPkgs[sourceRefString] &&
            !excludedRefs.has(sourceRefString)
          ) {
            // go mod graph prints a main module without a version. A main
            // module is the project itself, or a go.work member, which no
            // registry holds, so it is never looked up. It still becomes a
            // component, because the graph's edges hang off it.
            const isParentSource =
              !sourceToken.version ||
              source.name === goModPkgMap?.parentComponent?.name ||
              sourceRefString === parentComponent?.["bom-ref"];
            const component = addGoReplacementProperties(
              await getGoPkgComponent(
                "",
                source.name,
                source.version,
                gosumMap[source.token],
                {
                  skipRegistryLookups:
                    isParentSource || !!source.replacement?.local,
                },
              ),
              source.replacement,
            );
            let confidence = 0.7;
            if (goModOptionalDepsMap[component["bom-ref"]]) {
              component.scope = "optional";
              confidence = 0.5;
            } else if (goModDirectDepsMap[component["bom-ref"]]) {
              component.scope = "required";
            }
            // These are likely false positives
            if (
              goModFile &&
              !filterByExisting &&
              goModPkgMap?.parentComponent?.["bom-ref"] !== sourceRefString &&
              !component.scope
            ) {
              continue;
            }
            // Don't add the parent component to the package list: neither
            // this go.mod's module nor the caller's parent, which in a go.work
            // workspace is another member that the graph also prints.
            if (
              goModPkgMap?.parentComponent?.["bom-ref"] !== sourceRefString &&
              parentComponent?.["bom-ref"] !== sourceRefString
            ) {
              pkgList.push(
                _addGoComponentEvidence(component, goModFile, confidence),
              );
            }
            addedPkgs[sourceRefString] = true;
          }
          if (!addedPkgs[dependsRefString]) {
            const component = addGoReplacementProperties(
              await getGoPkgComponent(
                "",
                depends.name,
                depends.version,
                gosumMap[depends.token],
                { skipRegistryLookups: !!depends.replacement?.local },
              ),
              depends.replacement,
            );
            let confidence = 0.7;
            if (goModDirectDepsMap[component["bom-ref"]]) {
              component.scope = "required";
            }
            if (goModOptionalDepsMap[component["bom-ref"]]) {
              component.scope = "optional";
              confidence = 0.5;
            }
            if (
              goModPkgMap?.parentComponent?.["bom-ref"] !== sourceRefString &&
              goModDirectDepsMap[sourceRefString] &&
              component?.scope !== "required"
            ) {
              // If the parent is required, then ensure the child doesn't accidentally become optional or excluded
              component.scope = undefined;
            }
            // Mark the go toolchain components as excluded
            if (
              dependsRefString.startsWith("pkg:golang/toolchain@") ||
              dependsRefString.startsWith("pkg:golang/go@")
            ) {
              excludedRefs.add(dependsRefString);
              continue;
            }
            // These are likely false positives
            if (
              goModFile &&
              goModPkgMap?.parentComponent?.["bom-ref"] !== sourceRefString &&
              !filterByExisting &&
              !component.scope
            ) {
              excludedRefs.add(dependsRefString);
              continue;
            }
            // The confidence for the indirect dependencies is lower
            // This is because go mod graph emits module requirements graph, which could be different to module compile graph
            // See https://go.dev/ref/mod#glos-module-graph
            pkgList.push(
              _addGoComponentEvidence(component, goModFile, confidence),
            );
            addedPkgs[dependsRefString] = true;
          }
          if (!depsMap[sourceRefString]) {
            depsMap[sourceRefString] = new Set();
          }
          if (!depsMap[dependsRefString]) {
            depsMap[dependsRefString] = new Set();
          }
          // Check if the root is really dependent on this component. The
          // by-path check accepts a direct require whose go.mod version
          // drifted from the selected one: the edge was already rewritten
          // to the selected version above, and the by-ref map only knows
          // the stale bom-ref (#4497). It also accepts a directly required
          // module that a directory replaces, whose component has no
          // version.
          if (
            goModPkgMap?.parentComponent?.["bom-ref"] === sourceRefString &&
            hasGoModDirectDeps &&
            !goModDirectDepsMap[dependsRefString] &&
            !goModDirectDepNames.has(dependsToken.path)
          ) {
            // ignore
          } else if (!excludedRefs.has(dependsRefString)) {
            depsMap[sourceRefString].add(dependsRefString);
          }
        } catch (_e) {
          // pass
        }
      }
    }
  }
  for (const adep of Object.keys(depsMap).sort()) {
    dependenciesList.push({
      ref: adep,
      dependsOn: Array.from(depsMap[adep]).sort(),
    });
  }
  return {
    pkgList: pkgList.sort((a, b) =>
      // Sort on bom-ref, which every component has, rather than falling back
      // from purl to name. A mixed key sorts purl-less components under their
      // bare name and everything else under "pkg:...", so whether a purl could
      // be built silently reorders the output.
      compareCodeUnits(a["bom-ref"], b["bom-ref"]),
    ),
    dependenciesList,
    parentComponent: goModPkgMap?.parentComponent,
    rootList: goModPkgMap?.rootList,
  };
}

/**
 * Parse go mod why output.
 *
 * @param {string} rawOutput Output from go mod why
 * @returns {string|undefined} package name or none
 */
export function parseGoModWhy(rawOutput) {
  if (typeof rawOutput === "string") {
    let pkg_name;
    const lines = rawOutput.split("\n");
    lines.forEach((l) => {
      if (l && !l.startsWith("#") && !l.startsWith("(")) {
        pkg_name = l.trim();
      }
    });
    return pkg_name;
  }
  return undefined;
}

/**
 * Reports whether `go mod why -m` output says the main module does not need
 * the module. go prints `(main module does not need module X)`, or
 * `(main module does not need to vendor module X)` with `-vendor`, and exits
 * with status 0 either way.
 *
 * @param {string} rawOutput Output from go mod why
 * @returns {boolean} True when go reports the module as not needed
 */
export function isGoModWhyNotNeeded(rawOutput) {
  if (typeof rawOutput !== "string") {
    return false;
  }
  return rawOutput
    .split("\n")
    .some((line) => line.trim().startsWith("(main module does not need "));
}

/**
 * Read the `module@version` to hash map out of go.sum contents, without
 * building components or touching the network.
 *
 * @param {string} gosumData Content of go.sum
 * @returns {Object} Map of `module@version` keys to the `sha256-…` checksum of
 *   the module content, for every version go.sum holds one for
 */
export function parseGosumHashes(gosumData) {
  const gosumMap = {};
  for (const entry of decodeGosumData(gosumData)) {
    if (entry.hash) {
      gosumMap[`${entry.name}@${entry.version}`] = entry.hash;
    }
  }
  return gosumMap;
}

/**
 * Decode a go.sum file into one entry per module version it names.
 *
 * go.sum holds up to two lines per module version: `path version h1:…`, the
 * checksum of the module's content, and `path version/go.mod h1:…`, the
 * checksum of its go.mod file alone. The content checksum is the hash of the
 * component. A version with only a go.mod line was needed to resolve the
 * module graph but never downloaded, so it has no content hash.
 *
 * @param {string} gosumData Content of go.sum
 * @returns {Object[]} Entries with `name`, `version` and `hash`, in the order
 *   go.sum first names them
 */
function decodeGosumData(gosumData) {
  const entries = new Map();
  if (!gosumData) {
    return [];
  }
  for (const l of gosumData.split("\n")) {
    const fields = l.replaceAll("\r", "").trim().split(/\s+/);
    if (fields.length !== 3 || !fields[2].startsWith("h1:")) {
      continue;
    }
    const isGoModLine = fields[1].endsWith("/go.mod");
    const name = fields[0];
    const version = isGoModLine
      ? fields[1].slice(0, -"/go.mod".length)
      : fields[1];
    const key = `${name}@${version}`;
    if (!entries.has(key)) {
      entries.set(key, { group: "", name, version, hash: undefined });
    }
    if (!isGoModLine) {
      entries.get(key).hash = goSumIntegrity(fields[2]);
    }
  }
  return [...entries.values()];
}

/**
 * Parse go sum data
 * @param {string} gosumData Content of go.sum
 * @returns package list
 */
export async function parseGosumData(gosumData) {
  const pkgList = [];
  const entries = decodeGosumData(gosumData);
  // A module whose licence notice is read locally is not asked for its
  // licence; getGoPkgComponent reads the same notice for each entry below.
  await prefetchGoPkgMetadata(goModulesToPrefetch(entries));
  for (const entry of entries) {
    pkgList.push(
      await getGoPkgComponent("", entry.name, entry.version, entry.hash),
    );
  }
  return pkgList;
}

/**
 * Parses the contents of a Gopkg.lock or Gopkg.toml file (dep tool format) and
 * returns a list of Go package components. Optionally fetches license information
 * for each package when FETCH_LICENSE is enabled.
 *
 * @param {string} gopkgData Raw string contents of the Gopkg lock/toml file
 * @returns {Promise<Object[]>} List of Go package component objects
 */
export async function parseGopkgData(gopkgData) {
  const pkgList = [];
  if (!gopkgData) {
    return pkgList;
  }
  let pkg = null;
  const pkgs = gopkgData.split("\n");
  for (const l of pkgs) {
    let key = null;
    let value = null;
    // Every table header ends the project read so far, and only a
    // [[projects]] table starts another. The keys of [solve-meta] belong to
    // no project.
    if (l.trim().startsWith("[")) {
      if (pkg) {
        pkgList.push(await finalizeGopkgProject(pkg));
      }
      pkg = l.indexOf("[[projects]]") > -1 ? {} : null;
      continue;
    }
    if (pkg && l.indexOf("=") > -1) {
      const tmpA = l.split("=");
      key = tmpA[0].trim();
      value = tmpA[1].trim().replace(/"/g, "");
      let digestStr;
      switch (key) {
        case "digest":
          digestStr = value.replace("1:", "");
          pkg._integrity = `sha256-${toBase64(digestStr)}`;
          break;
        case "name":
          pkg.group = "";
          pkg.name = value;
          break;
        case "version":
          pkg.version = value;
          break;
        case "revision":
          if (!pkg.version) {
            pkg.version = value;
          }
      }
    }
  }
  // The last project has no header after it.
  if (pkg) {
    pkgList.push(await finalizeGopkgProject(pkg));
  }
  return pkgList;
}

/**
 * Attach the licence of one Gopkg project once its name and version are both
 * known, so the pkg.go.dev URL names the pinned release.
 *
 * @param {Object} pkg The project entry read so far
 * @returns {Promise<Object>} The same entry, with a licence when one was found
 */
async function finalizeGopkgProject(pkg) {
  if (shouldFetchLicense() && pkg.name) {
    pkg.license = await getGoPkgLicense({
      group: pkg.group,
      name: pkg.name,
      version: pkg.version,
    });
  }
  return pkg;
}

/**
 * Parses the output of `go version -m` (build info) and returns a list of Go
 * package components for each "dep" line, including name, version, and integrity hash.
 *
 * A dependency that a replace directive swapped out is printed as its `dep`
 * line followed by a `=>` line naming the replacement (runtime/debug
 * BuildInfo.String). The replacement is what the binary holds, so it is
 * reported as {@link goReplacement} describes, with the replacement's
 * checksum.
 *
 * @param {string} buildInfoData Raw string output from `go version -m`
 * @returns {Promise<Object[]>} List of Go package component objects
 */
export async function parseGoVersionData(buildInfoData) {
  const pkgList = [];
  if (!buildInfoData) {
    return pkgList;
  }
  const entries = [];
  let lastDep;
  for (const line of buildInfoData.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === "=>" && lastDep && fields.length >= 2) {
      lastDep.replacement = goReplacement(
        lastDep.name,
        lastDep.version,
        fields[1],
        fields[2],
      );
      lastDep.name = lastDep.replacement.name;
      lastDep.version = lastDep.replacement.version;
      lastDep.skipRegistryLookups = lastDep.replacement.local;
      lastDep.hash = goSumIntegrity(fields[3]) || "";
      lastDep = undefined;
      continue;
    }
    lastDep = undefined;
    if (fields[0] !== "dep" || fields.length < 3) {
      continue;
    }
    lastDep = {
      group: "",
      name: fields[1],
      version: fields[2],
      hash: goSumIntegrity(fields[3]) || "",
    };
    entries.push(lastDep);
  }
  await prefetchGoPkgMetadata(goModulesToPrefetch(entries));
  for (const entry of entries) {
    pkgList.push(
      addGoReplacementProperties(
        await getGoPkgComponent(
          "",
          entry.name,
          entry.version,
          entry.hash,
          entry,
        ),
        entry.replacement,
      ),
    );
  }
  return pkgList;
}
