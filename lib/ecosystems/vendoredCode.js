/**
 * Code a project carries inside its own tree under a license of its own: a
 * copied library, an imported test suite. Such a directory holds its own
 * license file, and the license differs from the project's.
 *
 * Layer 3: reads license files under the scan root.
 */

import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { readScanFileText } from "../core/boundedFile.js";
import { getAllFiles } from "../core/fs.js";
import { dirKey, findEnclosingDir } from "../inventory/cmakeBuildDirs.js";
import { tryBuildPurl } from "../inventory/purl.js";
import { guessLicenseId } from "../inventory/spdx.js";

/** A license file larger than this is not a license text. */
const MAX_LICENSE_FILE_BYTES = 256 * 1024;

/**
 * Download caches and install trees that hold other projects' packages rather
 * than code the project carries. `.terraform` and `.terragrunt-cache` are
 * filled by `terraform init`/Terragrunt; their modules and providers are
 * inventoried, with their licenses, by the Terraform collector. `node_modules`
 * is filled by the npm, pnpm and Yarn installs, and its packages are
 * inventoried as `pkg:npm` components by the JavaScript collector. Reporting
 * them again as vendored directories would only duplicate those components
 * under a weaker identity. Listed explicitly because a multi-type scan may
 * have widened the shared options (`includeNodeModulesDir`), which makes the
 * glob walk dot directories and node_modules.
 */
const DOWNLOAD_CACHE_EXCLUDES = [
  "**/.terraform/**",
  "**/.terragrunt-cache/**",
  "**/node_modules/**",
];

/** Extensions a license file is written with. */
const LICENSE_EXTENSIONS = new Set(["", ".TXT", ".MD", ".RST", ".LIB"]);

/**
 * Whether a file name is a license file: `LICENSE`, `LICENCE` or `COPYING`,
 * bare, with a text extension, or with a suffix naming the license
 * (`LICENSE-MIT`).
 *
 * @param {string} name File name
 * @returns {boolean}
 */
export function isLicenseFileName(name) {
  const upper = `${name}`.toUpperCase();
  for (const stem of ["LICENSE", "LICENCE", "COPYING"]) {
    if (!upper.startsWith(stem)) {
      continue;
    }
    const rest = upper.slice(stem.length);
    if (LICENSE_EXTENSIONS.has(rest)) {
      return true;
    }
    // LICENSE-MIT, LICENSE-APACHE-2.0, LICENSE-BSD.txt; not license-checker.js
    if (/^-[A-Z0-9-]+(\.[0-9]+)*(\.(TXT|MD|RST))?$/.test(rest)) {
      return true;
    }
  }
  return false;
}

// A licence file must resolve inside the scanned root, so a vendored
// directory or file that links out of the tree is not read.
function licenseOf(file, root) {
  const text = readScanFileText(file, MAX_LICENSE_FILE_BYTES, root);
  return text === undefined ? undefined : guessLicenseId(text);
}

/** A version header or CMakeLists.txt larger than this is not read. */
const MAX_VERSION_FILE_BYTES = 256 * 1024;

// A version file must resolve inside the vendored directory.
function readSmall(file, dir) {
  return readScanFileText(file, MAX_VERSION_FILE_BYTES, dir);
}

function defineValue(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#")) {
      continue;
    }
    const parts = trimmed.replace(/^#\s*/, "").split(/\s+/);
    if (parts[0] === "define" && parts[1] === name && parts.length >= 3) {
      return parts.slice(2).join(" ").replace(/^"|"$/g, "");
    }
  }
  return undefined;
}

function numericTriple(text, names) {
  const values = names.map((name) => defineValue(text, name));
  return values.every((value) => /^\d+$/.test(value || ""))
    ? values.join(".")
    : undefined;
}

function packedBrotliVersion(value) {
  if (!/^0x[0-9a-fA-F]{1,8}$/.test(value || "")) {
    return undefined;
  }
  const packed = Number.parseInt(value, 16);
  return `${packed >>> 24}.${(packed >>> 12) & 0xfff}.${packed & 0xfff}`;
}

/**
 * Libraries that are often copied into C and C++ trees, the header each keeps
 * its version in, and the CPE NVD names it by. The header is the library's
 * own, so finding it at that path is what identifies the copy.
 */
