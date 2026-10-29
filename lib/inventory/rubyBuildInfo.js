// Bounded Ruby build-version reader for unpackaged Ruby installs, and the one
// place a Ruby version becomes a runtime component, for the container scan,
// the OS scan, formulation and the source scan alike.
//
// The Ruby of a Docker Official image, ruby-build, rbenv, rvm, asdf, mise,
// chruby and the RubyInstaller is owned by no package manager, so a BOM sees it
// only as files. Its version decides whether the interpreter is affected by
// advisories in its core, such as the Onigmo fixes of Ruby 3.3.13, 3.4.12 and
// 4.0.9 (CVE-2026-89078, CVE-2026-93577, CVE-2026-97229, CVE-2026-110264).
//
// Three facts identify a build, read in this order:
// - rbconfig.rb, which `make install` writes under
//   <prefix>/lib/ruby/<abi>/<arch>/ (or <prefix>/lib/<triplet>/ruby/<abi>/ in
//   a Debian layout). RUBY_PROGRAM_VERSION in it is the unexpanded template
//   "$(MAJOR).$(MINOR).$(TEENY)", so the version is assembled from the MAJOR,
//   MINOR and TEENY entries, with PATCHLEVEL beside them:
//   https://github.com/ruby/ruby/blob/v3_3_6/tool/mkconfig.rb
// - the description string compiled into libruby (or a static `ruby`), the
//   first line `ruby -v` prints: `ruby 3.3.6 (2024-11-05 revision 75015d4c1f)
//   [x86_64-linux]`. It also names a preview or release candidate, which a
//   PATCHLEVEL of -1 in rbconfig.rb leaves unsaid:
//   https://github.com/ruby/ruby/blob/v3_3_6/version.c
// - the libruby soname, libruby.so.3.3.6, when nothing else could be read.
//
// Every file in an image or on a host is hostile: only regular files inside
// the root are opened, reads are capped, nothing is executed, and a missing or
// odd file yields no result rather than throwing.

import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { readRegularTextFile, scanFileMarkers } from "../core/boundedFile.js";
import { applyPurl, tryBuildPurl } from "./purl.js";

/**
 * The most Ruby-named files one scan opens in search of a build version.
 *
 * @type {number}
 */
export const MAX_RUBY_PROBES = 64;

const MAX_RBCONFIG_BYTES = 512 * 1024;
const MAX_LISTED_DIRECTORIES = 32;
const MAX_VERSION_LENGTH = 32;
const DESCRIPTION_MARKER = Buffer.from("ruby ");

// MRI versions: 3.3.6, 3.4.0-preview2 (also written 3.4.0preview2), 3.4.0-rc1,
// 3.5.0dev. A patchlevel suffix (p108) belongs to the description, not the
// version.
const VERSION_RE = /^(\d+\.\d+\.\d+)(?:-?(preview|rc)(\d+)|(dev))?$/;
// The Ruby ABI directory: 3.3.0, or 3.5.0+0 for a development build.
const ABI_RE = /^\d+\.\d+\.\d+(?:\+\d+)?$/;
const RBCONFIG_ENTRY_RE = /^\s*CONFIG\["([A-Za-z_]+)"\]\s*=\s*"([^"\\]*)"\s*$/;
const RBCONFIG_KEYS = new Set([
  "MAJOR",
  "MINOR",
  "TEENY",
  "PATCHLEVEL",
  "ruby_version",
  "arch",
  "RUBY_BASE_NAME",
  "RUBY_PROGRAM_VERSION",
  "RUBY_SO_NAME",
]);

/**
 * Parse an MRI version and normalize a pre-release to the hyphenated form the
 * release tarballs use: `3.4.0preview2` becomes `3.4.0-preview2`.
 *
 * @param {string} text candidate version, without a patchlevel
 * @returns {string|undefined} the version, or undefined
 */
export function parseRubyVersion(text) {
  if (typeof text !== "string" || !text || text.length > MAX_VERSION_LENGTH) {
    return undefined;
  }
  const match = VERSION_RE.exec(text.trim());
  if (!match) {
    return undefined;
  }
  if (match[2]) {
    return `${match[1]}-${match[2]}${match[3]}`;
  }
  return match[4] ? `${match[1]}-dev` : match[1];
}

