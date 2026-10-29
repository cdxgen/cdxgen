// SessionStart hook: warn once when the cdxgen CLI is missing from PATH, or is
// older than this plugin. It never installs anything and never executes
// cdxgen: the version comes from the package.json next to the binary, so the
// check stays fast and has no side effects. A cdxgen whose version cannot be
// read this way (the single-file release binaries, some shims) is accepted
// silently.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PACKAGE_NAMES = new Set(["@cdxgen/cdxgen", "@cyclonedx/cdxgen"]);

export function findOnPath(
  command,
  env = process.env,
  platform = process.platform,
) {
  const names =
    platform === "win32"
      ? [`${command}.cmd`, `${command}.exe`, `${command}.ps1`, command]
      : [command];
  const dirs = (env.PATH || env.Path || "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function readPackageVersion(file) {
  try {
    const pkg = JSON.parse(readFileSync(file, "utf-8"));
    return PACKAGE_NAMES.has(pkg.name) ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

// npm links bin/cdxgen.js into the global bin directory, so the real path
// leads back to the package. On Windows the .cmd shim sits in the npm prefix,
// with the package under node_modules next to it.
export function installedVersion(binary) {
  let real = binary;
  try {
    real = realpathSync(binary);
  } catch {
    // keep the unresolved path
  }
  let dir = path.dirname(real);
  for (let depth = 0; depth < 4; depth++) {
    const version = readPackageVersion(path.join(dir, "package.json"));
    if (version) {
      return version;
    }
    dir = path.dirname(dir);
  }
  for (const name of PACKAGE_NAMES) {
    const version = readPackageVersion(
      path.join(path.dirname(binary), "node_modules", name, "package.json"),
    );
    if (version) {
      return version;
    }
  }
  return undefined;
}

// Compares major.minor.patch only; pre-release tags are ignored.
export function isOlder(installed, expected) {
  const parts = (v) =>
    v
      .split(/[-+]/)[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(installed);
  const b = parts(expected);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) {
      return (a[i] || 0) < (b[i] || 0);
    }
  }
  return false;
}

export function check(
  pluginVersion,
  env = process.env,
  platform = process.platform,
) {
  const binary = findOnPath("cdxgen", env, platform);
  if (!binary) {
    return {
      systemMessage:
        "The cdxgen plugin needs the cdxgen CLI, which is not on PATH. Install it with `npm i -g @cdxgen/cdxgen`, or use the ghcr.io/cdxgen/cdxgen image.",
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "The cdxgen CLI is not on PATH. Before running any cdxgen command for a cdxgen skill, tell the user it is missing. Do not install it yourself.",
      },
    };
  }
  const installed = installedVersion(binary);
  if (installed && pluginVersion && isOlder(installed, pluginVersion)) {
    return {
      systemMessage: `cdxgen ${installed} is older than the cdxgen plugin (${pluginVersion}). Some skill instructions may use options it lacks. Update with \`npm i -g @cdxgen/cdxgen\`.`,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `The installed cdxgen CLI is version ${installed}, older than the plugin's ${pluginVersion}. If a command fails with an unknown option, say so instead of working around it.`,
      },
    };
  }
  return undefined;
}

function pluginVersion() {
  const manifest = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ".claude-plugin",
    "plugin.json",
  );
  try {
    return JSON.parse(readFileSync(manifest, "utf-8")).version;
  } catch {
    return undefined;
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const result = check(pluginVersion());
  if (result) {
    process.stdout.write(JSON.stringify(result));
  }
}
