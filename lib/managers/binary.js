import { Buffer } from "node:buffer";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { arch as _arch, platform as _platform, homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";

import { PackageURL } from "packageurl-js";

import {
  adjustLicenseInformation,
  collectExecutables,
  collectSharedLibs,
  DEBUG_MODE,
  dirNameStr,
  extractPathEnv,
  findLicenseId,
  getTmpDir,
  isSpdxLicenseExpression,
  multiChecksumFile,
  retrieveCdxgenPluginVersion,
  safeMkdirSync,
  safeSpawnSync,
} from "../helpers/utils.js";

const dirName = dirNameStr;
const isWin = _platform() === "win32";

function isMusl() {
  const result = safeSpawnSync("ldd", ["--version"]);
  return result?.stdout?.includes("musl") || result?.stderr?.includes("musl");
}

let platform = _platform();
let extn = "";
let pluginsBinSuffix = "";
if (platform === "win32") {
  platform = "windows";
  extn = ".exe";
} else if (platform === "linux" && isMusl()) {
  platform = "linuxmusl";
}

let arch = _arch();
switch (arch) {
  case "x32":
    arch = "386";
    break;
  case "x64":
    arch = "amd64";
    pluginsBinSuffix = `-${platform}-amd64`;
    break;
  case "arm64":
    pluginsBinSuffix = `-${platform}-arm64`;
    break;
  case "ppc64":
    arch = "ppc64le";
    pluginsBinSuffix = "-ppc64";
    break;
}

// cdxgen plugins version
const CDXGEN_PLUGINS_VERSION = retrieveCdxgenPluginVersion();

// Retrieve the cdxgen plugins directory
let CDXGEN_PLUGINS_DIR = process.env.CDXGEN_PLUGINS_DIR;
let extraNMBinPath;
// Is there a non-empty local plugins directory
if (
  !CDXGEN_PLUGINS_DIR &&
  existsSync(join(dirName, "plugins")) &&
  existsSync(join(dirName, "plugins", "trivy"))
) {
  CDXGEN_PLUGINS_DIR = join(dirName, "plugins");
}

// Is there a non-empty local node_modules directory
if (
  !CDXGEN_PLUGINS_DIR &&
  existsSync(
    join(
      dirName,
      "node_modules",
      "@cdxgen",
      `cdxgen-plugins-bin${pluginsBinSuffix}`,
      "plugins",
    ),
  ) &&
  existsSync(
    join(
      dirName,
      "node_modules",
      "@cdxgen",
      `cdxgen-plugins-bin${pluginsBinSuffix}`,
      "plugins",
      "trivy",
    ),
  )
) {
  CDXGEN_PLUGINS_DIR = join(
    dirName,
    "node_modules",
    "@cdxgen",
    `cdxgen-plugins-bin${pluginsBinSuffix}`,
    "plugins",
  );
  if (existsSync(join(dirName, "node_modules", ".bin"))) {
    extraNMBinPath = join(dirName, "node_modules", ".bin");
  }
}
if (!CDXGEN_PLUGINS_DIR) {
  let globalNodePath = process.env.GLOBAL_NODE_MODULES_PATH || undefined;
  if (!globalNodePath) {
    if (DEBUG_MODE) {
      console.log(
        `Trying to find the global node_modules path with "pnpm root -g" command.`,
      );
    }
    const result = safeSpawnSync(isWin ? "pnpm.cmd" : "pnpm", ["root", "-g"]);
    if (result) {
      const stdout = result.stdout;
      if (stdout) {
        globalNodePath = `${Buffer.from(stdout).toString().trim()}/`;
      }
    }
  }
  let globalPlugins;
  if (globalNodePath) {
    globalPlugins = join(
      globalNodePath,
      "@cdxgen",
      `cdxgen-plugins-bin${pluginsBinSuffix}`,
      "plugins",
    );
    extraNMBinPath = join(
      globalNodePath,
      "..",
      ".pnpm",
      "node_modules",
      ".bin",
    );
  }
  // pnpm add -g
  let altGlobalPlugins;
  if (dirName.includes(join("node_modules", ".pnpm", "@cyclonedx+cdxgen"))) {
    const tmpA = dirName.split(join("node_modules", ".pnpm"));
    altGlobalPlugins = join(
      tmpA[0],
      "node_modules",
      ".pnpm",
      `@cdxgen+cdxgen-plugins-bin${pluginsBinSuffix}@${CDXGEN_PLUGINS_VERSION}`,
      "node_modules",
      "@cdxgen",
      `cdxgen-plugins-bin${pluginsBinSuffix}`,
      "plugins",
    );
    if (existsSync(join(tmpA[0], "node_modules", ".bin"))) {
      extraNMBinPath = join(tmpA[0], "node_modules", ".bin");
    }
  } else if (dirName.includes(join(".pnpm", "@cyclonedx+cdxgen"))) {
    // pnpm dlx
    const tmpA = dirName.split(".pnpm");
    altGlobalPlugins = join(
      tmpA[0],
      ".pnpm",
      `@cdxgen+cdxgen-plugins-bin${pluginsBinSuffix}@${CDXGEN_PLUGINS_VERSION}`,
      "node_modules",
      "@cdxgen",
      `cdxgen-plugins-bin${pluginsBinSuffix}`,
      "plugins",
    );
    if (existsSync(join(tmpA[0], ".bin"))) {
      extraNMBinPath = join(tmpA[0], ".bin");
    }
  } else if (dirName.includes(join("caxa", "applications"))) {
    // sae binaries
    altGlobalPlugins = join(
      dirName,
      "node_modules",
      "pnpm",
      `@cdxgen+cdxgen-plugins-bin${pluginsBinSuffix}@${CDXGEN_PLUGINS_VERSION}`,
      "node_modules",
      "@cdxgen",
      `cdxgen-plugins-bin${pluginsBinSuffix}`,
      "plugins",
    );
    extraNMBinPath = join(dirName, "node_modules", ".bin");
  }
  // Set the plugins directory
  if (globalPlugins && existsSync(globalPlugins)) {
    CDXGEN_PLUGINS_DIR = globalPlugins;
    if (DEBUG_MODE) {
      console.log("Found global plugins", CDXGEN_PLUGINS_DIR);
    }
  } else if (altGlobalPlugins && existsSync(altGlobalPlugins)) {
    CDXGEN_PLUGINS_DIR = altGlobalPlugins;
    // To help detect bin commands such as atom, astgen, etc, we need to set this to the PATH variable.
    if (DEBUG_MODE) {
      console.log("Found global plugins", CDXGEN_PLUGINS_DIR);
    }
  }
}
// Set bin path for commands such as atom, astgen etc.
if (extraNMBinPath && !process.env?.PATH?.includes(extraNMBinPath)) {
  process.env.PATH = `${extraNMBinPath}${delimiter}${process.env.PATH}`;
}
if (!CDXGEN_PLUGINS_DIR) {
  if (DEBUG_MODE) {
    console.warn(
      "The optional cdxgen plugin was not found. Please install cdxgen without excluding optional dependencies if needed.",
    );
  }
  CDXGEN_PLUGINS_DIR = "";
}
let TRIVY_BIN = process.env.TRIVY_CMD;
if (existsSync(join(CDXGEN_PLUGINS_DIR, "trivy"))) {
  TRIVY_BIN = join(
    CDXGEN_PLUGINS_DIR,
    "trivy",
    `trivy-cdxgen-${platform}-${arch}${extn}`,
  );
}
let CARGO_AUDITABLE_BIN = process.env.CARGO_AUDITABLE_CMD;
if (existsSync(join(CDXGEN_PLUGINS_DIR, "cargo-auditable"))) {
  CARGO_AUDITABLE_BIN = join(
    CDXGEN_PLUGINS_DIR,
    "cargo-auditable",
    `cargo-auditable-cdxgen-${platform}-${arch}${extn}`,
  );
}
let OSQUERY_BIN = process.env.OSQUERY_CMD;
if (existsSync(join(CDXGEN_PLUGINS_DIR, "osquery"))) {
  OSQUERY_BIN = join(
    CDXGEN_PLUGINS_DIR,
    "osquery",
    `osqueryi-${platform}-${arch}${extn}`,
  );
  // osqueryi-darwin-amd64.app/Contents/MacOS/osqueryd
  if (platform === "darwin") {
    OSQUERY_BIN = `${OSQUERY_BIN}.app/Contents/MacOS/osqueryd`;
  }
}
let DOSAI_BIN = process.env.DOSAI_CMD;
if (existsSync(join(CDXGEN_PLUGINS_DIR, "dosai"))) {
  DOSAI_BIN = join(
    CDXGEN_PLUGINS_DIR,
    "dosai",
    `dosai-${platform}-${arch}${extn}`,
  );
}

// Blint bin
const BLINT_BIN = process.env.BLINT_CMD || "blint";

// sourcekitten
let SOURCEKITTEN_BIN = process.env.SOURCEKITTEN_CMD;
if (existsSync(join(CDXGEN_PLUGINS_DIR, "sourcekitten"))) {
  SOURCEKITTEN_BIN = join(CDXGEN_PLUGINS_DIR, "sourcekitten", "sourcekitten");
}

// Keep this list updated every year
const OS_DISTRO_ALIAS = {
  "ubuntu-4.10": "warty",
  "ubuntu-5.04": "hoary",
  "ubuntu-5.10": "breezy",
  "ubuntu-6.06": "dapper",
  "ubuntu-6.10": "edgy",
  "ubuntu-7.04": "feisty",
  "ubuntu-7.10": "gutsy",
  "ubuntu-8.04": "hardy",
  "ubuntu-8.10": "intrepid",
  "ubuntu-9.04": "jaunty",
  "ubuntu-9.10": "karmic",
  "ubuntu-10.04": "lucid",
  "ubuntu-10.10": "maverick",
  "ubuntu-11.04": "natty",
  "ubuntu-11.10": "oneiric",
  "ubuntu-12.04": "precise",
  "ubuntu-12.10": "quantal",
  "ubuntu-13.04": "raring",
  "ubuntu-13.10": "saucy",
  "ubuntu-14.04": "trusty",
  "ubuntu-14.10": "utopic",
  "ubuntu-15.04": "vivid",
  "ubuntu-15.10": "wily",
  "ubuntu-16.04": "xenial",
  "ubuntu-16.10": "yakkety",
  "ubuntu-17.04": "zesty",
  "ubuntu-17.10": "artful",
  "ubuntu-18.04": "bionic",
  "ubuntu-18.10": "cosmic",
  "ubuntu-19.04": "disco",
  "ubuntu-19.10": "eoan",
  "ubuntu-20.04": "focal",
  "ubuntu-20.10": "groovy",
  "ubuntu-21.04": "hirsute",
  "ubuntu-21.10": "impish",
  "ubuntu-22.04": "jammy",
  "ubuntu-22.10": "kinetic",
  "ubuntu-23.04": "lunar",
  "ubuntu-23.10": "mantic",
  "ubuntu-24.04": "noble",
  "ubuntu-24.10": "oracular",
  "ubuntu-25.04": "plucky",
  "ubuntu-25.10": "questing",
  "debian-15": "duke",
  "debian-14": "forky",
  "debian-14.5": "forky",
  "debian-13": "trixie",
  "debian-13.5": "trixie",
  "debian-12": "bookworm",
  "debian-12.5": "bookworm",
  "debian-12.6": "bookworm",
  "debian-11": "bullseye",
  "debian-11.5": "bullseye",
  "debian-10": "buster",
  "debian-10.5": "buster",
  "debian-9": "stretch",
  "debian-9.5": "stretch",
  "debian-8": "jessie",
  "debian-8.5": "jessie",
  "debian-7": "wheezy",
  "debian-7.5": "wheezy",
  "debian-6": "squeeze",
  "debian-5": "lenny",
  "debian-4": "etch",
  "debian-3.1": "sarge",
  "debian-3": "woody",
  "debian-2.2": "potato",
  "debian-2.1": "slink",
  "debian-2": "hamm",
  "debian-1.3": "bo",
  "debian-1.2": "rex",
  "debian-1.1": "buzz",
  "red hat enterprise linux": "rhel",
  "red hat enterprise linux 6": "rhel-6",
  "red hat enterprise linux 7": "rhel-7",
  "red hat enterprise linux 8": "rhel-8",
  "red hat enterprise linux 9": "rhel-9",
  "red hat enterprise linux 10": "rhel-10",
};

// TODO: Move the lists to a config file
const COMMON_RUNTIMES = [
  "java",
  "node",
  "nodejs",
  "nodejs-current",
  "deno",
  "bun",
  "python",
  "python3",
  "ruby",
  "ruby3",
  "php",
  "php7",
  "php8",
  "perl",
  "openjdk",
  "openjdk8",
  "openjdk11",
  "openjdk17",
  "openjdk21",
  "openjdk22",
  "openjdk23",
  "openjdk24",
  "openjdk25",
  "openjdk8-jdk",
  "openjdk11-jdk",
  "openjdk17-jdk",
  "openjdk21-jdk",
  "openjdk22-jdk",
  "openjdk23-jdk",
  "openjdk24-jdk",
  "openjdk25-jdk",
  "openjdk8-jre",
  "openjdk11-jre",
  "openjdk17-jre",
  "openjdk21-jre",
  "openjdk22-jre",
  "openjdk23-jre",
  "openjdk24-jre",
  "openjdk25-jre",
];

export function getCargoAuditableInfo(src) {
  if (CARGO_AUDITABLE_BIN) {
    const result = safeSpawnSync(CARGO_AUDITABLE_BIN, [src]);
    if (result.status !== 0 || result.error) {
      if (result.stdout || result.stderr) {
        console.error(result.stdout, result.stderr);
      }
    }
    if (result) {
      const stdout = result.stdout;
      if (stdout) {
        return Buffer.from(stdout).toString();
      }
    }
  }
  return undefined;
}

/**
 * Execute sourcekitten plugin with the given arguments
 *
 * @param args {Array} Arguments
 * @returns {undefined|Object} Command output
 */
export function executeSourcekitten(args) {
  if (SOURCEKITTEN_BIN) {
    const result = safeSpawnSync(SOURCEKITTEN_BIN, args);
    if (result.status !== 0 || result.error) {
      if (result.stdout || result.stderr) {
        console.error(result.stdout, result.stderr);
      }
    }
    if (result) {
      const stdout = result.stdout;
      if (stdout) {
        return JSON.parse(Buffer.from(stdout).toString());
      }
    }
  }
  return undefined;
}

/**
 * Get the packages installed in the container image filesystem.
 *
 * @param src {String} Source directory containing the extracted filesystem.
 * @param imageConfig {Object} Image configuration containing environment variables, command, entrypoints etc
 *
 * @returns {Object} Metadata containing packages, dependencies, etc
 */
export async function getOSPackages(src, imageConfig) {
  const pkgList = [];
  const dependenciesList = [];
  const allTypes = new Set();
  const bundledSdks = new Set();
  const bundledRuntimes = new Set();
  const binPaths = extractPathEnv(imageConfig?.Env);
  if (TRIVY_BIN) {
    let imageType = "image";
    const trivyCacheDir = join(homedir(), ".cache", "trivy");
    try {
      safeMkdirSync(join(trivyCacheDir, "db"), { recursive: true });
      safeMkdirSync(join(trivyCacheDir, "java-db"), { recursive: true });
    } catch (_err) {
      // ignore errors
    }
    if (existsSync(src)) {
      imageType = "rootfs";
    }
    const tempDir = mkdtempSync(join(getTmpDir(), "trivy-cdxgen-"));
    const bomJsonFile = join(tempDir, "trivy-bom.json");
    const args = [
      imageType,
      "--skip-db-update",
      "--skip-java-db-update",
      "--offline-scan",
      "--skip-files",
      "**/*.jar,**/*.war,**/*.par,**/*.ear",
      "--no-progress",
      "--exit-code",
      "0",
      "--format",
      "cyclonedx",
      "--cache-dir",
      trivyCacheDir,
      "--output",
      bomJsonFile,
    ];
    if (!DEBUG_MODE) {
      args.push("-q");
    }
    args.push(src);
    if (DEBUG_MODE) {
      console.log("Executing", TRIVY_BIN, args.join(" "));
    }
    const result = safeSpawnSync(TRIVY_BIN, args);
    if (result.status !== 0 || result.error) {
      if (result.stdout || result.stderr) {
        console.error(result.stdout, result.stderr);
      }
    }
    if (existsSync(bomJsonFile)) {
      let tmpBom = {};
      try {
        tmpBom = JSON.parse(
          readFileSync(bomJsonFile, {
            encoding: "utf-8",
          }),
        );
      } catch (_e) {
        // ignore errors
      }
      // Clean up
      if (tempDir?.startsWith(getTmpDir())) {
        if (DEBUG_MODE) {
          console.log(`Cleaning up ${tempDir}`);
        }
        if (rmSync) {
          rmSync(tempDir, { recursive: true, force: true });
        }
      }
      const osReleaseData = {};
      let osReleaseFile;
      // Let's try to read the os-release file from various locations
      if (existsSync(join(src, "etc", "os-release"))) {
        osReleaseFile = join(src, "etc", "os-release");
      } else if (existsSync(join(src, "usr", "lib", "os-release"))) {
        osReleaseFile = join(src, "usr", "lib", "os-release");
      }
      if (osReleaseFile) {
        const osReleaseInfo = readFileSync(osReleaseFile, "utf-8");
        if (osReleaseInfo) {
          osReleaseInfo.split("\n").forEach((l) => {
            if (!l.startsWith("#") && l.includes("=")) {
              const tmpA = l.split("=");
              osReleaseData[tmpA[0]] = tmpA[1].replace(/"/g, "");
            }
          });
        }
      }
      if (DEBUG_MODE) {
        console.log(osReleaseData);
      }
      let distro_codename =
        osReleaseData["VERSION_CODENAME"] ||
        osReleaseData["CENTOS_MANTISBT_PROJECT"] ||
        osReleaseData["REDHAT_BUGZILLA_PRODUCT"] ||
        osReleaseData["REDHAT_SUPPORT_PRODUCT"] ||
        "";
      distro_codename = distro_codename.toLowerCase();
      if (distro_codename.includes(" ") && OS_DISTRO_ALIAS[distro_codename]) {
        distro_codename = OS_DISTRO_ALIAS[distro_codename];
      }
      let distro_id = osReleaseData["ID"] || "";
      const distro_id_like = osReleaseData["ID_LIKE"] || "";
      let purl_type = "rpm";
      switch (distro_id) {
        case "debian":
        case "ubuntu":
        case "pop":
          purl_type = "deb";
          break;
        case "sles":
        case "suse":
        case "opensuse":
          purl_type = "rpm";
          break;
        case "alpine":
          purl_type = "apk";
          if (osReleaseData.VERSION_ID) {
            const versionParts = osReleaseData["VERSION_ID"].split(".");
            if (versionParts.length >= 2) {
              distro_codename = `alpine-${versionParts[0]}.${versionParts[1]}`;
            }
          }
          break;
        default:
          if (distro_id_like.includes("debian")) {
            purl_type = "deb";
          } else if (
            distro_id_like.includes("rhel") ||
            distro_id_like.includes("centos") ||
            distro_id_like.includes("fedora")
          ) {
            purl_type = "rpm";
          }
          break;
      }
      if (osReleaseData["VERSION_ID"]) {
        distro_id = `${distro_id}-${osReleaseData["VERSION_ID"]}`;
        if (OS_DISTRO_ALIAS[distro_id]) {
          distro_codename = OS_DISTRO_ALIAS[distro_id];
        }
      }
      const tmpDependencies = {};
      (tmpBom.dependencies || []).forEach((d) => {
        tmpDependencies[d.ref] = d.dependsOn;
      });
      if (tmpBom?.components) {
        for (const comp of tmpBom.components) {
          if (comp.purl) {
            // Retain go components alone from trivy
            if (
              /^pkg:(npm|maven|pypi|cargo|composer|gem|nuget|pub|hackage|hex|conan|clojars|github)/.test(
                comp.purl,
              )
            ) {
              continue;
            }
            const origBomRef = comp["bom-ref"];
            // Fix the group
            let group = dirname(comp.name);
            const name = basename(comp.name);
            let purlObj;
            if (group === ".") {
              group = "";
            }
            comp.group = group;
            comp.name = name;
            try {
              purlObj = PackageURL.fromString(comp.purl);
              purlObj.qualifiers = purlObj.qualifiers || {};
            } catch (_err) {
              // continue regardless of error
            }
            if (group === "") {
              try {
                if (purlObj?.namespace && purlObj.namespace !== "") {
                  group = purlObj.namespace;
                  comp.group = group;
                  purlObj.namespace = group;
                }
                if (distro_id?.length) {
                  purlObj.qualifiers["distro"] = distro_id;
                }
                if (distro_codename?.length) {
                  purlObj.qualifiers["distro_name"] = distro_codename;
                }
                // Bug fix for mageia and oracle linux
                // Type is being returned as none for ubuntu as well!
                if (purlObj?.type === "none") {
                  purlObj["type"] = purl_type;
                  purlObj["namespace"] = "";
                  comp.group = "";
                  if (comp.purl?.includes(".mga")) {
                    purlObj["namespace"] = "mageia";
                    comp.group = "mageia";
                    purlObj.qualifiers["distro"] = "mageia";
                    distro_codename = "mga";
                  }
                  comp.purl = new PackageURL(
                    purlObj.type,
                    purlObj.namespace,
                    name,
                    purlObj.version,
                    purlObj.qualifiers,
                    purlObj.subpath,
                  ).toString();
                  comp["bom-ref"] = decodeURIComponent(comp.purl);
                }
                if (purlObj?.type !== "none") {
                  allTypes.add(purlObj.type);
                }
                // Prefix distro codename for ubuntu
                if (purlObj?.qualifiers?.distro) {
                  allTypes.add(purlObj.qualifiers.distro);
                  if (OS_DISTRO_ALIAS[purlObj.qualifiers.distro]) {
                    distro_codename =
                      OS_DISTRO_ALIAS[purlObj.qualifiers.distro];
                  } else if (group === "alpine") {
                    const dtmpA = purlObj.qualifiers.distro.split(".");
                    if (dtmpA && dtmpA.length > 2) {
                      distro_codename = `${dtmpA[0]}.${dtmpA[1]}`;
                    }
                  } else if (group === "photon") {
                    const dtmpA = purlObj.qualifiers.distro.split("-");
                    if (dtmpA && dtmpA.length > 1) {
                      distro_codename = dtmpA[0];
                    }
                  } else if (group === "redhat") {
                    const dtmpA = purlObj.qualifiers.distro.split(".");
                    if (dtmpA && dtmpA.length > 1) {
                      distro_codename = dtmpA[0].replace(
                        "redhat",
                        "enterprise_linux",
                      );
                    }
                  }
                }
                if (distro_codename !== "") {
                  allTypes.add(distro_codename);
                  allTypes.add(purlObj.namespace);
                  comp.purl = new PackageURL(
                    purlObj.type,
                    purlObj.namespace,
                    name,
                    purlObj.version,
                    purlObj.qualifiers,
                    purlObj.subpath,
                  ).toString();
                  comp["bom-ref"] = decodeURIComponent(comp.purl);
                }
              } catch (_err) {
                // continue regardless of error
              }
            }
            if (comp.purl.includes("epoch=")) {
              try {
                const epoch = purlObj.qualifiers?.epoch;
                // trivy seems to be removing the epoch from the version and moving it to a qualifier
                // let's fix this hack to improve confidence.
                if (epoch) {
                  purlObj.version = `${epoch}:${purlObj.version}`;
                  comp.version = purlObj.version;
                }
                comp.evidence = {
                  identity: [
                    {
                      field: "purl",
                      confidence: 1,
                      methods: [
                        {
                          technique: "other",
                          confidence: 1,
                          value: comp.purl,
                        },
                      ],
                    },
                  ],
                };
                if (distro_id?.length) {
                  purlObj.qualifiers["distro"] = distro_id;
                }
                if (distro_codename?.length) {
                  purlObj.qualifiers["distro_name"] = distro_codename;
                }
                allTypes.add(purlObj.namespace);
                comp.purl = new PackageURL(
                  purlObj.type,
                  purlObj.namespace,
                  name,
                  purlObj.version,
                  purlObj.qualifiers,
                  purlObj.subpath,
                ).toString();
                comp["bom-ref"] = decodeURIComponent(comp.purl);
              } catch (err) {
                // continue regardless of error
                console.log(err);
              }
            }
            // Fix licenses
            if (
              comp.licenses &&
              Array.isArray(comp.licenses) &&
              comp.licenses.length
            ) {
              const newLicenses = [];
              for (const aLic of comp.licenses) {
                if (aLic?.license?.name) {
                  if (isSpdxLicenseExpression(aLic.license.name)) {
                    newLicenses.push({ expression: aLic.license.name });
                  } else {
                    const possibleId = findLicenseId(aLic.license.name);
                    if (possibleId !== aLic.license.name) {
                      newLicenses.push({ license: { id: possibleId } });
                    } else {
                      newLicenses.push({
                        license: { name: aLic.license.name },
                      });
                    }
                  }
                } else if (
                  aLic?.license &&
                  Object.keys(aLic).length &&
                  Object.keys(aLic.license).length
                ) {
                  newLicenses.push(aLic);
                }
              }
              comp.licenses = adjustLicenseInformation(newLicenses);
            }
            // Fix hashes
            if (
              comp.hashes &&
              Array.isArray(comp.hashes) &&
              comp.hashes.length
            ) {
              const hashContent = comp.hashes[0].content;
              if (!hashContent || hashContent.length < 32) {
                delete comp.hashes;
              }
            }
            const compProperties = comp.properties;
            let srcName;
            let srcVersion;
            let srcRelease;
            let epoch;
            if (compProperties && Array.isArray(compProperties)) {
              for (const aprop of compProperties) {
                // Property name: aquasecurity:trivy:SrcName
                if (aprop.name.endsWith("SrcName")) {
                  srcName = aprop.value;
                }
                // Property name: aquasecurity:trivy:SrcVersion
                if (aprop.name.endsWith("SrcVersion")) {
                  srcVersion = aprop.value;
                }
                // Property name: aquasecurity:trivy:SrcRelease
                if (aprop.name.endsWith("SrcRelease")) {
                  srcRelease = aprop.value;
                }
                // Property name: aquasecurity:trivy:SrcEpoch
                if (aprop.name.endsWith("SrcEpoch")) {
                  epoch = aprop.value;
                }
              }
            }
            // See issue #2067
            if (srcVersion && srcRelease) {
              srcVersion = `${srcVersion}-${srcRelease}`;
            }
            if (epoch) {
              srcVersion = `${epoch}:${srcVersion}`;
            }
            delete comp.properties;
            // Bug fix: We can get bom-ref like this: pkg:rpm/sles/libstdc%2B%2B6@14.2.0+git10526-150000.1.6.1?arch=x86_64&distro=sles-15.5
            if (
              comp["bom-ref"] &&
              comp.purl &&
              comp["bom-ref"] !== decodeURIComponent(comp.purl)
            ) {
              comp["bom-ref"] = decodeURIComponent(comp.purl);
            }
            pkgList.push(comp);
            detectSdksRuntimes(comp, bundledSdks, bundledRuntimes);
            const compDeps = retrieveDependencies(
              tmpDependencies,
              origBomRef,
              comp,
            );
            if (compDeps) {
              dependenciesList.push(compDeps);
            }
            // HACK: Many vulnerability databases, including vdb, track vulnerabilities based on source package names :(
            // If there is a source package defined we include it as well to make such SCA scanners work.
            // As a compromise, we reduce the confidence to zero so that there is a way to filter these out.
            if (srcName && srcVersion && srcName !== comp.name) {
              const newComp = Object.assign({}, comp);
              newComp.name = srcName;
              newComp.version = srcVersion;
              newComp.tags = ["source"];
              newComp.evidence = {
                identity: [
                  {
                    field: "purl",
                    confidence: 0,
                    methods: [
                      {
                        technique: "filename",
                        confidence: 0,
                        value: comp.name,
                      },
                    ],
                  },
                ],
              };
              // Track upstream and source versions as qualifiers
              if (purlObj) {
                const newCompQualifiers = {
                  ...purlObj.qualifiers,
                };
                delete newCompQualifiers.epoch;
                if (epoch) {
                  newCompQualifiers.epoch = epoch;
                }
                newComp.purl = new PackageURL(
                  purlObj.type,
                  purlObj.namespace,
                  srcName,
                  srcVersion,
                  newCompQualifiers,
                  purlObj.subpath,
                ).toString();
              }
              newComp["bom-ref"] = decodeURIComponent(newComp.purl);
              pkgList.push(newComp);
              detectSdksRuntimes(newComp, bundledSdks, bundledRuntimes);
            }
          }
        }
      }
    }
  }
  let executables = [];
  if (binPaths?.length) {
    executables = await fileComponents(
      src,
      collectExecutables(src, binPaths),
      "executable",
    );
  }
  // Directories containing shared libraries
  const defaultLibPaths = [
    "/lib",
    "/lib64",
    "/usr/lib",
    "/usr/lib64",
    "/usr/local/lib64",
    "/usr/local/lib",
    "/lib/x86_64-linux-gnu",
    "/usr/lib/x86_64-linux-gnu",
    "/lib/i386-linux-gnu",
    "/usr/lib/i386-linux-gnu",
    "/lib/arm-linux-gnueabihf",
    "/usr/lib/arm-linux-gnueabihf",
    "/opt/**/lib",
    "/root/**/lib",
  ];
  const sharedLibs = await fileComponents(
    src,
    collectSharedLibs(
      src,
      defaultLibPaths,
      "/etc/ld.so.conf",
      "/etc/ld.so.conf.d/*.conf",
    ),
    "shared_library",
  );
  return {
    osPackages: pkgList,
    dependenciesList,
    allTypes: Array.from(allTypes).sort(),
    bundledSdks: Array.from(bundledSdks).sort(),
    bundledRuntimes: Array.from(bundledRuntimes).sort(),
    binPaths,
    executables,
    sharedLibs,
  };
}

// Detect common sdks and runtimes from the name
function detectSdksRuntimes(comp, bundledSdks, bundledRuntimes) {
  if (!comp?.name) {
    return;
  }
  if (/dotnet[6-9]?-sdk/.test(comp.name)) {
    bundledSdks.add(comp.name);
  }
  if (
    /dotnet[6-9]?-runtime/.test(comp.name) ||
    comp.name.includes("aspnet-runtime") ||
    /aspnetcore[6-9]?-runtime/.test(comp.name)
  ) {
    bundledRuntimes.add(comp.name);
  }
  // TODO: Need to test this for a range of base images
  if (COMMON_RUNTIMES.includes(comp.name)) {
    bundledRuntimes.add(comp.name);
  }
}

const retrieveDependencies = (tmpDependencies, origBomRef, comp) => {
  try {
    const tmpDependsOn =
      tmpDependencies[origBomRef] || tmpDependencies[comp["bom-ref"]] || [];
    const dependsOn = new Set();
    tmpDependsOn.forEach((d) => {
      try {
        const compPurl = PackageURL.fromString(comp.purl);
        const tmpPurl = PackageURL.fromString(d.replace("none", compPurl.type));
        tmpPurl.type = compPurl.type;
        tmpPurl.namespace = compPurl.namespace;
        tmpPurl.qualifiers = tmpPurl.qualifiers || {};
        if (compPurl.qualifiers) {
          if (compPurl.qualifiers.distro_name) {
            tmpPurl.qualifiers.distro_name = compPurl.qualifiers.distro_name;
          }
          if (compPurl.qualifiers.distro) {
            tmpPurl.qualifiers.distro = compPurl.qualifiers.distro;
          }
        }
        if (tmpPurl.qualifiers) {
          if (
            tmpPurl.qualifiers.epoch &&
            !tmpPurl.version.startsWith(`${tmpPurl.qualifiers.epoch}:`)
          ) {
            tmpPurl.version = `${tmpPurl.qualifiers.epoch}:${tmpPurl.version}`;
          }
        }
        dependsOn.add(decodeURIComponent(tmpPurl.toString()));
      } catch (_e) {
        // ignore
      }
    });
    return { ref: comp["bom-ref"], dependsOn: Array.from(dependsOn).sort() };
  } catch (_e) {
    // ignore
  }
  return undefined;
};

export function executeOsQuery(query) {
  if (OSQUERY_BIN) {
    if (!query.endsWith(";")) {
      query = `${query};`;
    }
    const args = ["--json", query];
    // On darwin, we need to disable the safety check and run cdxgen with sudo
    // https://github.com/osquery/osquery/issues/1382
    if (platform === "darwin") {
      args.push("--allow_unsafe");
      args.push("--disable_logging");
      args.push("--disable_events");
    }
    if (DEBUG_MODE) {
      console.log("Executing", OSQUERY_BIN, args.join(" "));
    }
    const result = safeSpawnSync(OSQUERY_BIN, args);
    if (result.status !== 0 || result.error) {
      if (
        DEBUG_MODE &&
        result.stderr &&
        !result.stderr.includes("no such table")
      ) {
        console.error(result.stdout, result.stderr);
      }
    }
    if (result) {
      const stdout = result.stdout;
      if (stdout) {
        const cmdOutput = Buffer.from(stdout).toString();
        if (cmdOutput !== "") {
          try {
            return JSON.parse(cmdOutput);
          } catch (_err) {
            // ignore
            if (DEBUG_MODE) {
              console.log("Unable to parse the output from query", query);
              console.log(
                "This could be due to the amount of data returned or the query being invalid for the given platform.",
              );
            }
          }
        }
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Method to execute dosai to create slices for dotnet
 *
 * @param {string} src Source Path
 * @param {string} slicesFile Slices file name
 * @returns boolean
 */
export function getDotnetSlices(src, slicesFile) {
  if (!DOSAI_BIN) {
    return false;
  }
  const args = ["methods", "--path", src, "--o", slicesFile];
  if (DEBUG_MODE) {
    console.log("Executing", DOSAI_BIN, args.join(" "));
  }
  const result = safeSpawnSync(DOSAI_BIN, args, {
    cwd: src,
  });
  if (
    result?.stdout?.includes(
      "You must install or update .NET to run this application",
    ) ||
    result?.stderr?.includes(
      "You must install or update .NET to run this application",
    )
  ) {
    console.log(
      "Dotnet SDK is not installed. Please use the cdxgen dotnet container images to generate slices for this project.",
    );
    console.log(
      "Alternatively, download the dosai self-contained binary (-full suffix) from https://github.com/owasp-dep-scan/dosai/releases and set the environment variable DOSAI_CMD with its location.",
    );
  }
  if (result.status !== 0 || result.error) {
    if (DEBUG_MODE && result.error) {
      if (result.stderr) {
        console.error(result.stdout, result.stderr);
      } else {
        console.log("Check if dosai plugin was installed successfully.");
      }
    }
    return false;
  }
  return true;
}

/**
 * Method to generate binary SBOM using blint
 *
 * @param {string} src Path to binary or its directory
 * @param {string} binaryBomFile Path to binary
 * @param {boolean} deepMode Deep mode flag
 *
 * @return {boolean} Result of the generation
 */
export function getBinaryBom(src, binaryBomFile, deepMode) {
  if (!BLINT_BIN) {
    return false;
  }
  const args = ["sbom", "-i", resolve(src), "-o", binaryBomFile];
  if (deepMode) {
    args.push("--deep");
  }
  if (DEBUG_MODE) {
    console.log("Executing", BLINT_BIN, args.join(" "));
  }
  const lstatResult = lstatSync(src, { throwIfNoEntry: false });
  if (!lstatResult) {
    console.log(`Source path ${src} does not exist`);
    return false;
  }
  const cwd = lstatResult.isDirectory() ? src : dirname(src);
  const result = safeSpawnSync(BLINT_BIN, args, {
    cwd,
  });
  if (result.status !== 0 || result.error) {
    if (result.stderr) {
      console.error(result.stdout, result.stderr);
    } else {
      console.log(
        "Install blint using 'pip install blint' or use the cdxgen container image.",
      );
    }
    return false;
  }
  return true;
}

async function fileComponents(basePath, fileList, fileType) {
  const components = [];
  for (let f of fileList) {
    let hashes;
    try {
      const hashValues = await multiChecksumFile(
        ["md5", "sha1"],
        join(basePath, f),
      );
      hashes = [
        { alg: "MD5", content: hashValues["md5"] },
        { alg: "SHA-1", content: hashValues["sha1"] },
      ];
    } catch (_e) {
      // ignore
    }
    // Collect methods returns relative paths from the extracted directory.
    // We make them absolute by prefixing / here
    if (!f.startsWith("/")) {
      f = `/${f}`;
    }
    const name = basename(f);
    const purl = `pkg:generic/${name}`;
    let isExecutable;
    let isSetuid;
    let isSetgid;
    let isSticky;
    try {
      const stats = statSync(f);
      const mode = stats.mode;
      isExecutable = !!(mode & 0o111);
      isSetuid = !!(mode & 0o4000);
      isSetgid = !!(mode & 0o2000);
      isSticky = !!(mode & 0o1000);
    } catch (_e) {
      // ignore
    }
    const properties = [{ name: "SrcFile", value: f }];
    if (fileType === "executable" && isExecutable !== undefined) {
      properties.push({
        name: `internal:is_${fileType}`,
        value: isExecutable.toString(),
      });
    } else {
      properties.push({ name: `internal:is_${fileType}`, value: "true" });
    }
    if (isSetuid) {
      properties.push({ name: "internal:has_setuid", value: "true" });
    }
    if (isSetgid) {
      properties.push({ name: "internal:has_setgid", value: "true" });
    }
    if (isSticky) {
      properties.push({ name: "internal:has_sticky", value: "true" });
    }
    components.push({
      name,
      type: "file",
      purl,
      "bom-ref": purl,
      hashes,
      properties,
      evidence: {
        identity: [
          {
            field: "purl",
            confidence: 0,
            methods: [
              {
                technique: "filename",
                confidence: 0,
                value: f,
              },
            ],
            concludedValue: f,
          },
        ],
      },
    });
  }
  return components;
}