/**
 * Read the first line `ruby -v` prints, or the description compiled into
 * libruby, for MRI, JRuby and TruffleRuby:
 * - `ruby 3.3.6 (2024-11-05 revision 75015d4c1f) [x86_64-linux]`
 * - `ruby 2.7.8p225 (2023-03-30 revision 1f4d455848) [x86_64-linux]`
 * - `ruby 3.4.0preview2 (2024-10-07 master 32c733f57b) +PRISM [x86_64-linux]`
 * - `jruby 9.4.8.0 (3.1.4) 2024-07-02 4d41e55a67 OpenJDK 64-Bit ...`
 * - `truffleruby 24.1.0, like ruby 3.2.4, Oracle GraalVM Native [x86_64-linux]`
 *
 * @param {string} text description line
 * @returns {{engine: string, version: string, patchlevel?: string,
 *   rubyVersion?: string, platform?: string}|undefined} engine is `ruby`,
 *   `jruby` or `truffleruby`; for the last two, rubyVersion is the Ruby
 *   language version the engine implements
 */
export function parseRubyDescription(text) {
  if (typeof text !== "string") {
    return undefined;
  }
  const line = text.split(/\r?\n/, 1)[0].trim().slice(0, 256);
  const space = line.indexOf(" ");
  if (space <= 0) {
    return undefined;
  }
  const engine = line.slice(0, space);
  const rest = line.slice(space + 1);
  if (engine === "ruby") {
    const end = rest.indexOf(" ");
    if (end <= 0 || rest[end + 1] !== "(") {
      return undefined;
    }
    let token = rest.slice(0, end);
    let patchlevel;
    const pIndex = token.lastIndexOf("p");
    if (pIndex > 0 && /^\d+$/.test(token.slice(pIndex + 1))) {
      // `p108`, but not the `p` of `preview2`
      const before = token.slice(0, pIndex);
      if (parseRubyVersion(before)) {
        patchlevel = token.slice(pIndex + 1);
        token = before;
      }
    }
    const version = parseRubyVersion(token);
    if (!version) {
      return undefined;
    }
    const result = { engine, version };
    if (patchlevel !== undefined) {
      result.patchlevel = patchlevel;
    }
    const open = rest.lastIndexOf("[");
    const close = rest.lastIndexOf("]");
    if (open !== -1 && close > open + 1) {
      result.platform = rest.slice(open + 1, close);
    }
    return result;
  }
  if (engine === "jruby") {
    const match = /^(\d+(?:\.\d+){2,3}) \((\d+\.\d+\.\d+)\)/.exec(rest);
    return match
      ? { engine, version: match[1], rubyVersion: match[2] }
      : undefined;
  }
  if (engine === "truffleruby") {
    const match = /^(\d+(?:\.\d+){1,3}), like ruby (\d+\.\d+\.\d+)/.exec(rest);
    return match
      ? { engine, version: match[1], rubyVersion: match[2] }
      : undefined;
  }
  return undefined;
}

/**
 * Read the entries of an rbconfig.rb that identify a build. Only literal
 * `CONFIG["KEY"] = "value"` lines are read; Ruby is never evaluated.
 *
 * @param {string} text rbconfig.rb contents
 * @returns {{version: string, patchlevel?: string, abi?: string,
 *   arch?: string, baseName?: string}|undefined}
 */
export function parseRbConfig(text) {
  if (typeof text !== "string" || !text) {
    return undefined;
  }
  const entries = Object.create(null);
  for (const line of text.split("\n")) {
    if (!line.includes("CONFIG[")) {
      continue;
    }
    const match = RBCONFIG_ENTRY_RE.exec(line);
    if (match && RBCONFIG_KEYS.has(match[1]) && !(match[1] in entries)) {
      entries[match[1]] = match[2];
    }
  }
  const { MAJOR, MINOR, TEENY } = entries;
  let version;
  if ([MAJOR, MINOR, TEENY].every((part) => /^\d+$/.test(part || ""))) {
    version = `${MAJOR}.${MINOR}.${TEENY}`;
  } else {
    version = parseRubyVersion(entries.RUBY_PROGRAM_VERSION);
  }
  if (!version) {
    return undefined;
  }
  const result = { version };
  if (/^-?\d+$/.test(entries.PATCHLEVEL || "")) {
    result.patchlevel = entries.PATCHLEVEL;
  }
  if (ABI_RE.test(entries.ruby_version || "")) {
    result.abi = entries.ruby_version;
  }
  if (entries.arch && entries.arch.length <= 64) {
    result.arch = entries.arch;
  }
  if (entries.RUBY_BASE_NAME && entries.RUBY_BASE_NAME.length <= 32) {
    result.baseName = entries.RUBY_BASE_NAME;
  }
  return result;
}

