/**
 * Code a project carries inside its own tree under a license of its own: a
 * copied library, an imported test suite. Such a directory holds its own
 * license file, and the license differs from the project's.
 *
 * Layer 3: reads license files under the scan root.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

import { getAllFiles } from "../core/fs.js";
import { isInsideDir } from "../inventory/cmakeBuildDirs.js";
import { tryBuildPurl } from "../inventory/purl.js";
import { guessLicenseId } from "../inventory/spdx.js";

/** A license file larger than this is not a license text. */
const MAX_LICENSE_FILE_BYTES = 256 * 1024;

/**
 * Download caches that hold other projects' packages rather than code the
 * project carries. `.terraform` and `.terragrunt-cache` are filled by
 * `terraform init`/Terragrunt; their modules and providers are inventoried,
 * with their licenses, by the Terraform collector, so reporting them again as
 * vendored directories would only duplicate those components under a weaker
 * identity. Listed explicitly because a multi-type scan may have widened the
 * shared options (`includeNodeModulesDir`) to dot directories.
 */
const DOWNLOAD_CACHE_EXCLUDES = ["**/.terraform/**", "**/.terragrunt-cache/**"];

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

function licenseOf(file) {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_LICENSE_FILE_BYTES) {
      return undefined;
    }
    return guessLicenseId(readFileSync(file, "utf-8"));
  } catch (_err) {
    return undefined;
  }
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
  const files = getAllFiles(absRoot, "**/{licen[cs]e,copying}*", {
    ...options,
    exclude: [...(options.exclude || []), ...DOWNLOAD_CACHE_EXCLUDES],
  })
    .filter((f) => isLicenseFileName(basename(f)))
    .map((f) => resolve(f))
    .filter((f) => !excludeDirs.some((d) => isInsideDir(f, d)));
  const relDir = (f) => relative(absRoot, dirname(f)).split(sep).join("/");
  const rootLicenses = new Set(
    files
      .filter((f) => relDir(f) === "")
      .map(licenseOf)
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
  for (const file of byDepth) {
    const dir = dirname(file);
    if (dirs.some((d) => isInsideDir(dir, d))) {
      continue;
    }
    const id = licenseOf(file);
    if (!id || rootLicenses.has(id)) {
      continue;
    }
    const path = relDir(file);
    const name = basename(dir);
    const purl = tryBuildPurl({ type: "generic", name, subpath: path });
    const licenseFile = relative(absRoot, file).split(sep).join("/");
    const component = {
      type: "library",
      name,
      version: "",
      licenses: [licenseChoice(id)],
      properties: [
        { name: "cdx:vendored", value: "true" },
        { name: "cdx:vendored:path", value: path },
        { name: "cdx:vendored:licenseFile", value: licenseFile },
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
    if (purl) {
      component.purl = purl;
      component["bom-ref"] = decodeURIComponent(purl);
    } else {
      component["bom-ref"] = `vendored:${path}`;
    }
    components.push(component);
    dirs.push(dir);
  }
  return { components, dirs };
}
