// Bounded PHP build-version reader for unpackaged PHP binaries and
// libraries. Recovers the version a source-built PHP carries, so a BOM can
// answer "does this image ship a PHP affected by CVE-2026-109618/109619".
//
// The primary marker comes from php-src: SAPI_PHP_VERSION_HEADER is
// "X-Powered-By: PHP/" PHP_VERSION and is compiled into every SAPI binary and
// libphp, e.g. the literal `X-Powered-By: PHP/8.4.26`:
// https://github.com/php/php-src/blob/php-8.4.27/main/SAPI.h#L309
// The same definition is present in 7.4 through 8.5 (main/SAPI.h at each tag).
// If a stripped or unusual build lacks it, the installed php_version.h is read
// from the same prefix. configure.ac generates its PHP_VERSION line:
// https://github.com/php/php-src/blob/php-8.4.27/configure.ac#L83-L90
// and install-headers copies it under $(phpincludedir)/main:
// https://github.com/php/php-src/blob/php-8.4.27/build/Makefile.global#L52
//
// Every file in an image is hostile: only regular files inside the extracted
// root are opened, reads are capped, and a missing/odd file yields no result
// rather than throwing.
//
// The runtime component helpers at the end are the one place a PHP version
// becomes a component, for the container scan, the OS scan and formulation.