/**
 * Whether a file name is one a Ruby interpreter is installed under: `ruby`,
 * a versioned `ruby3.3` as distros and `--program-suffix` builds name it,
 * `ruby.exe` and `rubyw.exe`.
 *
 * @param {string} fileName basename or path of the candidate
 * @returns {boolean}
 */
export function isRubyBinaryName(fileName) {
  if (typeof fileName !== "string" || !fileName) {
    return false;
  }
  const name = basename(fileName.replaceAll("\\", "/"));
  const lower = name.toLowerCase();
  return (
    /^ruby(\d+(\.\d+){0,2})?$/.test(name) ||
    lower === "ruby.exe" ||
    lower === "rubyw.exe"
  );
}

/**
 * Whether a file name is the shared Ruby library: libruby.so.3.3.6, Debian's
 * libruby-3.1.so.3.1.2,
 * libruby.3.3.dylib, or the RubyInstaller's x64-ucrt-ruby340.dll.
 *
 * @param {string} fileName basename or path of the candidate
 * @returns {boolean}
 */
export function isLibrubyName(fileName) {
  if (typeof fileName !== "string" || !fileName) {
    return false;
  }
  const name = basename(fileName.replaceAll("\\", "/"));
  return (
    /^libruby(-\d+\.\d+)?(-static)?\.so(\.\d+){0,3}$/.test(name) ||
    /^libruby(\.\d+){0,3}\.dylib$/.test(name) ||
    /^[a-z0-9_]+(-[a-z0-9_]+)?-ruby\d{2,3}\.dll$/i.test(name)
  );
}

/**
 * The version a libruby soname spells, libruby.so.3.3.6 -> 3.3.6.
 *
 * @param {string} fileName basename or path
 * @returns {string|undefined}
 */
export function versionFromLibrubyName(fileName) {
  const name = basename(`${fileName || ""}`.replaceAll("\\", "/"));
  const match = /^libruby(?:-\d+\.\d+)?\.so\.(\d+\.\d+\.\d+)$/.exec(name);
  if (match) {
    return match[1];
  }
  const dylib = /^libruby\.(\d+\.\d+\.\d+)\.dylib$/.exec(name);
  return dylib ? dylib[1] : undefined;
}

// lib/ruby/<abi> holds hundreds of .rb files and dozens of library
// directories beside the one arch directory, so the cap applies to the
// directories accepted, after a bounded read.
const MAX_LISTED_ENTRIES = 8192;

function listDirectories(directory, accept = () => true) {
  try {
    const directories = [];
    for (const name of readdirSync(directory)
      .slice(0, MAX_LISTED_ENTRIES)
      .sort()) {
      if (name.endsWith(".rb") || !accept(name)) {
        continue;
      }
      try {
        if (statSync(join(directory, name)).isDirectory()) {
          directories.push(name);
        }
      } catch {
        // gone, or not readable
      }
      if (directories.length >= MAX_LISTED_DIRECTORIES) {
        break;
      }
    }
    return directories;
  } catch {
    return [];
  }
}

function listFiles(directory) {
  try {
    return readdirSync(directory).sort();
  } catch {
    return [];
  }
}

/**
 * The install prefix of a file under bin, sbin or lib: /usr/local/bin/ruby ->
 * /usr/local, C:\Ruby34-x64\bin\ruby.exe -> C:\Ruby34-x64.
 *
 * @param {string} absPath absolute path
 * @returns {string|undefined}
 */
export function rubyInstallPrefix(absPath) {
  if (typeof absPath !== "string" || !absPath) {
    return undefined;
  }
  // Paths from an image are POSIX whatever the host is, so the separator is
  // read from the path rather than taken from the platform.
  const separator =
    absPath.includes("\\") && !absPath.includes("/") ? "\\" : "/";
  const parts = absPath.replaceAll("\\", "/").split("/");
  for (let i = parts.length - 2; i >= 0; i--) {
    const part = parts[i].toLowerCase();
    if (part === "bin" || part === "sbin" || part === "lib") {
      return parts.slice(0, i).join(separator) || separator;
    }
  }
  return undefined;
}

/**
 * The rbconfig.rb files an install prefix holds, at most a few levels down:
 * <prefix>/lib/ruby/<abi>/<arch>/rbconfig.rb, and the Debian layout
 * <prefix>/lib/<triplet>/ruby/<abi>/rbconfig.rb.
 *
 * @param {string} prefix install prefix
 * @returns {string[]} absolute paths
 */
