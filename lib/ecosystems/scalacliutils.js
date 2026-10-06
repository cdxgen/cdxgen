import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { DEBUG_MODE } from "../core/activity.js";
import { getAllFiles, safeExistsSync, safeSpawnSync } from "../core/fs.js";
import { isWin } from "../core/paths.js";
import { parseScalaArtifact } from "../inventory/scalaCoords.js";
import { completeComponent } from "./parsers-jvm.js";

// The scala-cli directive syntax, at the top of project.scala or any
// .scala/.sc file: //> using <key> <values...>
const DIRECTIVE_REGEX = /^\s*\/\/>\s*using\s+(\S+)\s+(.+)$/;
const DEP_KEYS = new Set([
  "dep",
  "deps",
  "dependency",
  "dependencies",
  "test.dep",
  "test.deps",
]);

function scalaBinaryVersion(scalaVersion) {
  if (!scalaVersion) {
    return null;
  }
  if (scalaVersion.startsWith("3")) {
    return "3";
  }
  if (scalaVersion.startsWith("2.13")) {
    return "2.13";
  }
  if (scalaVersion.startsWith("2.12")) {
    return "2.12";
  }
  const match = scalaVersion.match(/^2\.(\d+)/);
  return match ? `2.${match[1]}` : null;
}

/**
 * Parse the `//> using` directives of a scala-cli source file.
 *
 * @param {string} sourceFile Path of the source file
 * @returns {{ scalaVersion: string|null, platform: string|null, nativeVersion: string|null, deps: Object[] }}
 *   The declared scala version and platform, and the declared dependencies as
 *   `{ group, artifact, version, cross, test }` entries, where `cross` is
 *   `::`, `:::` or `none`
 */
export function parseScalaCliDirectives(sourceFile) {
  const result = {
    scalaVersion: null,
    platform: null,
    nativeVersion: null,
    deps: [],
  };
  let content;
  try {
    content = readFileSync(sourceFile, "utf-8");
  } catch (_err) {
    return result;
  }
  for (const line of content.split(/\r?\n/)) {
    const match = DIRECTIVE_REGEX.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1].toLowerCase();
    const values = match[2]
      .match(/"[^"]*"|\S+/g)
      ?.map((v) => v.replaceAll('"', ""))
      .filter(Boolean);
    if (!values?.length) {
      continue;
    }
    if (key === "scala") {
      result.scalaVersion = values[0];
    } else if (key === "platform") {
      result.platform = values[0];
    } else if (key === "scalanativeversion" || key === "nativeversion") {
      result.nativeVersion = values[0];
    } else if (DEP_KEYS.has(key)) {
      for (const value of values) {
        // group:artifact:version, group::artifact:version (binary version)
        // and group:::artifact:version (full cross version)
        const depMatch = /^([^:]+)(:::|::|:)([^:]+):(.+)$/.exec(value);
        if (depMatch) {
          result.deps.push({
            group: depMatch[1],
            artifact: depMatch[3],
            version: depMatch[4],
            cross: depMatch[2] === ":" ? "none" : depMatch[2],
            test: key.startsWith("test."),
          });
        } else if (DEBUG_MODE) {
          console.log(`Skipping the malformed scala-cli dependency ${value}`);
        }
      }
    }
  }
  return result;
}

/**
 * Build a component for a scala-cli dependency in the sbt purl form: the
 * Scala binary suffix is not part of the name, the platform suffix of the
 * declared platform is, and the Scala binary version is recorded as
 * cdx:scala:compilerVersion.
 *
 * @param {Object} dep Parsed dependency declaration
 * @param {Object} project Directives of the file the dependency was declared in
 * @param {string} sourceFile File the dependency was declared in
 * @returns {Object|null} The component, or null for malformed declarations
 */
export function scalaCliComponent(dep, project, sourceFile) {
  let platformSuffix = "";
  if (project.platform === "scala-js") {
    platformSuffix = "_sjs1";
  } else if (project.platform === "scala-native" && project.nativeVersion) {
    const nativeMatch = project.nativeVersion.match(/^(0\.\d+)/);
    if (nativeMatch) {
      platformSuffix = `_native${nativeMatch[1]}`;
    }
  }
  // `::` lets the tool append the binary suffix, which the sbt form drops;
  // `:::` appends the full Scala version, which the sbt form keeps. A single
  // colon names the published artifact as is, so an explicit `_3` suffix is
  // stripped like the sbt purls do.
  let name = `${dep.artifact}${platformSuffix}`;
  let binaryVersion = scalaBinaryVersion(project.scalaVersion);
  if (dep.cross === ":::" && project.scalaVersion) {
    name = `${name}_${project.scalaVersion}`;
  } else if (dep.cross === "none") {
    const scalaInfo = parseScalaArtifact(dep.artifact);
    name = scalaInfo.purlName;
    binaryVersion = scalaInfo.binaryVersion;
  }
  const component = completeComponent({
    group: dep.group,
    name,
    version: dep.version,
  });
  component.scope = dep.test ? "optional" : undefined;
  component.evidence = {
    identity: {
      field: "purl",
      confidence: 1,
      methods: [
        {
          technique: "manifest-analysis",
          confidence: 1,
          value: sourceFile,
        },
      ],
    },
  };
  // Only the Scala-published artifacts carry the compiler version; a plain
  // Java artifact declared with a single colon does not.
  if (binaryVersion) {
    component.properties = [
      {
        name: "cdx:scala:compilerVersion",
        value: binaryVersion,
      },
    ];
  }
  return component;
}