import { closeSync, readSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import { openRegularFile } from "../core/boundedFile.js";
import { applyPurl, tryBuildPurl } from "./purl.js";

// The version grammar the contract accepts: M.m.p, optionally with -dev or an
// alpha/beta/RC number.
const VERSION_BODY = "\\d+\\.\\d+\\.\\d+(?:-dev|(?:alpha|beta|RC)\\d+)?";
const MARKER = Buffer.from("X-Powered-By: PHP/");
const MAX_VERSION_BYTES = 32;
// Overlap is at least the marker length plus 32 bytes, per the contract, so a
// marker split across two reads is seen whole by the second one.
const OVERLAP_BYTES = MARKER.length + 32;
const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

/**
 * The most PHP-named files one scan opens in search of a build version.
 *
 * @type {number}
 */
export const MAX_PHP_PROBES = 64;

// The trailing lookahead rejects 8.4.26.1 and 8.4.26foo while accepting
// 8.4.26, 8.4.26-dev and 8.6.0RC3 followed by a non-version byte.
const VERSION_PREFIX_RE = new RegExp(`^(${VERSION_BODY})(?![0-9A-Za-z.-])`);
const HEADER_VERSION_RE = new RegExp(
  `^#define\\s+PHP_VERSION\\s+"(${VERSION_BODY})"\\s*$`,
  "m",
);

/**
 * Read the version a text starts with, in the grammar the build-version reader
 * accepts: `8.4.27`, `8.5.0-dev`, `8.6.0RC3`. What follows the version must not
 * continue it, so `8.4.26.1` and `8.4.26foo` parse to nothing. A distro
 * revision such as Ubuntu's `8.1.2-1ubuntu2.14` is not an upstream version
 * either, and parses to nothing rather than to a guess.
 *
 * @param {string} text text that begins with the version
 * @returns {string|undefined} the version, or undefined when the text does not
 *   begin with one
 */
export function parsePhpVersion(text) {
  if (typeof text !== "string") {
    return undefined;
  }
  // One character past the maximum lets the lookahead see a too-long version
  // instead of treating the end of the slice as a boundary.
  const match = VERSION_PREFIX_RE.exec(text.slice(0, MAX_VERSION_BYTES + 1));
  if (!match || match[1].length > MAX_VERSION_BYTES) {
    return undefined;
  }
  return match[1];
}

// A distro package can append its revision to PHP_VERSION, as Ubuntu 22.04
// does. The digit after the hyphen tells it from PHP's own `-dev`.
const DISTRO_VERSION_RE =
  /^\d+\.\d+\.\d+-\d[0-9A-Za-z.+~-]*(?![0-9A-Za-z.+~-])/;
const MAX_REPORTED_VERSION_LENGTH = 64;

/**
 * Read the version a PHP reports about itself, as `php -v` prints it. An
 * upstream version parses as parsePhpVersion does. A version with a distro
 * revision, such as Ubuntu's `8.1.2-1ubuntu2.14`, is kept whole and marked: it
 * is what that PHP reports, but the distro backports fixes without changing the
 * upstream part, so it must not be matched against upstream advisories.
 *
 * @param {string} text text that begins with the version
 * @returns {{version: string, distroRevision: boolean}|undefined} the version,
 *   or undefined when the text does not begin with one
 */
export function parsePhpReportedVersion(text) {
  const version = parsePhpVersion(text);
  if (version) {
    return { version, distroRevision: false };
  }
  if (typeof text !== "string") {
    return undefined;
  }
  const match = DISTRO_VERSION_RE.exec(
    text.slice(0, MAX_REPORTED_VERSION_LENGTH + 1),
  );
  if (!match || match[0].length > MAX_REPORTED_VERSION_LENGTH) {
    return undefined;
  }
  return { version: match[0], distroRevision: true };
}

/**
 * The package manager whose store a path lies in. Homebrew (`Cellar/<formula>/
 * <version>/`), Nix (`nix/store/`) and Guix (`gnu/store/`) own everything under
 * their stores, whatever links lead there, and a PHP they own is identified by
 * their package, never as an unpackaged build.
 *
 * @param {string} filePath absolute or root-relative path, either separator
 * @returns {string|undefined} `homebrew`, `nix` or `guix`, or undefined
 */
export function packageStoreOf(filePath) {
  if (typeof filePath !== "string" || !filePath) {
    return undefined;
  }
  const parts = filePath.split(/[\\/]+/);
  const cellar = parts.indexOf("Cellar");
  if (cellar !== -1 && parts.length - cellar >= 4) {
    return "homebrew";
  }
  for (let index = 0; index + 2 < parts.length; index++) {
    if (parts[index + 1] !== "store") {
      continue;
    }
    if (parts[index] === "nix") {
      return "nix";
    }
    if (parts[index] === "gnu") {
      return "guix";
    }
  }
  return undefined;
}

// Installed names come from the per-SAPI Makefile.frag files at the 8.4.27
// tag: bin/php, bin/php-cgi, sbin/php-fpm, bin/phpdbg and libs/libphp.so,
// each with the optional $(program_prefix)/$(program_suffix):
// https://github.com/php/php-src/blob/php-8.4.27/sapi/cli/Makefile.frag#L9
// https://github.com/php/php-src/blob/php-8.4.27/sapi/cgi/Makefile.frag#L9
// https://github.com/php/php-src/blob/php-8.4.27/sapi/fpm/Makefile.frag#L11
// https://github.com/php/php-src/blob/php-8.4.27/sapi/phpdbg/Makefile.frag#L28
// The Apache module is libphp.so (libs/libphp.so in build/Makefile.global).
// FrankenPHP embeds PHP in its own binary.
const PHP_SAPI_BY_NAME = [
  [/^php(\d+(\.\d+)?)?$/, "cli"],
  [/^php-fpm(\d+(\.\d+)?)?$/, "fpm"],
  [/^php-cgi(\d+(\.\d+)?)?$/, "cgi"],
  [/^phpdbg(\d+(\.\d+)?)?$/, "phpdbg"],
  [/^libphp(\d+(\.\d+)?)?\.so$/, "libphp"],
  [/^frankenphp$/, "frankenphp"],
];

/**
 * Classify a file by its basename into a PHP SAPI, or undefined when the name
 * is not one php-src installs.
 *
 * @param {string} fileName basename or path of the candidate
 * @returns {string|undefined} cli, fpm, cgi, phpdbg, libphp or frankenphp
 */
export function classifyPhpSapi(fileName) {
  if (typeof fileName !== "string" || !fileName) {
    return undefined;
  }
  const name = basename(fileName);
  for (const [pattern, sapi] of PHP_SAPI_BY_NAME) {
    if (pattern.test(name)) {
      return sapi;
    }
  }
  return undefined;
}

function matchVersionAt(buffer, start, readLength) {
  if (start >= readLength) {
    return undefined;
  }
  // One byte past the maximum lets the lookahead see a too-long version
  // instead of treating the end of the slice as a boundary.
  const end = Math.min(readLength, start + MAX_VERSION_BYTES + 1);
  return parsePhpVersion(buffer.toString("latin1", start, end));
}

/**
 * Scan a bounded prefix of a binary for the compiled-in marker. Files larger
 * than the cap are skipped entirely: the contract treats them as hostile and
 * emits no property.
 *
 * @param {number} fd open file descriptor
 * @param {number} size file size from fstat
 * @returns {string|undefined}
 */
function scanBinaryVersion(fd, size) {
  if (size <= 0 || size > MAX_BINARY_BYTES) {
    return undefined;
  }
  const bufferSize = Math.min(size, READ_CHUNK_BYTES) + OVERLAP_BYTES;
  const buffer = Buffer.allocUnsafe(bufferSize);
  for (let position = 0; position < size; position += READ_CHUNK_BYTES) {
    const want = Math.min(bufferSize, size - position);
    const read = readSync(fd, buffer, 0, want, position);
    if (read <= 0) {
      return undefined;
    }
    // Only matches starting inside this window are new; the overlap exists so
    // a version split at the window edge is readable. The last window has no
    // next one, so everything it read is searched.
    const isLast = position + read >= size;
    const searchLimit = isLast ? read : Math.min(READ_CHUNK_BYTES, read);
    // Bytes a previous, longer read left past `read` are never searched.
    const window = buffer.subarray(0, read);
    let offset = window.indexOf(MARKER);
    while (offset !== -1 && offset < searchLimit) {
      const version = matchVersionAt(buffer, offset + MARKER.length, read);
      if (version) {
        return version;
      }
      offset = window.indexOf(MARKER, offset + 1);
    }
    if (read < bufferSize) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Derive the install prefix from a path installed under bin, sbin or lib:
 * /usr/local/bin/php -> /usr/local, /usr/lib/apache2/modules/libphp.so -> /usr.
 *
 * @param {string} absPath absolute path
 * @returns {string|undefined}
 */
function installPrefix(absPath) {
  const parts = resolve(absPath).split(sep);
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] === "bin" || parts[i] === "sbin" || parts[i] === "lib") {
      return parts.slice(0, i).join(sep) || sep;
    }
  }
  return undefined;
}