export function findRbConfigFiles(prefix) {
  const found = [];
  const libDir = join(prefix, "lib");
  const rubyDir = join(libDir, "ruby");
  for (const abi of listDirectories(rubyDir, (name) => ABI_RE.test(name))) {
    if (!ABI_RE.test(abi)) {
      continue;
    }
    // An arch is cpu-os (x86_64-linux, x64-mingw-ucrt, arm64-darwin24); the
    // library directories beside it (bigdecimal, did_you_mean) have no dash.
    for (const arch of listDirectories(join(rubyDir, abi), (name) =>
      name.includes("-"),
    )) {
      const candidate = join(rubyDir, abi, arch, "rbconfig.rb");
      if (listFiles(join(rubyDir, abi, arch)).includes("rbconfig.rb")) {
        found.push(candidate);
      }
    }
  }
  for (const triplet of listDirectories(libDir, (name) => name.includes("-"))) {
    if (triplet === "ruby" || !triplet.includes("-")) {
      continue;
    }
    for (const abi of listDirectories(join(libDir, triplet, "ruby"))) {
      if (!ABI_RE.test(abi)) {
        continue;
      }
      if (
        listFiles(join(libDir, triplet, "ruby", abi)).includes("rbconfig.rb")
      ) {
        found.push(join(libDir, triplet, "ruby", abi, "rbconfig.rb"));
      }
    }
  }
  return found;
}

// The major.minor a file name pins: ruby3.3 -> 3.3, libruby.so.3.3.6 -> 3.3,
// x64-ucrt-ruby330.dll -> 3.3.
function pinnedSeries(fileName) {
  const name = basename(`${fileName || ""}`.replaceAll("\\", "/"));
  let match = /^ruby(\d+)\.(\d+)/.exec(name);
  if (!match) {
    match = /^libruby(?:-\d+\.\d+)?(?:-static)?\.so\.(\d+)\.(\d+)/.exec(name);
  }
  if (!match) {
    match = /^libruby\.(\d+)\.(\d+)/.exec(name);
  }
  if (!match) {
    match = /-ruby(\d)(\d)\d\.dll$/i.exec(name);
  }
  return match ? `${match[1]}.${match[2]}` : undefined;
}

function readRbConfigFile(file, rootDir) {
  const text = readRegularTextFile(file, MAX_RBCONFIG_BYTES, rootDir);
  return text ? parseRbConfig(text) : undefined;
}

/**
 * Find the description compiled into a file, `ruby 3.3.6 (2024-11-05 ...`.
 *
 * @param {string} absPath absolute path of a ruby binary or libruby
 * @param {string|undefined} rootDir extracted root
 * @returns {ReturnType<typeof parseRubyDescription>}
 */
export function readRubyDescription(absPath, rootDir) {
  const scan = scanFileMarkers(absPath, rootDir, [DESCRIPTION_MARKER], {
    contextBytes: 160,
    beforeBytes: 1,
    maxHits: 256,
  });
  if (!scan || scan.skipped) {
    return undefined;
  }
  for (const hit of scan.hits[0]) {
    // The description is a C string of its own, so a NUL precedes it.
    if (hit.before.length && hit.before[0] !== 0) {
      continue;
    }
    const after = hit.after;
    const nul = after.indexOf(0);
    const text = `ruby ${after.toString("latin1", 0, nul === -1 ? after.length : nul)}`;
    const parsed = parseRubyDescription(text);
    if (parsed?.engine === "ruby") {
      return parsed;
    }
  }
  return undefined;
}

// The libruby beside a ruby binary, where a shared build keeps the description.
function siblingLibraries(prefix) {
  const libraries = [];
  for (const directory of [join(prefix, "lib"), join(prefix, "bin")]) {
    for (const name of listFiles(directory)) {
      if (isLibrubyName(name)) {
        libraries.push(join(directory, name));
      }
    }
  }
  return libraries.slice(0, 8);
}

/**
 * Read the Ruby build version of a ruby binary or libruby.
 *
 * @param {string} absPath absolute path of the candidate
 * @param {string|undefined} rootDir extracted root, when the file came from one
 * @returns {{version: string, source: string, patchlevel?: string,
 *   abi?: string, arch?: string}|undefined} source is `rbconfig`, `binary`
 *   or `soname`
 */