const VENDORED_VERSION_HEADERS = [
  {
    file: "c/common/version.h",
    // 1.1 and later define MAJOR/MINOR/PATCH; 1.0.x only the packed
    // BROTLI_VERSION 0xMMMnnnppp (1.0.9 is 0x1000009).
    read: (text) =>
      numericTriple(text, [
        "BROTLI_VERSION_MAJOR",
        "BROTLI_VERSION_MINOR",
        "BROTLI_VERSION_PATCH",
      ]) || packedBrotliVersion(defineValue(text, "BROTLI_VERSION")),
    cpe: "google:brotli",
    // google/brotli 0ed4268 (CVE-2026-111497) added this error code.
    fixMarker: {
      file: "c/include/brotli/decode.h",
      text: "BLOCK_SWITCH",
      property: "cdx:brotli:c:blockSwitchFix",
    },
  },
  {
    file: "zlib.h",
    read: (text) => defineValue(text, "ZLIB_VERSION"),
    cpe: "zlib:zlib",
  },
  {
    file: "lib/zstd.h",
    read: (text) =>
      numericTriple(text, [
        "ZSTD_VERSION_MAJOR",
        "ZSTD_VERSION_MINOR",
        "ZSTD_VERSION_RELEASE",
      ]),
    cpe: "facebook:zstandard",
  },
  {
    file: "lib/lz4.h",
    read: (text) =>
      numericTriple(text, [
        "LZ4_VERSION_MAJOR",
        "LZ4_VERSION_MINOR",
        "LZ4_VERSION_RELEASE",
      ]),
    cpe: "lz4_project:lz4",
  },
  {
    file: "png.h",
    read: (text) => defineValue(text, "PNG_LIBPNG_VER_STRING"),
    cpe: "libpng:libpng",
  },
  {
    file: "sqlite3.h",
    read: (text) => defineValue(text, "SQLITE_VERSION"),
    cpe: "sqlite:sqlite",
  },
  {
    file: "lib/expat.h",
    read: (text) =>
      numericTriple(text, [
        "XML_MAJOR_VERSION",
        "XML_MINOR_VERSION",
        "XML_MICRO_VERSION",
      ]),
    cpe: "libexpat_project:libexpat",
  },
];

const PLAIN_VERSION_RE = /^\d+(\.\d+){1,3}$/;

// `project(brotli VERSION 1.2.0 LANGUAGES C)`, on one line.
function cmakeProjectVersion(dir) {
  const text = readSmall(join(dir, "CMakeLists.txt"), dir);
  if (!text) {
    return undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith("project(")) {
      continue;
    }
    const args = trimmed.slice("project(".length).split(/[\s)]+/);
    const index = args.findIndex((arg) => arg.toUpperCase() === "VERSION");
    if (index !== -1 && PLAIN_VERSION_RE.test(args[index + 1] || "")) {
      return args[index + 1];
    }
  }
  return undefined;
}

/**
 * Read the version of a vendored directory from the library's own version
 * header, else from its CMake project() call.
 *
 * @param {string} dir Absolute path of the vendored directory
 * @returns {{version?: string, source?: string, cpe?: string, properties: Object[]}|undefined}
 *   undefined when nothing is known, and without a version when only the fix
 *   marker could be read
 */
export function vendoredVersionOf(dir) {
  for (const entry of VENDORED_VERSION_HEADERS) {
    const text = readSmall(join(dir, entry.file), dir);
    if (text === undefined) {
      continue;
    }
    // The fix marker is read whether or not a version could be: a tree whose
    // version header changed shape still shows whether its decoder is fixed.
    const properties = [];
    if (entry.fixMarker) {
      const markerText = readSmall(join(dir, entry.fixMarker.file), dir);
      if (markerText !== undefined) {
        properties.push({
          name: entry.fixMarker.property,
          value: markerText.includes(entry.fixMarker.text) ? "true" : "false",
        });
      }
    }
    const version = entry.read(text);
    if (version && PLAIN_VERSION_RE.test(version)) {
      return {
        version,
        source: entry.file,
        cpe: `cpe:2.3:a:${entry.cpe}:${version}:*:*:*:*:*:*:*`,
        properties,
      };
    }
    if (properties.length) {
      return { properties };
    }
  }
  const version = cmakeProjectVersion(dir);
  return version
    ? { version, source: "CMakeLists.txt", properties: [] }
    : undefined;
}

