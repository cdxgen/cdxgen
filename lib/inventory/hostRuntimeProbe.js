// Bounded, read-only probe for a runtime no package manager owns on a live
// host, for `-t os` / obom. osquery's package tables list what dpkg, rpm and
// the like installed, so a runtime built from source or unpacked from a
// tarball (a Docker Official image, a /usr/local or /opt build, a version
// manager's tree) is invisible to them, and with it the version an advisory is
// read against.
//
// A runtime spec names the directories to look in, a few fixed ones and never
// a walk of the file system, and how to read a build from a file. A candidate
// is opened only after the package databases have said they do not own it: a
// package manager's file is identified by its package, and distros backport
// fixes under old version numbers. Only files nothing owns are read, for their
// bytes; nothing is executed.
//
// A package database that exists but cannot be read leaves ownership unknown.
// Unknown is not unpackaged: it emits nothing and records a degradation.
//
// Logging, activity and degradation calls go through the spec's hooks, so the
// caller's module owns them and its tests can stub them.

import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import process from "node:process";

import { isReachedWithoutLinks, realPathWithin } from "../core/boundedFile.js";
import { safeExistsSync, safeReadFileSync } from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import {
  APK_INSTALLED_DB_PATHS,
  readApkInstalledDb,
} from "./apkInstalledDb.js";
import { packageStoreOf } from "./phpBuildInfo.js";
import { tryBuildPurl } from "./purl.js";

// One dpkg list, and every dpkg list together. A database past these caps
// counts as unreadable instead of being read in part; the apk database has the
// same cap in its reader.
const MAX_DATABASE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DATABASE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_DPKG_LISTS = 100000;
// Runtime-named entries read through per file a probe may keep. An entry is
// resolved before it is known to be a candidate, so the cap on candidates
// alone does not bound the entries.
const MAX_NAMES_PER_PROBE = 4;
// Paths per rpm_package_files query.
const RPM_QUERY_CHUNK = 200;

export function listDirectory(directory) {
  try {
    return readdirSync(directory).sort();
  } catch {
    return [];
  }
}

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a path is a directory itself, not a symbolic link to one.
 *
 * @param {string} path path
 * @returns {boolean}
 */