export function readRubyBuildVersion(absPath, rootDir) {
  const prefix = rubyInstallPrefix(absPath);
  const series = pinnedSeries(absPath);
  let build;
  if (prefix) {
    const configs = findRbConfigFiles(prefix)
      .map((file) => readRbConfigFile(file, rootDir))
      .filter(Boolean)
      .filter(
        (config) =>
          !series || config.version.split(".").slice(0, 2).join(".") === series,
      );
    const versions = new Set(configs.map((config) => config.version));
    if (versions.size === 1) {
      build = { ...configs[0], source: "rbconfig" };
    }
  }
  // A PATCHLEVEL of -1 is a preview, release candidate or development build,
  // which only the description names. Two installs sharing a prefix also need
  // the binary to tell them apart.
  if (!build || build.patchlevel === "-1") {
    const files = [absPath, ...(prefix ? siblingLibraries(prefix) : [])];
    for (const file of files) {
      const description = readRubyDescription(file, rootDir);
      if (!description) {
        continue;
      }
      if (
        build &&
        description.version.split("-")[0] !== build.version.split("-")[0]
      ) {
        continue;
      }
      build = {
        ...(build || {}),
        version: description.version,
        source: build ? build.source : "binary",
      };
      if (description.patchlevel !== undefined) {
        build.patchlevel = description.patchlevel;
      }
      if (!build.arch && description.platform) {
        build.arch = description.platform;
      }
      break;
    }
  }
  if (!build) {
    const fromName = versionFromLibrubyName(absPath);
    if (fromName) {
      build = { version: fromName, source: "soname" };
    }
  }
  if (!build) {
    return undefined;
  }
  const result = { version: build.version, source: build.source };
  for (const key of ["patchlevel", "abi", "arch"]) {
    if (build[key] !== undefined) {
      result[key] = build[key];
    }
  }
  return result;
}

const ENGINE_IDENTITY = {
  ruby: { vendor: "ruby-lang", product: "ruby" },
  jruby: { vendor: "jruby", product: "jruby" },
  truffleruby: undefined,
};

/**
 * The CPE that lets a downstream scanner match an interpreter version. NVD
 * names MRI ruby-lang:ruby and keeps a pre-release in the update field, as in
 * cpe:2.3:a:ruby-lang:ruby:3.4.0:preview1:*:*:*:*:*:*.
 *
 * @param {string} version interpreter version
 * @param {string} [engine="ruby"] `ruby` or `jruby`
 * @returns {string|undefined} CPE 2.3 string, or undefined for an engine NVD
 *   does not name
 */
export function rubyCpe(version, engine = "ruby") {
  const identity = ENGINE_IDENTITY[engine];
  if (!identity || typeof version !== "string" || !version) {
    return undefined;
  }
  let base = version;
  let update = "*";
  const dash = version.indexOf("-");
  if (dash !== -1) {
    base = version.slice(0, dash);
    update = version.slice(dash + 1).toLowerCase();
  }
  if (!/^\d+(\.\d+){1,3}$/.test(base) || !/^(\*|[a-z0-9]+)$/.test(update)) {
    return undefined;
  }
  return `cpe:2.3:a:${identity.vendor}:${identity.product}:${base}:${update}:*:*:*:*:*:*`;
}

/**
 * A Ruby runtime is one `platform` component per distinct engine and version,
 * like the PHP and Node.js runtime components. Its identity is
 * `pkg:generic/ruby` (or `jruby`, `truffleruby`).
 *
 * @param {string} version interpreter version
 * @param {Object} [options] options
 * @param {boolean} [options.withCpe=true] false for a Ruby a distro packaged,
 *   which backports fixes under its old upstream version
 * @param {string} [options.engine="ruby"] `ruby`, `jruby` or `truffleruby`
 * @returns {Object} component with `purl`, `bom-ref` and, when one applies, `cpe`
 */
export function createRubyRuntimeComponent(
  version,
  { withCpe = true, engine = "ruby" } = {},
) {
  const name = engine in ENGINE_IDENTITY ? engine : "ruby";
  const component = { type: "platform", name, version };
  if (withCpe) {
    const cpe = rubyCpe(version, name);
    if (cpe) {
      component.cpe = cpe;
    }
  }
  return applyPurl(component, tryBuildPurl({ type: "generic", name, version }));
}

/**
 * The bom-ref of the runtime component for a version.
 *
 * @param {string} version interpreter version
 * @param {string} [engine="ruby"] engine
 * @returns {string|undefined} bom-ref, which is the runtime's purl
 */
