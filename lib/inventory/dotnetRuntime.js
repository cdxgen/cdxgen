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
import { join } from "node:path";

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
 * The CPE NVD uses for a shared framework version: `.net` from 5.0 on,
 * `.net_core` before it, and `asp.net_core` for ASP.NET Core.
 *
 * @param {string} framework framework directory name
 * @param {string} version runtime version
 * @returns {string|undefined} CPE 2.3 string
 */
export function dotnetCpe(framework, version) {
  const base = /^(\d+)\.\d+\.\d+/.exec(version || "");
  if (!base) {
    return undefined;
  }
  const plain = base[0];
  if (framework === "Microsoft.AspNetCore.App") {
    return `cpe:2.3:a:microsoft:asp.net_core:${plain}:*:*:*:*:*:*:*`;
  }
  if (framework === "Microsoft.NETCore.App") {
    const product = Number(base[1]) >= 5 ? ".net" : ".net_core";
    return `cpe:2.3:a:microsoft:${product}:${plain}:*:*:*:*:*:*:*`;
  }
  return undefined;
}

/**
 * Create the platform component for one installed shared framework.
 *
 * @param {string} framework framework directory name
 * @param {{pack: string, version: string, rid: string}} runtime runtime pack
 * @param {string} location root-relative path of the deps.json
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
    evidence: {
      occurrences: [{ location: `/${location.replace(/^\/+/, "")}` }],
    },
  };
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