/**
 * Map a jar path of the Coursier cache to its Maven coordinates.
 *
 * Only the https cache layout with a well-known repository path segment is
 * parsed; anything else returns null rather than guessing a group id.
 *
 * @param {string} jarPath Path of a jar in the Coursier cache
 * @returns {{ group: string, name: string, version: string }|null} The coordinates
 */
export function coordinatesFromCoursierPath(jarPath) {
  if (!jarPath) {
    return null;
  }
  const segments = jarPath.split(/[\\/]/).filter(Boolean);
  const repoMarkerIndex = segments.findIndex((segment) =>
    ["maven2", "maven", "releases", "snapshots", "central"].includes(segment),
  );
  if (repoMarkerIndex === -1) {
    return null;
  }
  const version = segments[segments.length - 2];
  const artifactDir = segments[segments.length - 3];
  const jarName = segments[segments.length - 1].replace(/\.jar$/, "");
  const name = jarName.endsWith(`-${version}`)
    ? jarName.slice(0, -`-${version}`.length)
    : artifactDir;
  if (!name || !version) {
    return null;
  }
  const groupSegments = segments.slice(
    repoMarkerIndex + 1,
    segments.length - 3,
  );
  if (!groupSegments.length) {
    return null;
  }
  return {
    group: groupSegments.join("."),
    name,
    version,
  };
}

function scalaCliCommandArgs(dirPath) {
  // scala-cli is the standalone tool; the scala runner of the same toolchain
  // wraps it behind --power. Without --server=false the compile goes through
  // a Bloop daemon that outlives the scan.
  const compileArgs = [
    "compile",
    "--server=false",
    "--print-class-path",
    dirPath,
  ];
  const scalaCliProbe = safeSpawnSync(
    "scala-cli",
    ["version", "--cli-version"],
    {
      shell: isWin,
    },
  );
  if (!scalaCliProbe.error && scalaCliProbe.status === 0) {
    return { cmd: "scala-cli", args: compileArgs };
  }
  return { cmd: "scala", args: ["--power", ...compileArgs] };
}

/**
 * Collect the components a scala-cli project declares through its
 * `//> using` directives.
 *
 * Transitive dependencies are added from the class path of
 * `scala-cli compile --print-class-path` when dependency installation is
 * allowed, by mapping the Coursier cache paths back to coordinates.
 *
 * @param {string} dirPath Directory of the scala-cli project
 * @param {Object} options CLI options
 * @returns {Object[]} Component list, empty when the project declares no
 *   scala-cli directives
 */
export function collectScalaCliComponents(dirPath, options = {}) {
  const sourceFiles = [
    join(dirPath, "project.scala"),
    ...getAllFiles(dirPath, "*.scala"),
    ...getAllFiles(dirPath, "*.sc"),
  ].filter((file) => safeExistsSync(file));
  const seenFiles = new Set();
  const projects = [];
  for (const file of sourceFiles) {
    if (seenFiles.has(file)) {
      continue;
    }
    seenFiles.add(file);
    const directives = parseScalaCliDirectives(file);
    if (directives.deps.length || directives.scalaVersion) {
      projects.push({ file, directives });
    }
  }
  if (!projects.length) {
    return [];
  }
  const pkgList = [];
  const seenPurls = new Set();
  const addComponent = (component) => {
    if (component?.purl && !seenPurls.has(component.purl)) {
      seenPurls.add(component.purl);
      pkgList.push(component);
    }
  };
  for (const { file, directives } of projects) {
    for (const dep of directives.deps) {
      addComponent(scalaCliComponent(dep, directives, file));
    }
  }
  if (!pkgList.length) {
    return pkgList;
  }
  // The transitive dependencies of the declared ones come from the class
  // path the tool itself resolves; the compile requires installs to be
  // allowed.
  if (options.installDeps === false) {
    console.log(
      "Skipping the scala-cli class path resolution since dependency installation is disabled.",
    );
    return pkgList;
  }
  const { cmd, args } = scalaCliCommandArgs(dirPath);
  console.log(`Executing '${cmd} ${args.join(" ")}' in`, dirPath);
  const result = safeSpawnSync(cmd, args, {
    cwd: dirPath,
    shell: isWin,
    maxBuffer: 100 * 1024 * 1024,
    timeout: 600_000,
  });
  const classPath = (result.stdout || "")
    .trim()
    .split("\n")
    .filter((line) => line.includes(".jar"))
    .pop();
  if (!classPath) {
    if (DEBUG_MODE) {
      console.log("The scala-cli class path could not be determined.");
    }
    return pkgList;
  }
  for (const jarPath of classPath.split(delimiter)) {
    if (!jarPath.endsWith(".jar")) {
      continue;
    }
    const coordinates = coordinatesFromCoursierPath(jarPath);
    if (!coordinates) {
      continue;
    }
    const scalaInfo = parseScalaArtifact(coordinates.name);
    const component = completeComponent({
      group: coordinates.group,
      name: scalaInfo.purlName,
      version: coordinates.version,
    });
    if (scalaInfo.binaryVersion) {
      component.properties = [
        {
          name: "cdx:scala:compilerVersion",
          value: scalaInfo.binaryVersion,
        },
      ];
    }
    addComponent(component);
  }
  return pkgList;
}