export function rubyRuntimeRef(version, engine = "ruby") {
  return createRubyRuntimeComponent(version, { engine })["bom-ref"];
}

/**
 * The properties a Ruby file component carries once its build is known. They
 * belong on unpackaged `file` components only: a package-owned Ruby is
 * identified by its package.
 *
 * @param {{version: string, source: string, patchlevel?: string, abi?: string, arch?: string}} build
 *   result of readRubyBuildVersion
 * @returns {{name: string, value: string}[]} properties to append
 */
export function rubyBuildProperties(build) {
  const properties = [
    { name: "cdx:ruby:buildVersion", value: build.version },
    { name: "cdx:ruby:buildVersionSource", value: build.source },
  ];
  if (build.patchlevel !== undefined) {
    properties.push({ name: "cdx:ruby:patchlevel", value: build.patchlevel });
  }
  if (build.abi) {
    properties.push({ name: "cdx:ruby:abiVersion", value: build.abi });
  }
  if (build.arch) {
    properties.push({ name: "cdx:ruby:platform", value: build.arch });
  }
  return properties;
}

/**
 * Start collecting the runtime components and edges of one scan.
 *
 * @returns {{runtimeComponents: Object[], dependencies: Object[], runtimeRefs: Set<string>}}
 */
export function createRubyRuntimeInventory() {
  return { runtimeComponents: [], dependencies: [], runtimeRefs: new Set() };
}

/**
 * Tag a Ruby file component with its build facts and link it to the runtime
 * component of its version, creating that component on first use. Mutates the
 * component in place.
 *
 * @param {{runtimeComponents: Object[], dependencies: Object[], runtimeRefs: Set<string>}} inventory
 *   accumulator from createRubyRuntimeInventory
 * @param {Object} component file component, with a `properties` array
 * @param {{version: string, source: string, patchlevel?: string, abi?: string, arch?: string}} build
 *   result of readRubyBuildVersion
 */
export function attachRubyBuild(inventory, component, build) {
  component.properties.push(...rubyBuildProperties(build));
  const runtime = createRubyRuntimeComponent(build.version);
  const runtimeRef = runtime["bom-ref"];
  if (!runtimeRef) {
    return;
  }
  if (!inventory.runtimeRefs.has(runtimeRef)) {
    inventory.runtimeRefs.add(runtimeRef);
    if (build.patchlevel !== undefined && build.patchlevel !== "-1") {
      runtime.properties = [
        { name: "cdx:ruby:patchlevel", value: build.patchlevel },
      ];
    }
    inventory.runtimeComponents.push(runtime);
    inventory.dependencies.push({ ref: runtimeRef, dependsOn: [] });
  }
  if (component["bom-ref"]) {
    inventory.dependencies.push({
      ref: component["bom-ref"],
      dependsOn: [runtimeRef],
    });
  }
}

// The OS packages that hold the Ruby interpreter itself. The library package
// is preferred, since libruby holds the interpreter core (Onigmo included);
// the interpreter package stands in where a distro ships no library package.
const LIBRARY_PACKAGES = [
  /^libruby\d+\.\d+(t64)?$/, // Debian, Ubuntu
  /^ruby-libs$/, // RHEL, Fedora, Alpine
  /^libruby\d+_\d+-\d+_\d+$/, // openSUSE
];
const INTERPRETER_PACKAGES = [
  /^ruby\d+\.\d+$/, // Debian, Ubuntu, openSUSE
  /^ruby-\d+\.\d+$/, // Wolfi, Chainguard
  /^ruby$/, // RHEL, Fedora, Alpine, Arch, Homebrew
  /^ruby@\d+(\.\d+)?$/, // Homebrew versioned formulae
];
const OS_PURL_TYPES = new Set([
  "deb",
  "rpm",
  "apk",
  "alpm",
  "brew",
  "chocolatey",
]);
// Package managers that ship the upstream release as built, without
// backporting fixes under an old version, so the release's CPE applies.
const UPSTREAM_BUILD_PURL_TYPES = new Set(["brew", "chocolatey"]);

function osPurlType(component) {
  const purl = component?.purl;
  if (typeof purl !== "string" || !purl.startsWith("pkg:")) {
    return undefined;
  }
  const type = purl.slice(4, purl.indexOf("/"));
  return OS_PURL_TYPES.has(type) ? type : undefined;
}