/**
 * Read PHP_VERSION from <prefix>/include/php/main/php_version.h. Only called
 * for files installed under bin, sbin or lib, and only when the binary marker
 * was absent.
 *
 * @param {string} absPath path of the PHP binary/library
 * @param {string|undefined} rootDir extracted root
 * @returns {string|undefined}
 */
function readHeaderVersion(absPath, rootDir) {
  const prefix = installPrefix(absPath);
  if (!prefix) {
    return undefined;
  }
  const headerPath = join(prefix, "include", "php", "main", "php_version.h");
  const opened = openRegularFile(headerPath, rootDir);
  if (!opened) {
    return undefined;
  }
  try {
    const length = Math.min(opened.size, MAX_HEADER_BYTES);
    if (length <= 0) {
      return undefined;
    }
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(opened.fd, buffer, 0, length, 0);
    if (read <= 0) {
      return undefined;
    }
    const match = HEADER_VERSION_RE.exec(buffer.toString("latin1", 0, read));
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(opened.fd);
    } catch {
      // already closed
    }
  }
}

/**
 * Read the PHP build version of a binary or shared library.
 *
 * @param {string} absPath absolute path
 * @param {string|undefined} rootDir extracted root, when the file came from one
 * @returns {{version: string, source: string}|undefined} source is `binary`
 *   or `php_version.h`
 */
export function readPhpBuildVersion(absPath, rootDir) {
  const opened = openRegularFile(absPath, rootDir);
  if (!opened) {
    return undefined;
  }
  try {
    const fromBinary = scanBinaryVersion(opened.fd, opened.size);
    if (fromBinary) {
      return { version: fromBinary, source: "binary" };
    }
  } finally {
    try {
      closeSync(opened.fd);
    } catch {
      // already closed
    }
  }
  const fromHeader = readHeaderVersion(absPath, rootDir);
  return fromHeader
    ? { version: fromHeader, source: "php_version.h" }
    : undefined;
}

