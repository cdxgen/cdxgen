// Bounded reader for the .NET shared frameworks installed in a root file
// system.
//
// The .NET Docker images, dotnet-install.sh and the tarballs put the runtime
// under <dotnet root>/shared/<framework>/<version>/ without a package manager,
// so a BOM sees only its files. Each framework directory carries a
// <framework>.deps.json whose runtime target names the runtime pack it was
// built from, e.g. `Microsoft.NETCore.App.Runtime.linux-arm64/8.0.32`. That pack
// is a NuGet package, and it is the identity .NET security advisories list, so
// it becomes the component's purl.
// https://learn.microsoft.com/dotnet/core/dependency-loading/default-probing#how-are-the-properties-populated

import { closeSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { globSync } from "glob";

import { openRegularFile } from "../core/boundedFile.js";
import { applyPurl, tryBuildPurl } from "./purl.js";

const MAX_DEPS_JSON_BYTES = 8 * 1024 * 1024;
const MAX_FRAMEWORKS = 64;
const FRAMEWORKS = new Set([
  "Microsoft.NETCore.App",
  "Microsoft.AspNetCore.App",
  "Microsoft.WindowsDesktop.App",
]);
// Where the .NET images, dotnet-install.sh, the tarballs and the distro
// packages put the dotnet root.
const DOTNET_ROOTS = [
  "usr/share/dotnet",
  "usr/lib/dotnet",
  "usr/lib64/dotnet",
  "usr/local/share/dotnet",
  "opt/dotnet",
  "root/.dotnet",
  "home/*/.dotnet",
];
const RUNTIME_PACK_RE =
  /^(Microsoft\.[A-Za-z]+(?:\.[A-Za-z]+)*\.App\.Runtime\.[A-Za-z0-9.-]+)\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
// The version shape a runtime pack names, anchored for the versions a line of
// `dotnet --list-runtimes` reports.
const RUNTIME_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// The pre-release label a CPE can name: `rc` or `preview` with its number,
// written with or without a dot between the label and the number.
const PRERELEASE_LABEL_RE = /^(rc|preview)\.?(\d+)(?:[.-]|$)/;

function readJsonBounded(absPath, rootDir) {
  const opened = openRegularFile(absPath, rootDir);
  if (!opened) {
    return undefined;
  }
  try {
    if (opened.size <= 0 || opened.size > MAX_DEPS_JSON_BYTES) {
      return undefined;
    }
    const buffer = Buffer.allocUnsafe(opened.size);
    const read = readSync(opened.fd, buffer, 0, opened.size, 0);
    return JSON.parse(buffer.toString("utf8", 0, read));
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
 * Read the runtime pack a shared framework's deps.json was built from.
 *
 * @param {Object} depsJson parsed <framework>.deps.json
 * @param {string} framework framework directory name
 * @returns {{pack: string, version: string, rid: string}|undefined}
 */
export function runtimePackFromDepsJson(depsJson, framework) {
  const targetName = depsJson?.runtimeTarget?.name;
  if (typeof targetName !== "string") {
    return undefined;
  }
  const target = depsJson?.targets?.[targetName];
  if (!target || typeof target !== "object") {
    return undefined;
  }
  for (const key of Object.keys(target)) {
    const match = RUNTIME_PACK_RE.exec(key);
    if (!match?.[1].startsWith(`${framework}.Runtime.`)) {
      continue;
    }
    return {
      pack: match[1],
      version: match[2],
      rid: match[1].slice(`${framework}.Runtime.`.length),
    };
  }
  return undefined;
}

/**
 * The .NET majors whose previews NVD names `preview.<N>`. NVD names the
 * previews of every other .NET major, of ASP.NET Core and of .NET Core
 * `preview<N>`.
 */
const DOTTED_PREVIEW_MAJORS = new Set([7, 8, 10]);

/**
 * Read the pre-release tag of a runtime version.
 *
 * @param {string} version runtime version
 * @returns {{label: string, number: string}|null|undefined} the `rc` or
 *   `preview` tag and its number; undefined for a release; null for a
 *   pre-release of any other kind
 */
function dotnetPrerelease(version) {
  const dashAt = version.indexOf("-");
  if (dashAt < 0) {
    return undefined;
  }
  const tag = PRERELEASE_LABEL_RE.exec(version.slice(dashAt + 1));
  return tag ? { label: tag[1], number: tag[2] } : null;
}

/**
 * The CPE NVD uses for a shared framework version, with the version and update
 * fields spelled the way the NVD CPE dictionary spells them.
 *
 * The product is `.net` from 5.0 on, `.net_core` before it, and `asp.net_core`
 * for ASP.NET Core. NVD names a .NET Core x.y.0 release and its pre-releases
 * with two version parts (`.net_core:3.1`, `.net_core:3.0:preview9`), and the
 * .NET 5.0 pre-releases the same way (`.net:5.0:rc1`); every other version
 * keeps three. A release candidate is `rc<N>`, and a preview is
 * `preview.<N>` for .NET 7, 8 and 10 and `preview<N>` otherwise. A release
 * keeps the `*` update, which is the only one NVD lists for some releases. A
 * pre-release of any other kind names no version NVD has, so it gets no CPE.
 *
 * @param {string} framework framework directory name
 * @param {string} version runtime version
 * @returns {string|undefined} CPE 2.3 string
 */
export function dotnetCpe(framework, version) {
  const base = /^(\d+)\.(\d+)\.(\d+)/.exec(version || "");
  if (!base) {
    return undefined;
  }
  const major = Number(base[1]);
  let product;
  if (framework === "Microsoft.AspNetCore.App") {
    product = "asp.net_core";
  } else if (framework === "Microsoft.NETCore.App") {
    product = major >= 5 ? ".net" : ".net_core";
  } else {
    return undefined;
  }
  const prerelease = dotnetPrerelease(version);
  if (prerelease === null) {
    return undefined;
  }
  let update = "*";
  if (prerelease?.label === "rc") {
    update = `rc${prerelease.number}`;
  } else if (prerelease) {
    update =
      product === ".net" && DOTTED_PREVIEW_MAJORS.has(major)
        ? `preview.${prerelease.number}`
        : `preview${prerelease.number}`;
  }
  const twoPart =
    base[3] === "0" &&
    (product === ".net_core" ||
      (product === ".net" && major === 5 && prerelease !== undefined));
  const cpeVersion = twoPart ? `${base[1]}.${base[2]}` : base[0];
  return `cpe:2.3:a:microsoft:${product}:${cpeVersion}:${update}:*:*:*:*:*:*`;
}

/**
 * Create the platform component for one installed shared framework.
 *
 * @param {string} framework framework directory name
 * @param {{pack: string, version: string, rid: string}} runtime runtime pack
 * @param {string} [location] root-relative path of the deps.json. A runtime
 *   found on the scanning host gets none, since host paths can name the user's
 *   home directory.
 * @returns {Object|undefined} component, or undefined when no purl can be built
 */
export function createDotnetRuntimeComponent(framework, runtime, location) {
  const component = {
    type: "platform",
    name: runtime.pack,
    version: runtime.version,
    properties: [
      { name: "cdx:dotnet:sharedFramework", value: framework },
      { name: "cdx:dotnet:runtimeIdentifier", value: runtime.rid },
    ],
  };
  if (location) {
    component.evidence = {
      occurrences: [{ location: `/${location.replace(/^\/+/, "")}` }],
    };
  }
  const cpe = dotnetCpe(framework, runtime.version);
  if (cpe) {
    component.cpe = cpe;
  }
  const purl = tryBuildPurl({
    type: "nuget",
    name: runtime.pack,
    version: runtime.version,
  });
  if (!purl) {
    return undefined;
  }
  return applyPurl(component, purl);
}

/**
 * Parse the output of `dotnet --list-runtimes`, one `<framework> <version>
 * [<directory>]` line per installed runtime. Warnings, update notices, blank
 * lines, unknown frameworks and versions of a shape no runtime pack names are
 * left out, and no more than MAX_FRAMEWORKS runtimes are kept.
 *
 * https://learn.microsoft.com/dotnet/core/install/how-to-detect-installed-versions
 *
 * @param {string} output output of `dotnet --list-runtimes`
 * @returns {{framework: string, version: string, frameworkDir: string}[]} one
 *   entry per installed runtime
 */
export function parseDotnetListRuntimes(output) {
  const entries = [];
  if (!output) {
    return entries;
  }
  for (const rawLine of `${output}`.split(/\r?\n/)) {
    if (entries.length >= MAX_FRAMEWORKS) {
      break;
    }
    const line = rawLine.trim();
    // The directory is the text between ` [` and the trailing `]`, and can
    // contain spaces, as in `C:\Program Files\dotnet\shared\Microsoft.NETCore.App`.
    const bracketAt = line.indexOf(" [");
    if (bracketAt <= 0 || !line.endsWith("]")) {
      continue;
    }
    const head = line.slice(0, bracketAt);
    const spaceAt = head.indexOf(" ");
    if (spaceAt <= 0) {
      continue;
    }
    const framework = head.slice(0, spaceAt);
    const version = head.slice(spaceAt + 1);
    if (!FRAMEWORKS.has(framework) || !RUNTIME_VERSION_RE.test(version)) {
      continue;
    }
    const frameworkDir = line.slice(bracketAt + 2, line.length - 1);
    entries.push({ framework, version, frameworkDir });
  }
  return entries;
}

/**
 * Create the platform component for one runtime the host install reports.
 *
 * The identity comes from the deps.json in the runtime's own directory, read
 * with the directory as the root so the read cannot leave it and a symlink is
 * not followed. Only an absolute directory is read, which is what the dotnet
 * host prints. A runtime whose deps.json is missing, unreadable or names
 * another version keeps its name, its version and its CPE, without a purl:
 * without the runtime identifier of the pack there is no correct nuget purl.
 *
 * @param {{framework: string, version: string, frameworkDir: string}} entry
 *   one entry of parseDotnetListRuntimes
 * @returns {Object} platform component
 */
export function createHostDotnetRuntimeComponent(entry) {
  const depsJson = isAbsolute(entry.frameworkDir)
    ? readJsonBounded(
        join(entry.frameworkDir, entry.version, `${entry.framework}.deps.json`),
        entry.frameworkDir,
      )
    : undefined;
  const runtime = runtimePackFromDepsJson(depsJson, entry.framework);
  // The directory a runtime lives in is named after its version.
  if (runtime && runtime.version === entry.version) {
    const component = createDotnetRuntimeComponent(entry.framework, runtime);
    if (component) {
      return component;
    }
  }
  const component = {
    type: "platform",
    name: entry.framework,
    version: entry.version,
    properties: [
      { name: "cdx:dotnet:sharedFramework", value: entry.framework },
    ],
  };
  const cpe = dotnetCpe(entry.framework, entry.version);
  if (cpe) {
    component.cpe = cpe;
  }
  return component;
}

/**
 * Find the .NET shared frameworks installed under a root that no package
 * manager owns, and return one platform component per runtime pack.
 *
 * @param {string} rootDir extracted root file system
 * @param {string[]} [ownedPaths] root-relative paths a package database owns
 * @returns {Object[]} platform components
 */
export function collectDotnetRuntimes(rootDir, ownedPaths = []) {
  if (!rootDir) {
    return [];
  }
  const owned = new Set(
    (ownedPaths || []).map((p) => p.replace(/^\/+/, "").replaceAll("\\", "/")),
  );
  let depsFiles = [];
  try {
    depsFiles = globSync(
      DOTNET_ROOTS.map((root) => `${root}/shared/*/*/*.deps.json`),
      {
        cwd: rootDir,
        absolute: false,
        nodir: true,
        dot: true,
        follow: false,
      },
    )
      .map((file) => file.replaceAll("\\", "/"))
      .sort();
  } catch {
    return [];
  }
  const components = [];
  const seen = new Set();
  for (const file of depsFiles.slice(0, MAX_FRAMEWORKS)) {
    if (owned.has(file)) {
      continue;
    }
    const parts = file.split("/");
    const framework = parts[parts.length - 3];
    if (
      !FRAMEWORKS.has(framework) ||
      parts.at(-1) !== `${framework}.deps.json`
    ) {
      continue;
    }
    const runtime = runtimePackFromDepsJson(
      readJsonBounded(join(rootDir, file), rootDir),
      framework,
    );
    // The directory a runtime lives in is named after its version.
    if (!runtime || runtime.version !== parts[parts.length - 2]) {
      continue;
    }
    const component = createDotnetRuntimeComponent(framework, runtime, file);
    if (!component || seen.has(component["bom-ref"])) {
      continue;
    }
    seen.add(component["bom-ref"]);
    components.push(component);
  }
  return components;
}