/**
 * The upstream Ruby version an OS package carries: 1:3.1.2-7+deb12u1 -> 3.1.2,
 * 3.3.10-r0 -> 3.3.10, 3.0.7-168.el9_8 -> 3.0.7, 3.4.8_1 -> 3.4.8.
 *
 * @param {string} version package version
 * @returns {string|undefined}
 */
export function upstreamRubyVersion(version) {
  if (typeof version !== "string" || !version) {
    return undefined;
  }
  let text = version;
  const colon = text.indexOf(":");
  if (colon !== -1 && /^\d+$/.test(text.slice(0, colon))) {
    text = text.slice(colon + 1);
  }
  const match = /^(\d+\.\d+\.\d+)(?=$|[-_~+])/.exec(text);
  return match ? match[1] : undefined;
}

/**
 * Describe the Ruby an OS package installed with its upstream identity,
 * `pkg:generic/ruby@<upstream>`, so a BOM names the interpreter both ways. The
 * component of a distro package carries no CPE, since distros backport fixes
 * under their old upstream version; Homebrew and Chocolatey ship the upstream
 * release, so theirs does. `cdx:os:installedBy` names the package to judge it
 * by.
 *
 * @param {Object[]} components BOM components, OS packages among them
 * @returns {Object[]} runtime components to add, one per distinct version
 */
export function deriveOsPackagedRubyRuntimes(components) {
  if (!Array.isArray(components)) {
    return [];
  }
  const osPackages = components.filter((component) => osPurlType(component));
  const pick = (patterns) =>
    osPackages.filter((component) =>
      patterns.some((pattern) => pattern.test(`${component.name || ""}`)),
    );
  let owners = pick(LIBRARY_PACKAGES);
  if (!owners.length) {
    owners = pick(INTERPRETER_PACKAGES);
  }
  const existing = new Set(
    components.map((component) => component?.["bom-ref"]),
  );
  const byRef = new Map();
  for (const owner of owners) {
    const version = upstreamRubyVersion(owner.version);
    if (!version) {
      continue;
    }
    const runtime = createRubyRuntimeComponent(version, {
      withCpe: UPSTREAM_BUILD_PURL_TYPES.has(osPurlType(owner)),
    });
    const ref = runtime["bom-ref"];
    if (!ref || existing.has(ref)) {
      continue;
    }
    const ownerRef = decodeURIComponent(owner.purl);
    const known = byRef.get(ref);
    if (known) {
      if (
        !known.properties.some(
          (prop) =>
            prop.name === "cdx:os:installedBy" && prop.value === ownerRef,
        )
      ) {
        known.properties.push({ name: "cdx:os:installedBy", value: ownerRef });
      }
      continue;
    }
    runtime.properties = [
      { name: "cdx:os:installedBy", value: ownerRef },
      { name: "cdx:ruby:buildVersionSource", value: "os-package" },
    ];
    byRef.set(ref, runtime);
  }
  return [...byRef.values()];
}

/**
 * Where the default gems of an install live: the gemspec paths
 * <prefix>/lib/ruby/gems/<abi>/specifications/default/*.gemspec.
 *
 * @param {string} gemspecPath path of a gemspec, either separator
 * @returns {{prefix: string, abi: string}|undefined} the install prefix and
 *   ABI, when the gemspec is a default gem of a lib/ruby/gems tree
 */
export function defaultGemInstall(gemspecPath) {
  if (typeof gemspecPath !== "string") {
    return undefined;
  }
  const parts = gemspecPath.replaceAll("\\", "/").split("/");
  const n = parts.length;
  if (
    n < 7 ||
    parts[n - 2] !== "default" ||
    parts[n - 3] !== "specifications" ||
    !ABI_RE.test(parts[n - 4]) ||
    parts[n - 5] !== "gems" ||
    parts[n - 6] !== "ruby" ||
    parts[n - 7] !== "lib"
  ) {
    return undefined;
  }
  return { prefix: parts.slice(0, n - 7).join("/") || "/", abi: parts[n - 4] };
}

/**
 * Globs for the contents of installed gems in the gem homes RubyGems, Bundler
 * and the distros use. A gem's sources can carry lockfiles and manifests of
 * other ecosystems (typeprof ships a VS Code extension with a
 * package-lock.json, actionview the package.json of rails-ujs) that install
 * nothing, so an image or host scan leaves them out.
 *
 * @type {string[]}
 */