/**
 * The CPE that lets a downstream scanner match a PHP version. NVD puts a
 * pre-release suffix in the update field, e.g.
 * cpe:2.3:a:php:php:8.5.0:rc1:*:*:*:*:*:* (NVD CPE dictionary).
 *
 * @param {string} version PHP version in the build-version grammar
 * @returns {string} CPE 2.3 string
 */
export function phpCpe(version) {
  const match = /^(\d+\.\d+\.\d+)(?:-(dev)|(alpha|beta|RC)(\d+))?$/.exec(
    version,
  );
  if (!match) {
    return `cpe:2.3:a:php:php:${version}:*:*:*:*:*:*:*`;
  }
  let update = "*";
  if (match[2]) {
    update = "dev";
  } else if (match[3]) {
    update = `${match[3].toLowerCase()}${match[4]}`;
  }
  return `cpe:2.3:a:php:php:${match[1]}:${update}:*:*:*:*:*:*`;
}

/**
 * A PHP runtime is one `platform` component per distinct version, like the Go
 * stdlib component. Its identity is `pkg:generic/php`: it is only used where no
 * package manager owns PHP, or where a PATH probe cannot tell which one does.
 *
 * @param {string} version PHP version in the build-version grammar, or as a
 *   distro build reports it
 * @param {Object} [options] options
 * @param {boolean} [options.withCpe=true] false for a version with a distro
 *   revision, which no upstream CPE describes
 * @returns {Object} component with `purl`, `bom-ref` and, unless left out, `cpe`
 */
export function createPhpRuntimeComponent(version, { withCpe = true } = {}) {
  const component = { type: "platform", name: "php", version };
  if (withCpe) {
    component.cpe = phpCpe(version);
  }
  return applyPurl(
    component,
    tryBuildPurl({ type: "generic", name: "php", version }),
  );
}

/**
 * The bom-ref of the runtime component for a version.
 *
 * @param {string} version PHP version in the build-version grammar
 * @returns {string} bom-ref, which is the runtime's purl
 */
export function phpRuntimeRef(version) {
  return createPhpRuntimeComponent(version)["bom-ref"];
}

/**
 * The properties a PHP file component carries once its build version is known.
 * They belong on unpackaged `file` components only: a package-owned PHP is
 * identified by its package, and distro builds carry backported fixes under
 * old version numbers, so the PHP-RCE audit rules that match these properties
 * would raise false positives there.
 *
 * @param {{version: string, source: string}} build result of readPhpBuildVersion
 * @param {string} sapi result of classifyPhpSapi
 * @returns {{name: string, value: string}[]} properties to append
 */
export function phpBuildProperties(build, sapi) {
  return [
    { name: "cdx:php:buildVersion", value: build.version },
    { name: "cdx:php:buildVersionSource", value: build.source },
    { name: "cdx:php:sapi", value: sapi },
  ];
}

/**
 * Start collecting the runtime components and edges of one scan.
 *
 * @returns {{runtimeComponents: Object[], dependencies: Object[], runtimeRefs: Set<string>}}
 */
export function createPhpRuntimeInventory() {
  return { runtimeComponents: [], dependencies: [], runtimeRefs: new Set() };
}

/**
 * Tag a PHP file component with its build facts and link it to the runtime
 * component of its version, creating that component on first use. Mutates the
 * component in place, as the Go collector does.
 *
 * @param {{runtimeComponents: Object[], dependencies: Object[], runtimeRefs: Set<string>}} inventory
 *   accumulator from createPhpRuntimeInventory
 * @param {Object} component file component, with a `properties` array
 * @param {{version: string, source: string}} build result of readPhpBuildVersion
 * @param {string} sapi result of classifyPhpSapi
 */
export function attachPhpBuild(inventory, component, build, sapi) {
  component.properties.push(...phpBuildProperties(build, sapi));
  const runtime = createPhpRuntimeComponent(build.version);
  const runtimeRef = runtime["bom-ref"];
  if (!inventory.runtimeRefs.has(runtimeRef)) {
    inventory.runtimeRefs.add(runtimeRef);
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