export function isPlainDirectory(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directory a root-relative pattern's symbolic links must stay inside.
 * /opt and /usr/local hold directories that accounts other than root may own,
 * so a link below them is followed only while its target stays inside them.
 *
 * @param {string} rootPath root directory
 * @param {string} pattern `/`-separated pattern relative to the root
 * @returns {string|undefined} the directory, or undefined for other patterns
 */
export function rootPatternConfine(rootPath, pattern) {
  for (const prefix of ["opt", "usr/local"]) {
    if (pattern === prefix || pattern.startsWith(`${prefix}/`)) {
      return join(rootPath, ...prefix.split("/"));
    }
  }
  return undefined;
}

/**
 * Whether a probe may read a path of a candidate directory. A directory found
 * `within` a home is read through no symbolic link below that home, whoever
 * runs the scan: a link a user left there would resolve with the scan's
 * rights, and whether it resolves at all tells whether a directory exists. A
 * directory with a `confine` is read through links only while each stays
 * inside it.
 *
 * @param {{within?: string, confine?: string}} entry candidate directory
 * @param {string} path path below the directory
 * @returns {boolean}
 */
export function isReachedSafely(entry, path) {
  if (entry?.within) {
    return isReachedWithoutLinks(entry.within, path);
  }
  if (entry?.confine) {
    return Boolean(realPathWithin(path, entry.confine));
  }
  return true;
}

function realPathOf(path) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function quoteForOsquery(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function byBomRef(a, b) {
  const left = a["bom-ref"];
  const right = b["bom-ref"];
  return left < right ? -1 : left > right ? 1 : 0;
}

function readBounded(file, maxBytes) {
  try {
    const stats = statSync(file);
    if (!stats.isFile() || stats.size > maxBytes) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const text = safeReadFileSync(file, "utf-8");
  return typeof text === "string" ? text : undefined;
}

// A package database: its name and path, `absent` when the host has none,
// `unreadable` when it has one that could not be read in full, and the paths of
// the candidates it lists.
function database(name, path, state = "ok") {
  return { name, path, state, owned: new Set(), ownerOf: new Map() };
}

// dpkg keeps one <package>.list per package, naming each path as it is on the
// system.
function scanDpkg(infoDirectory, wanted) {
  const result = database("dpkg", infoDirectory);
  if (!safeExistsSync(infoDirectory)) {
    result.state = "absent";
    return result;
  }
  const lists = listDirectory(infoDirectory).filter((name) =>
    name.endsWith(".list"),
  );
  if (!isDirectory(infoDirectory) || lists.length > MAX_DPKG_LISTS) {
    result.state = "unreadable";
  }
  let total = 0;
  for (const name of lists.slice(0, MAX_DPKG_LISTS)) {
    const text = readBounded(
      join(infoDirectory, name),
      Math.min(MAX_DATABASE_FILE_BYTES, MAX_DATABASE_TOTAL_BYTES - total),
    );
    if (text === undefined) {
      result.state = "unreadable";
      continue;
    }
    total += text.length;
    // libruby3.2:amd64.list names the package libruby3.2
    const packageName = name.slice(0, -".list".length).split(":")[0];
    for (const line of text.split("\n")) {
      if (wanted.has(line)) {
        result.owned.add(line);
        result.ownerOf.set(line, packageName);
      }
    }
  }
  return result;
}

// apk's installed database is read by the same reader the OS inventory uses, so
// the packages an OBOM lists and the files this probe treats as owned follow one
// parser. A dry run never gets here: probeHostRuntime returns before it.
function scanApk(context, wanted) {
  const { apkInstalledFile } = context.databases;
  const apk = readApkInstalledDb({
    rootPath: context.rootPath,
    databaseFile: apkInstalledFile,
    wantedFiles: wanted,
    platform: context.platform,
  });
  const result = database(
    "apk",
    apk.path ||
      apkInstalledFile ||
      join(context.rootPath, APK_INSTALLED_DB_PATHS[0]),
  );
  result.state = { ok: "ok", unreadable: "unreadable" }[apk.state] || "absent";
  for (const pkg of apk.packages) {
    for (const file of pkg.files) {
      result.owned.add(file);
      if (pkg.name) {
        result.ownerOf.set(file, pkg.name);
      }
    }
  }
  return result;
}

// osquery's rpm_package_files answers for a path without being told the
// package.
function queryRpm(databaseDirectories, wanted, executeOsQuery) {
  const result = database("rpm", databaseDirectories[0]);
  if (!databaseDirectories.some((directory) => safeExistsSync(directory))) {
    result.state = "absent";
    return result;
  }
  if (!wanted.size) {
    return result;
  }
  if (typeof executeOsQuery !== "function") {
    result.state = "unreadable";
    return result;
  }
  // The query travels as one command-line argument, which Linux caps at
  // 128 KiB, so a long list of paths is asked in chunks.
  const paths = [...wanted];
  const rows = [];
  for (let start = 0; start < paths.length; start += RPM_QUERY_CHUNK) {
    const chunk = executeOsQuery(
      `SELECT package, path FROM rpm_package_files WHERE path IN (${paths
        .slice(start, start + RPM_QUERY_CHUNK)
        .map(quoteForOsquery)
        .join(", ")})`,
    );
    if (!Array.isArray(chunk)) {
      result.state = "unreadable";
      return result;
    }
    rows.push(...chunk);
  }
  for (const row of rows) {
    if (typeof row?.path === "string") {
      result.owned.add(row.path);
      if (typeof row.package === "string" && row.package) {
        result.ownerOf.set(row.path, row.package);
      }
    }
  }
  return result;
}

// Chocolatey's database is the list of packages the OS scan has already made.
// The client is itself a package, so a Chocolatey with none listed was not
// listed: the query failed.
function readChocolatey(context) {
  const configured =
    context.readEnv("ChocolateyInstall") ||
    join(context.rootPath, "ProgramData", "chocolatey");
  const result = database("chocolatey", configured);
  if (!safeExistsSync(configured)) {
    result.state = "absent";
    return result;
  }
  const packages = (context.packageComponents || []).filter((component) =>
    component?.purl?.startsWith("pkg:chocolatey/"),
  );
  if (!packages.length) {
    result.state = "unreadable";
    return result;
  }
  result.directory = realPathOf(configured) || resolve(configured);
  result.packageNames = new Set(
    packages.map((component) => `${component.name}`.toLowerCase()),
  );
  return result;
}

// A Chocolatey package can unpack outside the package's own folder: php under
// C:\tools, nodejs.install through the Node.js MSI into Program Files. What
// makes a file Chocolatey's is the runtime's package being installed and the
// file being where Chocolatey keeps it or where the spec says the package puts
// it.
function chocolateyOwns(chocolatey, context, candidate) {
  const names = context.spec.chocolateyPackages || [];
  if (!names.some((name) => chocolatey.packageNames?.has(name))) {
    return false;
  }
  const directories = [
    chocolatey.directory,
    ...(context.spec.chocolateyDirectories?.(context) || []).map(
      (directory) => realPathOf(directory) || resolve(directory),
    ),
  ];
  const real = candidate.real.toLowerCase();
  return directories.some((directory) =>
    real.startsWith(`${directory.toLowerCase().replace(/[\\/]+$/, "")}${sep}`),
  );
}

// Folders that hold many products. An installer that names one of them as its
// own install location would otherwise claim every file below it.
const SHARED_WINDOWS_FOLDERS = new Set([
  "program files",
  "program files (x86)",
  "programdata",
  "users",
  "windows",
]);

// Windows Installer records each product's install folder; the OBOM's
// windows_programs rows carry it as install_location. A host always has some
// installed products, so with no rows at all the table was not read, and the
// installer cannot be asked.
function readWindowsInstaller(context) {
  const result = database("windows installer", "programs");
  const programs = (context.packageComponents || []).filter((component) =>
    component?.properties?.some(
      (property) =>
        property?.name === "cdx:osquery:category" &&
        property.value === "windows_programs",
    ),
  );
  if (!programs.length) {
    result.state = "absent";
    return result;
  }
  result.locations = [];
  for (const component of programs) {
    const location = component.properties.find(
      (property) => property?.name === "install_location",
    )?.value;
    if (typeof location !== "string" || !win32.isAbsolute(location)) {
      continue;
    }
    const normalized = win32
      .normalize(location)
      .replace(/\\+$/, "")
      .toLowerCase();
    const parts = normalized.split("\\").slice(1);
    if (
      !parts.length ||
      (parts.length === 1 && SHARED_WINDOWS_FOLDERS.has(parts[0]))
    ) {
      continue;
    }
    result.locations.push(`${normalized}\\`);
  }
  return result;
}

function windowsInstallerOwns(installer, candidate) {
  return [candidate.logical, candidate.listedLogical].some(
    (path) =>
      typeof path === "string" &&
      installer.locations.some((location) =>
        path.toLowerCase().startsWith(location),
      ),
  );
}

// A path as the system being described names it, and as a purl subpath. `base`
// is the directory the path hangs off, so that a symlinked root, as a temporary
// directory often is, does not matter.
function locate(context, base, absolutePath) {
  const parts = relative(base, absolutePath).split(sep);
  return {
    logical: context.pathApi.join(context.logicalRoot, ...parts),
    subpath: parts.join("/"),
  };
}

/**
 * The distinct runtime files of the spec's directories, at most `maxProbes`,
 * from at most `maxProbes * MAX_NAMES_PER_PROBE` runtime-named entries.
 * A symlink is read through to the file it names, which must itself be a
 * runtime file under the root, and two names for one file are one candidate.
 * A directory reached under several names is listed once. A directory the
 * spec gives `within` a home is read without following any symbolic link
 * below that home, and one with a `confine` only through links that stay
 * inside it. When the name budget runs out, a degradation is recorded.
 *
 * @param {Object} context probe context
 * @returns {Object[]} candidates with their real path, kind and locations
 */
function collectCandidates(context) {
  const { realRoot, platform, maxProbes, spec } = context;
  const classify = (name) => spec.classify(name, platform);
  const candidates = [];
  const seen = new Set();
  const listedDirectories = new Set();
  let names = 0;
  let budgetRecorded = false;
  for (const entry of spec.directories(context)) {
    const { directory, only, within, confine } = entry;
    // Known by device and inode, one stat, where a real path costs a stat for
    // every component. A file system without inode numbers keys by the path.
    let key;
    try {
      const stats = statSync(directory, { bigint: true });
      key = `${stats.ino ? `${stats.dev}:${stats.ino}` : directory}:${only || ""}:${within || ""}:${confine || ""}`;
    } catch {
      continue;
    }
    if (listedDirectories.has(key) || !isReachedSafely(entry, directory)) {
      continue;
    }
    listedDirectories.add(key);
    for (const name of listDirectory(directory)) {
      if (!classify(name)) {
        continue;
      }
      if (names >= maxProbes * MAX_NAMES_PER_PROBE) {
        thoughtLog(
          `The ${spec.label} host probe read through ${names} names and left any others unread.`,
        );
        if (!budgetRecorded && spec.budget?.remediationId) {
          budgetRecorded = true;
          spec.hooks.recordDegradation(spec.budget.remediationId, {
            ecosystem: spec.ecosystem,
            impact: "components",
            path: locate(context, context.rootPath, directory).logical,
            detail: `The ${spec.label} host probe stopped after ${names} entries named like a ${spec.label} runtime, so any ${spec.label} after that was not looked at. A directory with many such names, or many links to one file, uses the budget up.`,
          });
        }
        return candidates;
      }
      names++;
      const listed = join(directory, name);
      // A link in a user's home resolves with the scan's rights, so it could
      // lead to a file only root reads, or tell whether a directory exists
      if (!isReachedSafely(entry, listed)) {
        continue;
      }
      const real = realPathOf(listed);
      if (!real || seen.has(real)) {
        continue;
      }
      const kind = classify(basename(real));
      const inside = relative(realRoot, real);
      if (
        !kind ||
        (only && kind !== only) ||
        !inside ||
        inside.startsWith("..") ||
        isAbsolute(inside)
      ) {
        continue;
      }
      try {
        if (!statSync(real).isFile()) {
          continue;
        }
      } catch {
        continue;
      }
      if (candidates.length >= maxProbes) {
        thoughtLog(
          `The ${spec.label} host probe looked at ${maxProbes} files and left any others unread.`,
        );
        return candidates;
      }
      seen.add(real);
      candidates.push({
        real,
        kind,
        name: basename(real),
        ...locate(context, realRoot, real),
        listedLogical: locate(context, context.rootPath, listed).logical,
        ...(within ? { within, listed } : {}),
        ...(confine ? { confine, listed } : {}),
      });
    }
  }
  return candidates;
}

function recordUnreadable(unreadable, recorded, context) {
  if (recorded.has(unreadable.name)) {
    return;
  }
  recorded.add(unreadable.name);
  const { spec } = context;
  spec.hooks.recordDegradation(spec.remediationId, {
    ecosystem: spec.ecosystem,
    tool: unreadable.name,
    impact: "components",
    path: unreadable.path,
    detail: `The ${unreadable.name} package database could not be read in full, so ${spec.label} files it may own were not identified as unpackaged ${spec.label}.`,
  });
}

/**
 * Sort the candidates into those a package owns, those whose ownership could
 * not be settled, and the unpackaged rest.
 *
 * @param {Object[]} candidates candidates from collectCandidates
 * @param {Object} context probe context
 * @returns {{unpackaged: Object[], owned: number, unknown: number}}
 */
function classifyOwnership(candidates, context) {
  const unpackaged = [];
  const recorded = new Set();
  let owned = 0;
  let unknown = 0;
  const pending = candidates.filter((candidate) => {
    if (packageStoreOf(candidate.logical)) {
      owned++;
      return false;
    }
    return true;
  });
  if (!pending.length) {
    return { unpackaged, owned, unknown };
  }
  const wanted = new Set(
    pending.flatMap((candidate) => [
      candidate.logical,
      candidate.listedLogical,
    ]),
  );
  const databases = [];
  if (context.platform === "win32") {
    databases.push(readChocolatey(context), readWindowsInstaller(context));
  } else {
    const { dpkgInfoDirectory, rpmDatabaseDirectories } = context.databases;
    databases.push(
      scanDpkg(dpkgInfoDirectory, wanted),
      scanApk(context, wanted),
    );
    // Only what dpkg and apk did not claim is asked of osquery.
    const claimed = new Set(databases.flatMap((db) => [...db.owned]));
    databases.push(
      queryRpm(
        rpmDatabaseDirectories,
        new Set([...wanted].filter((path) => !claimed.has(path))),
        context.executeOsQuery,
      ),
    );
  }
  for (const candidate of pending) {
    const paths = [candidate.logical, candidate.listedLogical];
    const isOwned = databases.some(
      (db) =>
        db.state === "ok" &&
        (db.name === "chocolatey"
          ? chocolateyOwns(db, context, candidate)
          : db.name === "windows installer"
            ? windowsInstallerOwns(db, candidate)
            : paths.some((path) => db.owned.has(path))),
    );
    if (isOwned) {
      owned++;
      continue;
    }
    const unreadable = databases.filter((db) => db.state === "unreadable");
    if (!unreadable.length) {
      unpackaged.push(candidate);
      continue;
    }
    unknown++;
    for (const db of unreadable) {
      recordUnreadable(db, recorded, context);
    }
  }
  return { unpackaged, owned, unknown };
}

// Like a container's unpackaged files, but named by where they are: a host can
// hold several binaries of one name.
function fileComponent(candidate) {
  const purl = tryBuildPurl({
    type: "generic",
    name: candidate.name,
    subpath: candidate.subpath,
  });
  return {
    name: candidate.name,
    type: "file",
    ...(purl ? { purl } : {}),
    "bom-ref": purl ? decodeURIComponent(purl) : `file:${candidate.logical}`,
    properties: [{ name: "internal:SrcFile", value: candidate.logical }],
    evidence: {
      identity: [
        {
          field: "purl",
          confidence: 0,
          methods: [
            { technique: "filename", confidence: 0, value: candidate.logical },
          ],
          concludedValue: candidate.logical,
        },
      ],
    },
  };
}

function createContext(options, platform, readEnv, logicalRoot, spec) {
  const rootPath = options.rootPath || logicalRoot;
  const realRoot = realPathOf(rootPath);
  if (!realRoot) {
    return undefined;
  }
  const databases = options.packageDatabases || {};
  return {
    platform,
    readEnv,
    rootPath,
    realRoot,
    logicalRoot,
    pathApi: platform === "win32" ? win32 : posix,
    maxProbes: options.maxProbes || spec.maxProbes,
    spec,
    executeOsQuery: options.executeOsQuery,
    packageComponents: options.packageComponents,
    databases: {
      dpkgInfoDirectory:
        databases.dpkgInfoDirectory || join(rootPath, "var/lib/dpkg/info"),
      // Unset, the reader looks where apk keeps the database under the root.
      apkInstalledFile: databases.apkInstalledFile,
      rpmDatabaseDirectories: databases.rpmDatabaseDirectories || [
        join(rootPath, "var/lib/rpm"),
        join(rootPath, "usr/lib/sysimage/rpm"),
      ],
    },
  };
}

/**
 * Look for a runtime no package manager owns, in the directories a spec names.
 * Components come back only for the files nothing owns: a `file` component for
 * each runtime binary or library the spec could read a build from, the
 * components the spec's inventory builds from them, and the edges between them.
 *
 * @param {Object} options probe options, as probeHostPhp documents them
 * @param {Object} spec the runtime: `label`, `ecosystem`, `capability`,
 *   `remediationId` (a remediation catalog id, spelled out by the caller),
 *   `budget.remediationId` (the catalog id recorded when the name budget runs
 *   out), `maxProbes`, `directories(context)`, `classify(name, platform)`,
 *   `readBuild(context, candidate)`, `createInventory()`,
 *   `attach(inventory, component, build, candidate)`, `finish(inventory)`,
 *   optional `chocolateyPackages` and `chocolateyDirectories(context)` (where
 *   those packages unpack outside Chocolatey's folder), and `hooks` carrying
 *   the caller's
 *   `isDryRun`, `readEnvironmentVariable`, `recordActivity` and
 *   `recordDegradation`
 * @returns {{components: Object[], dependencies: Object[]}}
 */
export function probeHostRuntime(options, spec) {
  const empty = { components: [], dependencies: [] };
  const { hooks } = spec;
  const platform = options.platform || process.platform;
  const readEnv = (name) =>
    options.env ? options.env[name] : hooks.readEnvironmentVariable(name);
  const logicalRoot =
    platform === "win32" ? `${readEnv("SystemDrive") || "C:"}\\` : "/";
  if (hooks.isDryRun) {
    hooks.recordActivity({
      capability: spec.capability,
      kind: "read",
      reason: `Dry run mode blocks the ${spec.label} host probe, which opens executables and package databases outside the project.`,
      status: "blocked",
      target: options.rootPath || logicalRoot,
    });
    return empty;
  }
  const context = createContext(options, platform, readEnv, logicalRoot, spec);
  if (!context) {
    return empty;
  }
  const candidates = collectCandidates(context);
  if (!candidates.length) {
    return empty;
  }
  const { unpackaged, owned, unknown } = classifyOwnership(candidates, context);
  const inventory = spec.createInventory();
  const files = [];
  for (const candidate of unpackaged) {
    // The ownership lookups take a while; a home's file is checked again
    // right before it is read
    if (candidate.listed && !isReachedSafely(candidate, candidate.listed)) {
      continue;
    }
    const build = spec.readBuild(context, candidate);
    if (build) {
      const component = fileComponent(candidate);
      spec.attach(inventory, component, build, candidate);
      files.push(component);
    }
  }
  hooks.recordActivity({
    capability: spec.capability,
    kind: "read",
    reason: `Looked at ${candidates.length} ${spec.label} file(s) in the fixed directories: ${owned} owned by a package, ${unknown} of unknown ownership, ${files.length} unpackaged ${spec.label} identified.`,
    status: "completed",
    target: context.rootPath,
  });
  const finished = spec.finish(inventory);
  if (files.length) {
    thoughtLog(
      `I found ${files.length} unpackaged ${spec.label} file(s) on this host.`,
    );
  }
  return {
    components: [
      ...files.sort(byBomRef),
      ...finished.components.sort(byBomRef),
    ],
    dependencies: finished.dependencies,
  };
}

/**
 * Ask the package databases of a POSIX host which package owns each path.
 * The paths are named as the host names them (`/usr/lib/ruby/...`). A
 * database that exists but cannot be read is reported, so the caller can tell
 * "no owner" from "unknown".
 *
 * @param {Object} options probe options, as probeHostRuntime takes them
 * @param {string[]} paths logical paths to look up
 * @returns {{owners: Map<string, {database: string, packageName: string}>,
 *   unreadable: string[]}}
 */
export function findHostPathOwners(options, paths) {
  const owners = new Map();
  const platform = options.platform || process.platform;
  const rootPath = options.rootPath || "/";
  if (platform === "win32" || !paths?.length || !realPathOf(rootPath)) {
    return { owners, unreadable: [] };
  }
  const configured = options.packageDatabases || {};
  const context = {
    platform,
    rootPath,
    executeOsQuery: options.executeOsQuery,
    databases: {
      apkInstalledFile: configured.apkInstalledFile,
    },
  };
  const wanted = new Set(paths);
  const databases = [
    scanDpkg(
      configured.dpkgInfoDirectory || join(rootPath, "var/lib/dpkg/info"),
      wanted,
    ),
    scanApk(context, wanted),
  ];
  const claimed = new Set(databases.flatMap((db) => [...db.owned]));
  databases.push(
    queryRpm(
      configured.rpmDatabaseDirectories || [
        join(rootPath, "var/lib/rpm"),
        join(rootPath, "usr/lib/sysimage/rpm"),
      ],
      new Set([...wanted].filter((path) => !claimed.has(path))),
      options.executeOsQuery,
    ),
  );
  for (const db of databases) {
    if (db.state !== "ok") {
      continue;
    }
    for (const [path, packageName] of db.ownerOf) {
      if (!owners.has(path)) {
        owners.set(path, { database: db.name, packageName });
      }
    }
  }
  return {
    owners,
    unreadable: databases
      .filter((db) => db.state === "unreadable")
      .map((db) => db.name),
  };
}