export const INSTALLED_GEM_CONTENT_GLOBS = [
  "**/lib/ruby/gems/*/gems/**",
  "**/lib/ruby/gems/*/bundler/gems/**",
  "**/share/gems/gems/**",
  "**/var/lib/gems/*/gems/**",
  "**/usr/local/bundle/gems/**",
  "**/usr/local/bundle/bundler/gems/**",
  "**/vendor/bundle/ruby/*/gems/**",
  "**/vendor/bundle/ruby/*/bundler/gems/**",
  "**/.gem/ruby/*/gems/**",
  "**/.local/share/gem/ruby/*/gems/**",
  "**/.rvm/gems/*/gems/**",
];

/**
 * Whether a path lies inside an installed gem's own directory,
 * <gem home>/gems/<name>-<version>/..., beside the specifications directory of
 * that gem home. The lockfiles, manifests and nested gemspecs there belong to
 * the gem's own development, not to anything installed.
 *
 * @param {string} filePath absolute path, either separator
 * @param {function(string): boolean} exists existence check
 * @returns {boolean}
 */
export function isInsideInstalledGem(filePath, exists) {
  if (typeof filePath !== "string" || !filePath) {
    return false;
  }
  const normalized = filePath.replaceAll("\\", "/");
  const parts = normalized.split("/");
  // The file itself cannot be the gem directory, so stop two short.
  for (let i = parts.length - 3; i >= 1; i--) {
    if (parts[i] !== "gems" || !/-\d/.test(parts[i + 1] || "")) {
      continue;
    }
    const gemHome = parts.slice(0, i).join("/") || "/";
    if (exists(join(gemHome, "specifications"))) {
      return true;
    }
  }
  return false;
}

/**
 * Link the default gems of an unpackaged Ruby to the runtime they ship with.
 * The runtime is known from its `file` components, which carry the build
 * version and the path they were found at; a default gem belongs to the
 * runtime installed under the same prefix. Gems an OS package installed are
 * left to that package, as is any gem whose install has no unpackaged runtime.
 *
 * @param {Object[]} components BOM components
 * @param {string} [rootDir] extracted root the source paths may start with
 * @returns {{ref: string, dependsOn: string[]}[]} edges from each runtime to
 *   its default gems
 */
export function linkDefaultGemsToRuntimes(components, rootDir) {
  if (!Array.isArray(components)) {
    return [];
  }
  const root = rootDir
    ? `${rootDir}`.replaceAll("\\", "/").replace(/\/+$/, "")
    : undefined;
  // Paths read from an extracted image start with the extraction directory.
  const inRoot = (value) => {
    if (typeof value !== "string") {
      return value;
    }
    const normalized = value.replaceAll("\\", "/");
    return root && normalized.startsWith(`${root}/`)
      ? normalized.slice(root.length)
      : normalized;
  };
  const property = (component, name) => {
    const value = component?.properties?.find(
      (prop) => prop.name === name,
    )?.value;
    return name === "internal:SrcFile" ? inRoot(value) : value;
  };
  const runtimeByPrefix = new Map();
  const refs = new Set(components.map((component) => component?.["bom-ref"]));
  for (const component of components) {
    const version = property(component, "cdx:ruby:buildVersion");
    const srcFile = property(component, "internal:SrcFile");
    if (component?.type !== "file" || !version || !srcFile) {
      continue;
    }
    const prefix = rubyInstallPrefix(srcFile.replaceAll("\\", "/"));
    const runtimeRef = rubyRuntimeRef(version);
    if (prefix && runtimeRef && refs.has(runtimeRef)) {
      runtimeByPrefix.set(prefix, runtimeRef);
    }
  }
  if (!runtimeByPrefix.size) {
    return [];
  }
  const dependsOn = new Map();
  for (const component of components) {
    if (
      !component?.["bom-ref"] ||
      property(component, "cdx:gem:defaultGem") !== "true" ||
      property(component, "cdx:os:installedBy")
    ) {
      continue;
    }
    const install = defaultGemInstall(property(component, "internal:SrcFile"));
    const runtimeRef = install && runtimeByPrefix.get(install.prefix);
    if (!runtimeRef) {
      continue;
    }
    if (!dependsOn.has(runtimeRef)) {
      dependsOn.set(runtimeRef, new Set());
    }
    dependsOn.get(runtimeRef).add(component["bom-ref"]);
  }
  return [...dependsOn.entries()].map(([ref, gems]) => ({
    ref,
    dependsOn: [...gems].sort(),
  }));
}