/**
 * Directory names under which a project keeps other projects' code.
 */
const VENDORED_DIR_NAMES = new Set([
  "third_party",
  "third-party",
  "thirdparty",
  "vendor",
  "vendored",
  "external",
]);

/**
 * Whether a file lies under a directory conventionally holding another
 * project's code (`third_party/`, `vendor/`, `external/`) below the scan root.
 * Build files there belong to the copied project: building them runs that
 * project's build, and their dependencies are its build tooling.
 *
 * @param {string} root Project scan root
 * @param {string} file File path
 * @returns {boolean}
 */
export function isInVendoredDir(root, file) {
  const rel = relative(resolve(root), resolve(file));
  if (!rel || rel.startsWith("..")) {
    return false;
  }
  return rel
    .split(/[\\/]+/)
    .slice(0, -1)
    .some((segment) => VENDORED_DIR_NAMES.has(segment.toLowerCase()));
}

function licenseChoice(id) {
  return id.includes(" ") ? { expression: id } : { license: { id } };
}

/**
 * Find the directories of a project that carry code under a license other
 * than the project's.
 *
 * @param {string} root Project scan root
 * @param {Object} options CLI options (exclusions)
 * @param {string[]} [excludeDirs] Directories already known to hold
 *   dependencies (submodules, fetched sources, build trees), not searched
 * @returns {{components: Object[], dirs: string[]}} A component per vendored
 *   directory, and the directories
 */
export function findVendoredCode(root, options = {}, excludeDirs = []) {
  const absRoot = resolve(root);
  const excluded = new Set(excludeDirs.map((d) => dirKey(d)));
  const files = getAllFiles(absRoot, "**/{licen[cs]e,copying}*", {
    ...options,
    exclude: [...(options.exclude || []), ...DOWNLOAD_CACHE_EXCLUDES],
  })
    .filter((f) => isLicenseFileName(basename(f)))
    .map((f) => resolve(f))
    .filter((f) => findEnclosingDir(f, excluded) === undefined);
  const relDir = (f) => relative(absRoot, dirname(f)).split(sep).join("/");
  const rootLicenses = new Set(
    files
      .filter((f) => relDir(f) === "")
      .map((f) => licenseOf(f, absRoot))
      .filter(Boolean),
  );
  const byDepth = files
    .filter((f) => relDir(f) !== "")
    .sort(
      (a, b) =>
        relDir(a).split("/").length - relDir(b).split("/").length ||
        a.localeCompare(b),
    );
  const components = [];
  const dirs = [];
  const claimed = new Set();
  for (const file of byDepth) {
    const dir = dirname(file);
    if (findEnclosingDir(dir, claimed) !== undefined) {
      continue;
    }
    const id = licenseOf(file, absRoot);
    if (!id || rootLicenses.has(id)) {
      continue;
    }
    const path = relDir(file);
    const name = basename(dir);
    const versionInfo = vendoredVersionOf(dir);
    const purl = tryBuildPurl({
      type: "generic",
      name,
      version: versionInfo?.version || null,
      subpath: path,
    });
    const licenseFile = relative(absRoot, file).split(sep).join("/");
    const component = {
      type: "library",
      name,
      version: versionInfo?.version || "",
      licenses: [licenseChoice(id)],
      properties: [
        { name: "cdx:vendored", value: "true" },
        { name: "cdx:vendored:path", value: path },
        { name: "cdx:vendored:licenseFile", value: licenseFile },
        ...(versionInfo?.version
          ? [
              {
                name: "cdx:vendored:versionSource",
                value: `${path}/${versionInfo.source}`,
              },
            ]
          : []),
        ...(versionInfo?.properties || []),
      ],
      evidence: {
        identity: {
          field: "name",
          confidence: 0.4,
          methods: [
            { technique: "filename", confidence: 0.4, value: licenseFile },
          ],
        },
        licenses: [licenseChoice(id)],
      },
    };
    if (versionInfo?.cpe) {
      component.cpe = versionInfo.cpe;
    }
    if (purl) {
      component.purl = purl;
      component["bom-ref"] = decodeURIComponent(purl);
    } else {
      component["bom-ref"] = `vendored:${path}`;
    }
    components.push(component);
    dirs.push(dir);
    claimed.add(dirKey(dir));
  }
  return { components, dirs };
}
