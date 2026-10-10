import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  sep as _sep,
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { build, Purl } from "@cdxgen/cdx-purl";
import { parse as _load } from "yaml";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { recordDegradation } from "../core/buildLedger.js";
import { deferFailOnError } from "../core/deferredExit.js";
import { shouldFetchLicense } from "../core/env.js";
import {
  safeExistsSync,
  safeSpawnSync,
  safeWriteSync,
  temporaryFiles,
} from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { isWin } from "../core/paths.js";
import { registerRunReset } from "../core/runState.js";
import { mesonWrapDB } from "../core/state.js";
import { isGitHubUrl } from "../core/urls.js";
import { parseWorkflowFile } from "../inventory/ciParsers/githubActions.js";
import {
  gatedGet,
  prefetchEnabled,
  prefetchedResponse,
  prefetchJson,
} from "../inventory/fetchBatch.js";
import {
  applyPurl,
  mapConanPkgRefToPurlStringAndNameAndVersion,
  nixGenericPurl,
  purlFromUrlString,
  tryBuildPurl,
} from "../inventory/purl.js";
import { getLicenses, spdxLicenses } from "../inventory/spdx.js";
import { cmakeFetchDependencies } from "../parsers/cmakeLists.js";
import { submodulePurlCoordinates } from "../parsers/gitmodules.js";
import { getDartMetadata } from "./ecosystems.js";
import { parsePkgJson } from "./parsers-js.js";

/**
 * Upper bound for a flake.nix `inputs = { ... }` block before the input-name
 * patterns are applied. The patterns backtrack quadratically, so an unbounded
 * attacker-crafted block is a CPU denial of service; genuine inputs blocks are
 * a few kilobytes at most.
 *
 * @type {number}
 */
const MAX_FLAKE_INPUTS_BLOCK_LENGTH = 16 * 1024;

/**
 * Whether a package registry can hold a pubspec.lock entry.
 *
 * The entry's `source` names where the package comes from. `sdk` packages ship
 * with the Dart or Flutter SDK, `path` packages live in the working tree, and
 * `git` packages come from a repository. None is published on a registry, and
 * asking about them leaks their names and imports a look-alike's metadata.
 *
 * @param {Object} packageData One pubspec.lock `packages` entry.
 * @returns {boolean}
 */
function canPubRegistryServe(packageData) {
  const source = packageData?.source;
  return source === undefined || source === "hosted";
}

/**
 * Method to parse pubspec.lock files.
 *
 * @param pubLockData Contents of lock data
 * @param lockFile Filename for setting evidence
 *
 * @returns {Object}
 */
export async function parsePubLockData(pubLockData, lockFile) {
  if (!pubLockData) {
    return [];
  }
  const pkgList = [];
  const rootList = [];
  const data = _load(pubLockData);
  const packages = data.packages;
  const lookupList = [];
  for (const [packageName, packageData] of Object.entries(packages)) {
    const pkg = {
      name: packageName,
      version: packageData.version,
      properties: [],
    };
    // older dart versions don't have sha256
    if (packageData.description?.sha256) {
      pkg._integrity = `sha256-${packageData.description?.sha256}`;
    }
    if (
      packageData.description?.url &&
      packageData.description?.url !== "https://pub.dev"
    ) {
      pkg.properties.push({
        name: "cdx:pub:registry",
        value: packageData.description.url,
      });
    }
    const purlString = new Purl({
      type: "pub",
      namespace: "" || null,
      name: pkg.name,
      version: pkg.version || null,
    })
      .toString()
      .replace(/%2F/g, "/");
    pkg["bom-ref"] = decodeURIComponent(purlString);
    if (packageData.dependency === "direct main") {
      pkg.scope = "required";
      rootList.push(pkg);
    } else if (packageData.dependency === "transitive") {
      pkg.scope = "required";
    } else if (packageData.dependency === "direct dev") {
      pkg.scope = "optional";
    }
    if (lockFile) {
      pkg.properties.push({
        name: "internal:SrcFile",
        value: lockFile,
      });
      pkg.evidence = {
        identity: {
          field: "purl",
          confidence: 1,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 1,
              value: lockFile,
            },
          ],
        },
      };
    }
    pkgList.push(pkg);
    if (canPubRegistryServe(packageData)) {
      lookupList.push(pkg);
    }
  }
  if (shouldFetchLicense()) {
    // getDartMetadata enriches in place, so the sdk, path and git packages
    // stay in pkgList with the lockfile's answers and are simply not handed
    // to it.
    await getDartMetadata(lookupList);
  }
  return { rootList, pkgList };
}

/**
 * Parses a Dart pub package's pubspec.yaml content and returns a list containing
 * a single component object with name, description, version, homepage, and purl.
 *
 * @param {string} pubYamlData Raw YAML string contents of a pubspec.yaml file
 * @returns {Object[]} List containing a single Dart package component object
 */
export function parsePubYamlData(pubYamlData) {
  const pkgList = [];
  let yamlObj;
  try {
    yamlObj = _load(pubYamlData);
  } catch (_err) {
    // continue regardless of error
  }
  if (!yamlObj) {
    return pkgList;
  }
  const pkg = {
    name: yamlObj.name,
    description: yamlObj.description,
    version: yamlObj.version,
    homepage: { url: yamlObj.homepage },
  };
  const purlString = new Purl({
    type: "pub",
    namespace: "" || null,
    name: pkg.name,
    version: pkg.version || null,
  })
    .toString()
    .replace(/%2F/g, "/");
  pkg.purl = purlString;
  pkg["bom-ref"] = decodeURIComponent(purlString);
  pkgList.push(pkg);
  return pkgList;
}

/**
 * Parses Helm chart YAML data (Chart.yaml or repository index.yaml) and returns
 * a list of Helm chart component objects including the chart itself and any
 * declared dependencies or index entries.
 *
 * @param {string} helmData Raw YAML string contents of a Helm Chart.yaml or index.yaml file
 * @returns {Object[]} List of Helm chart component objects with name, version, and optional homepage/repository
 */
export function parseHelmYamlData(helmData) {
  const pkgList = [];
  let yamlObj;
  try {
    yamlObj = _load(helmData);
  } catch (_err) {
    // continue regardless of error
  }
  if (!yamlObj) {
    return pkgList;
  }
  if (yamlObj.name && yamlObj.version) {
    const pkg = {
      name: yamlObj.name,
      description: yamlObj.description || "",
      version: yamlObj.version,
    };
    if (yamlObj.home) {
      pkg["homepage"] = { url: yamlObj.home };
    }
    pkgList.push(pkg);
  }
  if (yamlObj.dependencies) {
    for (const hd of yamlObj.dependencies) {
      const pkg = {
        name: hd.name,
        version: hd.version, // This could have * so not precise
      };
      if (hd.repository) {
        pkg["repository"] = { url: hd.repository };
      }
      pkgList.push(pkg);
    }
  }
  if (yamlObj.entries) {
    for (const he of Object.keys(yamlObj.entries)) {
      for (const key of Object.keys(yamlObj.entries[he])) {
        const hd = yamlObj.entries[he][key];
        if (hd.name && hd.version) {
          const pkg = {
            name: hd.name,
            version: hd.version,
            description: hd.description || "",
          };
          if (hd.sources && Array.isArray(hd.sources) && hd.sources.length) {
            pkg["repository"] = { url: hd.sources[0] };
            if (hd.home && hd.home !== hd.sources[0]) {
              pkg["homepage"] = { url: hd.home };
            }
          }
          if (hd.home && !pkg["homepage"]) {
            pkg["homepage"] = { url: hd.home };
          }
          if (hd.digest) {
            pkg._integrity = `sha256-${hd.digest}`;
          }

          pkgList.push(pkg);
        }
      }
    }
  }
  return pkgList;
}

/**
 * Recursively walks a parsed YAML/JSON object structure to find container image
 * references stored under common keys (image, repository, dockerImage, etc.) and
 * appends discovered image and service entries to pkgList while tracking seen
 * images in imgList to avoid duplicates.
 *
 * @param {Object|Array|string} keyValueObj The object, array, or string node to inspect
 * @param {Object[]} pkgList Accumulator array that receives {image} and {service} entries
 * @param {string[]} imgList Accumulator array of image name strings already seen
 * @returns {string[]} The updated imgList
 */
export function recurseImageNameLookup(keyValueObj, pkgList, imgList) {
  if (typeof keyValueObj === "string" || keyValueObj instanceof String) {
    return imgList;
  }
  if (Array.isArray(keyValueObj)) {
    for (const ele of keyValueObj) {
      if (typeof ele !== "string") {
        recurseImageNameLookup(ele, pkgList, imgList);
      }
    }
  } else if (Object.keys(keyValueObj).length) {
    let imageLike =
      keyValueObj.image ||
      keyValueObj.repository ||
      keyValueObj.dockerImage ||
      keyValueObj.mavenImage ||
      keyValueObj.gradleImage ||
      keyValueObj.packImage ||
      keyValueObj.koImage ||
      keyValueObj.kanikoImage;
    if (
      !imageLike &&
      keyValueObj.name &&
      typeof keyValueObj.name === "string" &&
      keyValueObj.name.includes("/")
    ) {
      imageLike = keyValueObj.name;
    }
    if (
      imageLike &&
      typeof imageLike === "string" &&
      !imgList.includes(imageLike)
    ) {
      if (imageLike.includes("VERSION")) {
        imageLike = imageLike
          .replaceAll(":${VERSION:-", ":")
          .replaceAll(":${VERSION:", ":")
          .replaceAll(":%VERSION%", ":latest")
          .replaceAll("}", "");
      }
      pkgList.push({ image: imageLike });
      pkgList.push({ service: keyValueObj.name || imageLike });
      imgList.push(imageLike);
    }
    for (const key of Object.keys(keyValueObj)) {
      // Skip unwanted blocks to improve performance
      if (["schema", "openAPIV3Schema", "names", "status"].includes(key)) {
        continue;
      }
      const valueObj = keyValueObj[key];
      if (!valueObj) {
        continue;
      }
      if (Object.keys(valueObj).length && typeof valueObj !== "string") {
        recurseImageNameLookup(valueObj, pkgList, imgList);
      }
      if (Array.isArray(valueObj)) {
        for (const ele of valueObj) {
          if (typeof ele !== "string") {
            recurseImageNameLookup(ele, pkgList, imgList);
          }
        }
      }
    }
  }
  return imgList;
}

function substituteBuildArgs(statement, buildArgs) {
  for (const argMatch of [
    ...statement.matchAll(/\${?([^:\/\\}]+)}?/g),
  ].reverse()) {
    const fullArgName = argMatch[0];
    const argName = argMatch[1];
    const argIndex = argMatch.index;
    if (buildArgs.has(argName)) {
      statement =
        statement.slice(0, argIndex) +
        buildArgs.get(argName) +
        statement.slice(argIndex + fullArgName.length);
    }
  }
  return statement;
}

/**
 * Parses the contents of a Dockerfile or Containerfile and returns a list of
 * base image objects referenced by FROM instructions, substituting ARG default
 * values where possible and skipping multi-stage build alias references.
 *
 * @param {string} fileContents Raw string contents of the Dockerfile/Containerfile
 * @returns {Object[]} Array of objects with an image property for each unique base image
 */
export function parseContainerFile(fileContents) {
  const buildArgs = new Map();
  const imagesSet = new Set();
  const buildStageNames = [];
  for (let line of fileContents.split("\n")) {
    line = line.trim();

    if (line.startsWith("#")) {
      continue; // skip commented out lines
    }

    if (line.startsWith("ARG")) {
      const argStatement = line.split("ARG ")[1].split("=");

      if (argStatement.length < 2) {
        continue; // skip ARG statements without default value
      }

      const argName = argStatement[0].trim();
      let argValue = argStatement[1].trim().replace(/['"]+/g, "");
      if (argValue.includes("$")) {
        argValue = substituteBuildArgs(argValue, buildArgs);
      }
      buildArgs.set(argName, argValue);
    }

    if (line.startsWith("FROM")) {
      // The alias could be called AS or as
      const fromStatement = line.split("FROM ")[1].split(/\s(as|AS)\s/);

      let imageStatement = fromStatement[0].trim();
      const buildStageName =
        fromStatement.length > 1
          ? fromStatement[fromStatement.length - 1].trim()
          : undefined;
      if (buildStageNames.includes(imageStatement)) {
        if (DEBUG_MODE) {
          console.log(
            `Skipping image ${imageStatement} which uses previously seen build stage name.`,
          );
        }
        continue;
      }
      if (imageStatement.includes("$")) {
        imageStatement = substituteBuildArgs(imageStatement, buildArgs);
        if (imageStatement.includes("$")) {
          if (DEBUG_MODE) {
            console.log(
              `Unable to substitute build arguments in '${line}' statement.`,
            );
          }
          continue;
        }
      }
      imagesSet.add(imageStatement);

      if (buildStageName) {
        buildStageNames.push(buildStageName);
      }
    }
  }

  return Array.from(imagesSet).map((i) => {
    return { image: i };
  });
}

/**
 * Parses a Bitbucket Pipelines YAML file and extracts all Docker image references
 * used as build environments and pipe references (docker:// pipes are normalized).
 *
 * @param {string} fileContents Raw string contents of the bitbucket-pipelines.yml file
 * @returns {Object[]} Array of objects with an image property for each referenced image or pipe
 */
export function parseBitbucketPipelinesFile(fileContents) {
  const imgList = [];

  let privateImageBlockFound = false;

  for (let line of fileContents.split("\n")) {
    line = line.trim();
    if (line.startsWith("#")) {
      continue; // skip commented out lines
    }

    // Assume this is a private build image object
    if (line.startsWith("name:") && privateImageBlockFound) {
      const imageName = line.split("name:").pop().trim();

      imgList.push({
        image: imageName,
      });

      privateImageBlockFound = false;
    }

    // Docker image usage
    if (line.startsWith("image:")) {
      const imageName = line.split("image:").pop().trim();

      /**
       * Assume this is a private build image object
       * See: https://support.atlassian.com/bitbucket-cloud/docs/use-docker-images-as-build-environments/#Using-private-build-images
       */
      if (imageName === "") {
        privateImageBlockFound = true;
        continue;
      }
      /**
       * Assume this is a public build image
       * See: https://support.atlassian.com/bitbucket-cloud/docs/use-docker-images-as-build-environments/#Using-public-build-images
       */

      imgList.push({
        image: imageName,
      });
    }

    // Pipe usage
    if (line.startsWith("- pipe:")) {
      let pipeName = line.split("- pipe:").pop().trim();

      if (pipeName.startsWith("docker://")) {
        pipeName = pipeName.replace("docker://", "");
      }

      imgList.push({
        image: pipeName,
      });
    }
  }

  return imgList;
}

/**
 * Parses container specification data such as Docker Compose files, Kubernetes
 * manifests, Tekton tasks, Skaffold configs, or Kustomize overlays (YAML, possibly
 * multi-document) and returns a list of image, service, and OCI spec entries.
 *
 * @param {string} dcData Raw YAML string contents of the container spec file
 * @returns {Object[]} Array of objects with image, service, or ociSpec properties
 */
export function parseContainerSpecData(dcData) {
  const pkgList = [];
  const imgList = [];
  if (!dcData.includes("image") && !dcData.includes("kind")) {
    return pkgList;
  }
  let dcDataList = [dcData];
  if (dcData.includes("---")) {
    dcDataList = dcData.split("---");
  }
  for (const dcData of dcDataList) {
    let yamlObj;
    try {
      yamlObj = _load(dcData);
    } catch (_err) {
      // ignore errors
    }
    if (!yamlObj) {
      continue;
    }
    if (yamlObj.services) {
      for (const serv of Object.keys(yamlObj.services)) {
        pkgList.push({
          service: serv,
        });
        const aservice = yamlObj.services[serv];
        // Track locally built images
        if (aservice.build) {
          if (Object.keys(aservice.build).length && aservice.build.dockerfile) {
            pkgList.push({
              ociSpec: aservice.build.dockerfile,
            });
          } else {
            if (aservice.build === "." || aservice.build === "./") {
              pkgList.push({
                ociSpec: "Dockerfile",
              });
            } else {
              pkgList.push({
                ociSpec: aservice.build,
              });
            }
          }
        } else if (aservice.image && !imgList.includes(aservice.image)) {
          let imgFullName = aservice.image;
          if (imgFullName.includes(":${VERSION:")) {
            imgFullName = imgFullName
              .replaceAll(":${VERSION:-", ":")
              .replaceAll(":${VERSION:", ":")
              .replaceAll("}", "");
          }
          pkgList.push({
            image: imgFullName,
          });
          imgList.push(imgFullName);
        }
      }
    }
    // Tekton tasks and kustomize have spec. Skaffold has build
    const recurseBlock = yamlObj.spec || yamlObj.build || yamlObj.images;
    if (recurseBlock) {
      recurseImageNameLookup(recurseBlock, pkgList, imgList);
    }
  }
  return pkgList;
}

/**
 * Identifies the data flow direction of a Privado processing object based on its
 * sinkId value: "write" sinks map to "inbound", "read" sinks to "outbound", and
 * HTTP/gRPC sinks to "bi-directional".
 *
 * @param {Object} processingObj Privado processing object, expected to have a sinkId property
 * @returns {string} Flow direction string: "inbound", "outbound", "bi-directional", or "unknown"
 */
export function identifyFlow(processingObj) {
  let flow = "unknown";
  if (processingObj.sinkId) {
    const sinkId = processingObj.sinkId.toLowerCase();
    if (sinkId.endsWith("write")) {
      flow = "inbound";
    } else if (sinkId.endsWith("read")) {
      flow = "outbound";
    } else if (sinkId.includes("http") || sinkId.includes("grpc")) {
      flow = "bi-directional";
    }
  }
  return flow;
}

function convertProcessing(processing_list) {
  const data_list = [];
  for (const p of processing_list) {
    data_list.push({
      classification: p.sourceId || p.sinkId,
      flow: identifyFlow(p),
    });
  }
  return data_list;
}

/**
 * Parses a Privado data flow JSON file and returns a list of service objects
 * enriched with data classifications, endpoints, trust-boundary flag, violations,
 * and git metadata properties extracted from the scan result.
 *
 * @param {string} f Path to the Privado scan result JSON file
 * @returns {Object[]} List of service component objects suitable for a SaaSBOM
 */
export function parsePrivadoFile(f) {
  const pData = readFileSync(f, { encoding: "utf-8" });
  const servlist = [];
  if (!pData) {
    return servlist;
  }
  const jsonData = JSON.parse(pData);
  const aservice = {
    "x-trust-boundary": false,
    properties: [],
    data: [],
    endpoints: [],
  };
  if (jsonData.repoName) {
    aservice.name = jsonData.repoName;
    aservice.properties = [
      {
        name: "internal:SrcFile",
        value: f,
      },
    ];
    // Capture git metadata info
    if (jsonData.gitMetadata) {
      aservice.version = jsonData.gitMetadata.commitId || "";
      aservice.properties.push({
        name: "internal:privadoCoreVersion",
        value: jsonData.privadoCoreVersion || "",
      });
      aservice.properties.push({
        name: "internal:privadoCLIVersion",
        value: jsonData.privadoCLIVersion || "",
      });
      aservice.properties.push({
        name: "internal:localScanPath",
        value: jsonData.localScanPath || "",
      });
    }
    // Capture processing
    if (jsonData.processing?.length) {
      aservice.data = aservice.data.concat(
        convertProcessing(jsonData.processing),
      );
    }
    // Capture sink processing
    if (jsonData.sinkProcessing?.length) {
      aservice.data = aservice.data.concat(
        convertProcessing(jsonData.sinkProcessing),
      );
    }
    // Find endpoints
    if (jsonData.collections) {
      const endpoints = [];
      for (const c of jsonData.collections) {
        for (const occ of c.collections) {
          for (const e of occ.occurrences) {
            if (e.endPoint) {
              endpoints.push(e.endPoint);
            }
          }
        }
      }
      aservice.endpoints = endpoints;
    }
    // Capture violations
    if (jsonData.violations) {
      for (const v of jsonData.violations) {
        aservice.properties.push({
          name: "internal:privado_violations",
          value: v.policyId,
        });
      }
    }
    // If there are third party libraries detected, then there are cross boundary calls happening
    if (jsonData.dataFlow?.third_parties?.length) {
      aservice["x-trust-boundary"] = true;
    }
    servlist.push(aservice);
  }
  return servlist;
}

/**
 * Parses an OpenAPI specification (JSON or YAML string) and returns a list
 * containing a single service object with name, version, endpoints, and
 * authentication flag derived from the spec's info, servers, paths, and
 * securitySchemes sections.
 *
 * @param {string} oaData Raw JSON or YAML string contents of an OpenAPI specification
 * @returns {Object[]} List containing a single service component object
 */
export function parseOpenapiSpecData(oaData) {
  const servlist = [];
  if (!oaData) {
    return servlist;
  }
  try {
    if (oaData.startsWith("openapi:")) {
      oaData = _load(oaData);
    } else {
      oaData = JSON.parse(oaData);
    }
  } catch (_e) {
    return servlist;
  }

  const name = oaData.info?.title
    ? oaData.info.title.replace(/ /g, "-")
    : "default-name";
  const version = oaData.info?.version ? oaData.info.version : "latest";
  const aservice = {
    "bom-ref": `urn:service:${name}:${version}`,
    name,
    description: oaData.description || "",
    version,
  };
  let serverName = [];
  if (oaData.servers?.length && oaData.servers[0].url) {
    serverName = oaData.servers[0].url;
    if (!serverName.startsWith("http") || !serverName.includes("//")) {
      serverName = `http://${serverName}`;
    }
  }
  if (oaData.paths) {
    const endpoints = [];
    for (const route of Object.keys(oaData.paths)) {
      let sep = "";
      if (!route.startsWith("/")) {
        sep = "/";
      }
      endpoints.push(`${serverName}${sep}${route}`);
    }
    aservice.endpoints = endpoints;
  }
  let authenticated = false;
  if (oaData.components?.securitySchemes) {
    authenticated = true;
  }
  aservice.authenticated = authenticated;
  servlist.push(aservice);
  return servlist;
}

/**
 * Parses Haskell Cabal freeze file content and extracts package name and version
 * pairs from constraint lines (lines containing " ==").
 *
 * @param {string} cabalData Raw string contents of a Cabal freeze file
 * @returns {Object[]} List of package objects with name and version fields
 */
export function parseCabalData(cabalData) {
  const pkgList = [];
  if (!cabalData) {
    return pkgList;
  }
  cabalData.split("\n").forEach((l) => {
    if (!l.includes(" ==")) {
      return;
    }
    l = l.replaceAll("\r", "");
    if (l.includes(" ==")) {
      const tmpA = l.split(" ==");
      const name = tmpA[0]
        .replace(/^constraints: /, "")
        .replace(/^any\./, "")
        .trim();
      const version = tmpA[1].replace(",", "").trim();
      if (name && version) {
        pkgList.push({
          name,
          version,
        });
      }
    }
  });
  return pkgList;
}

/**
 * Parses an Elixir mix.lock file and extracts Hex package name and version pairs
 * from lines containing ":hex".
 *
 * @param {string} mixData Raw string contents of a mix.lock file
 * @returns {Object[]} List of package objects with name and version fields
 */
export function parseMixLockData(mixData) {
  const pkgList = [];
  if (!mixData) {
    return pkgList;
  }
  mixData.split("\n").forEach((l) => {
    if (!l.includes(":hex")) {
      return;
    }
    l = l.replaceAll("\r", "");
    if (l.includes(":hex")) {
      const tmpA = l.split(",");
      if (tmpA.length > 3) {
        const name = tmpA[1].replace(/^\s*:/, "").trim();
        const version = tmpA[2].trim().replace(/"/g, "");
        if (name && version) {
          pkgList.push({
            name,
            version,
          });
        }
      }
    }
  });
  return pkgList;
}

/**
 * Parses a GitHub Actions workflow YAML file and returns a list of action
 * components for each step that uses an external action (steps with a "uses"
 * field). Each component captures the action name, group, version/commit SHA,
 * version pinning type, job context (runner, permissions, environment), and
 * workflow-level metadata (triggers, concurrency, write permissions).
 *
 * @param {string} f Path to the GitHub Actions workflow YAML file
 * @returns {Object[]} List of action component objects with purl, properties, and evidence
 */
export function parseGitHubWorkflowData(f) {
  const { components } = parseWorkflowFile(f);
  return components.filter(
    (component) =>
      component.scope === "required" ||
      component.properties?.some(
        (property) =>
          property?.name === "cdx:github:step:usesCargo" &&
          property?.value === "true",
      ),
  );
}

/**
 * Parse Google Cloud Build YAML data and extract container image steps as packages.
 *
 * @param {string} cbwData Raw YAML string of a Cloud Build configuration file
 * @returns {Object[]} Array of package objects parsed from the build steps
 */
export function parseCloudBuildData(cbwData) {
  const pkgList = [];
  const keys_cache = {};
  if (!cbwData) {
    return pkgList;
  }
  const yamlObj = _load(cbwData);
  if (!yamlObj) {
    return pkgList;
  }
  if (yamlObj.steps) {
    for (const step of yamlObj.steps) {
      if (step.name) {
        const tmpA = step.name.split(":");
        if (tmpA.length === 2) {
          let group = dirname(tmpA[0]);
          const name = basename(tmpA[0]);
          if (group === ".") {
            group = "";
          }
          const version = tmpA[1];
          const key = `${group}-${name}-${version}`;
          if (!keys_cache[key] && name && version) {
            keys_cache[key] = key;
            pkgList.push({
              group,
              name,
              version,
            });
          }
        }
      }
    }
  }
  return pkgList;
}

/**
 * Parse Conan lock file data (conan.lock) and return the package list, dependency map,
 * and parent component dependencies.
 *
 * Supports both the legacy `graph_lock.nodes` format (Conan 1.x) and the newer
 * `requires` format (Conan 2.x).
 *
 * @param {string} conanLockData Raw JSON string of the Conan lock file
 * @returns {{ pkgList: Object[], dependencies: Object, parentComponentDependencies: string[] }}
 */
export function parseConanLockData(conanLockData) {
  const pkgList = [];
  const dependencies = {};
  const parentComponentDependencies = [];

  if (!conanLockData) {
    return { pkgList, dependencies, parentComponentDependencies };
  }

  const lockFile = JSON.parse(conanLockData);
  if (!lockFile?.graph_lock?.nodes && !lockFile.requires) {
    return { pkgList, dependencies, parentComponentDependencies };
  }

  if (lockFile.graph_lock?.nodes) {
    const depends = lockFile.graph_lock.nodes;
    const nodeKeyToBomRefMap = {};

    for (const nk of Object.keys(depends)) {
      if (!depends[nk].ref) continue;

      const [purl, name, version] = mapConanPkgRefToPurlStringAndNameAndVersion(
        depends[nk].ref,
      );
      if (purl === null) continue;

      const bomRef = decodeURIComponent(purl);
      pkgList.push({
        name,
        version,
        purl,
        "bom-ref": bomRef,
      });

      nodeKeyToBomRefMap[nk] = bomRef;
    }

    for (const nk of Object.keys(depends)) {
      let requirementNodeKeys = [];
      if (Array.isArray(depends[nk].requires))
        requirementNodeKeys = requirementNodeKeys.concat(depends[nk].requires);
      if (Array.isArray(depends[nk].build_requires))
        requirementNodeKeys = requirementNodeKeys.concat(
          depends[nk].build_requires,
        );

      for (const dependencyNodeKey of requirementNodeKeys) {
        const dependencyBomRef = nodeKeyToBomRefMap[dependencyNodeKey];
        if (!dependencyBomRef) continue;

        const dependentBomRef = nodeKeyToBomRefMap[nk];
        if (dependentBomRef) {
          if (!(dependentBomRef in dependencies))
            dependencies[dependentBomRef] = [];
          if (!dependencies[dependentBomRef].includes(dependencyBomRef))
            dependencies[dependentBomRef].push(dependencyBomRef);
        } else if (nk === "0") {
          // parent component for which the conan.lock was generated
          if (!parentComponentDependencies.includes(dependencyBomRef))
            parentComponentDependencies.push(dependencyBomRef);
        }
      }
    }
  } else if (lockFile.requires) {
    const depends = lockFile.requires;
    for (const nk of Object.keys(depends)) {
      depends[nk] = depends[nk].split("%").shift();
      const [purl, name, version] = mapConanPkgRefToPurlStringAndNameAndVersion(
        depends[nk],
      );
      if (purl !== null) {
        pkgList.push({
          name,
          version,
          purl,
          "bom-ref": decodeURIComponent(purl),
        });
      }
    }
  }
  return { pkgList, dependencies, parentComponentDependencies };
}

/**
 * Parse a Conan conanfile.txt and extract required and optional packages.
 *
 * @param {string} conanData Raw text contents of a conanfile.txt
 * @returns {Object[]} Array of package objects with purl, name, version, and scope
 */
export function parseConanData(conanData) {
  const pkgList = [];
  if (!conanData) {
    return pkgList;
  }
  let scope = "required";
  conanData.split("\n").forEach((l) => {
    l = l.replaceAll("\r", "");
    if (l.includes("[build_requires]")) {
      scope = "optional";
    }
    if (l.includes("[requires]")) {
      scope = "required";
    }

    // The line must start with sequence non-whitespace characters, followed by a slash,
    // followed by at least one more non-whitespace character.
    // Provides a heuristic for locating Conan package references inside conanfile.txt files.
    if (l.match(/^[^\s\/]+\/\S+/)) {
      const [purl, name, version] =
        mapConanPkgRefToPurlStringAndNameAndVersion(l);
      if (purl !== null) {
        pkgList.push({
          name,
          version,
          purl,
          "bom-ref": decodeURIComponent(purl),
          scope,
        });
      }
    }
  });
  return pkgList;
}

/**
 * Construct a generic package component object for collider-managed packages.
 *
 * @param {string} name Package name
 * @param {Object} pkgData Locked package entry from collider.lock
 * @param {string} lockFile Source lock file path
 * @param {string} dependencyKind Whether the package is direct or transitive
 * @returns {Object|undefined} Package component
 */
function buildColliderComponent(name, pkgData, lockFile, dependencyKind) {
  if (!name) {
    return undefined;
  }
  pkgData = pkgData || {};
  dependencyKind = dependencyKind || "transitive";
  const version = pkgData?.version || "";
  const purl = build({
    type: "generic",
    namespace: "" || null,
    name: name,
    version: version || undefined || null,
  });
  const properties = [
    {
      name: "cdx:collider:dependencyKind",
      value: dependencyKind,
    },
  ];
  if (lockFile) {
    properties.unshift({
      name: "internal:SrcFile",
      value: lockFile,
    });
  }
  const wrapHash =
    typeof pkgData?.wrap_hash === "string" ? pkgData.wrap_hash.trim() : "";
  const wrapHashMatch = wrapHash.match(/^sha256:([0-9A-Fa-f]{64})$/);
  if (wrapHash) {
    properties.push({
      name: "cdx:collider:wrapHash",
      value: wrapHash,
    });
  }
  properties.push({
    name: "cdx:collider:hasWrapHash",
    value: wrapHashMatch ? "true" : "false",
  });
  if (wrapHash && !wrapHashMatch) {
    properties.push({
      name: "cdx:collider:wrapHashInvalid",
      value: "true",
    });
  }
  let originReference;
  if (typeof pkgData?.origin === "string" && pkgData.origin.trim()) {
    try {
      const originUrl = new URL(pkgData.origin.trim());
      const originHadSensitiveParts = Boolean(
        originUrl.username ||
          originUrl.password ||
          originUrl.search ||
          originUrl.hash,
      );
      originUrl.username = "";
      originUrl.password = "";
      originUrl.search = "";
      originUrl.hash = "";
      originReference = originUrl.toString();
      properties.push({
        name: "cdx:collider:origin",
        value: originReference,
      });
      properties.push({
        name: "cdx:collider:originScheme",
        value: originUrl.protocol.replace(":", ""),
      });
      if (originUrl.host) {
        properties.push({
          name: "cdx:collider:originHost",
          value: originUrl.host,
        });
      }
      if (originHadSensitiveParts) {
        properties.push({
          name: "cdx:collider:originSanitized",
          value: "true",
        });
      }
    } catch {
      thoughtLog("Ignoring invalid Collider origin URL");
    }
  }
  const component = {
    name,
    version,
    purl,
    "bom-ref": decodeURIComponent(purl),
    properties,
  };
  if (dependencyKind === "direct") {
    component.scope = "required";
  }
  if (wrapHashMatch) {
    component.hashes = [
      {
        alg: "SHA-256",
        content: wrapHashMatch[1].toLowerCase(),
      },
    ];
  }
  if (originReference) {
    component.externalReferences = [
      {
        type: "distribution",
        url: originReference,
      },
    ];
  }
  return component;
}

/**
 * Parse Collider lock file data (collider.lock) and return the package list and
 * parent component dependencies.
 *
 * @param {string} colliderLockData Raw JSON string of the Collider lock file
 * @param {string} lockFile Source lock file path
 * @returns {{ pkgList: Object[], dependencies: Object, parentComponentDependencies: string[] }}
 */
export function parseColliderLockData(colliderLockData, lockFile) {
  const pkgList = [];
  const dependencies = {};
  const parentComponentDependencies = [];
  if (!colliderLockData) {
    return { pkgList, dependencies, parentComponentDependencies };
  }
  let parsedLockFile;
  try {
    parsedLockFile = JSON.parse(colliderLockData);
  } catch {
    return { pkgList, dependencies, parentComponentDependencies };
  }
  const addedBomRefs = new Set();
  const directDependencies = parsedLockFile.dependencies || {};
  const packages = parsedLockFile.packages || {};
  for (const [name, pkgData] of Object.entries(directDependencies)) {
    const component = buildColliderComponent(name, pkgData, lockFile, "direct");
    if (!component) {
      continue;
    }
    if (!addedBomRefs.has(component["bom-ref"])) {
      pkgList.push(component);
      addedBomRefs.add(component["bom-ref"]);
    }
    if (!parentComponentDependencies.includes(component["bom-ref"])) {
      parentComponentDependencies.push(component["bom-ref"]);
    }
    if (!(component["bom-ref"] in dependencies)) {
      dependencies[component["bom-ref"]] = [];
    }
  }
  for (const [name, pkgData] of Object.entries(packages)) {
    const component = buildColliderComponent(
      name,
      pkgData,
      lockFile,
      "transitive",
    );
    if (!component || addedBomRefs.has(component["bom-ref"])) {
      continue;
    }
    pkgList.push(component);
    addedBomRefs.add(component["bom-ref"]);
    if (!(component["bom-ref"] in dependencies)) {
      dependencies[component["bom-ref"]] = [];
    }
  }
  return { pkgList, dependencies, parentComponentDependencies };
}

/**
 * Method to parse flake.nix files
 *
 * @param {String} flakeNixFile flake.nix file to parse
 * @returns {Object} Object containing package information
 */
export function parseFlakeNix(flakeNixFile) {
  const pkgList = [];
  const dependencies = [];

  if (!safeExistsSync(flakeNixFile)) {
    return { pkgList, dependencies };
  }

  try {
    const flakeContent = readFileSync(flakeNixFile, "utf-8");

    // Extract inputs from flake.nix using regex
    const inputsRegex = /inputs\s*=\s*\{[^}]*}/g;
    let match;
    while ((match = inputsRegex.exec(flakeContent)) !== null) {
      const inputBlock = match[0];
      // The name-run patterns below backtrack quadratically over unbounded
      // blocks, so a crafted flake.nix could burn minutes of CPU. Real flake
      // inputs blocks are a few KB; anything larger is skipped.
      if (inputBlock.length > MAX_FLAKE_INPUTS_BLOCK_LENGTH) {
        if (DEBUG_MODE) {
          console.log(
            `Skipping a suspiciously large inputs block (${inputBlock.length} chars) in ${flakeNixFile}.`,
          );
        }
        continue;
      }

      // Match different input patterns including nested inputs. The cheap
      // substring pre-checks keep URL-less blocks linear.
      const inputPatterns = [
        {
          regex: /([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)\.url\s*=\s*"([^"]+)"/g,
          probe: ".url",
        },
        {
          regex:
            /([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)\s*=\s*\{\s*url\s*=\s*"([^"]+)"[^}]*}/gs,
          probe: "url",
        },
      ];

      const addedPackages = new Set();

      for (const pattern of inputPatterns) {
        if (!inputBlock.includes(pattern.probe)) {
          continue;
        }
        let subMatch;
        pattern.regex.lastIndex = 0;
        while ((subMatch = pattern.regex.exec(inputBlock)) !== null) {
          const name = subMatch[1];
          const url = subMatch[2] || subMatch[3];

          if (name && url && !addedPackages.has(name)) {
            addedPackages.add(name);
            const pkg = {
              name: name,
              version: "latest",
              description: `Nix flake input: ${name}`,
              scope: "required",
              properties: [
                {
                  name: "internal:SrcFile",
                  value: flakeNixFile,
                },
                {
                  name: "cdx:nix:input_url",
                  value: url,
                },
              ],
              evidence: {
                identity: {
                  field: "purl",
                  confidence: 0.8,
                  methods: [
                    {
                      technique: "manifest-analysis",
                      confidence: 0.8,
                      value: flakeNixFile,
                    },
                  ],
                },
              },
            };

            pkg.purl = nixGenericPurl(name, "latest");
            pkg["bom-ref"] = pkg.purl
              ? decodeURIComponent(pkg.purl)
              : `library:${name}:latest`;
            pkg.properties.push({
              name: "cdx:purl:proposedType",
              value: "nix",
            });

            pkgList.push(pkg);
          }
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to parse ${flakeNixFile}: ${error.message}`);
  }

  return { pkgList, dependencies };
}

/**
 * Method to parse flake.lock files
 *
 * @param {String} flakeLockFile flake.lock file to parse
 * @returns {Object} Object containing locked dependency information
 */
export function parseFlakeLock(flakeLockFile) {
  const pkgList = [];
  const dependencies = [];
  const rootInputs = [];

  if (!safeExistsSync(flakeLockFile)) {
    return { pkgList, dependencies, rootInputs };
  }

  try {
    const lockContent = readFileSync(flakeLockFile, "utf-8");
    const lockData = JSON.parse(lockContent);

    if (lockData.nodes) {
      for (const [nodeName, nodeData] of Object.entries(lockData.nodes)) {
        if (nodeName === "root" || !nodeData.locked) continue;

        const locked = nodeData.locked;

        let version = "latest";
        if (locked.rev) {
          version = locked.rev.substring(0, 7);
        } else if (locked.ref) {
          version = locked.ref;
        }

        const pkg = {
          name: nodeName,
          version: version,
          description: `Nix flake dependency: ${nodeName}`,
          scope: "required",
          properties: [
            {
              name: "internal:SrcFile",
              value: flakeLockFile,
            },
          ],
          evidence: {
            identity: {
              field: "purl",
              confidence: 1.0,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 1.0,
                  value: flakeLockFile,
                },
              ],
            },
          },
        };

        if (locked.narHash) {
          pkg.properties.push({
            name: "cdx:nix:nar_hash",
            value: locked.narHash,
          });
        }

        if (locked.lastModified) {
          pkg.properties.push({
            name: "cdx:nix:last_modified",
            value: locked.lastModified.toString(),
          });
        }

        if (locked.rev) {
          pkg.properties.push({
            name: "cdx:nix:revision",
            value: locked.rev,
          });
        }

        if (locked.ref) {
          pkg.properties.push({
            name: "cdx:nix:ref",
            value: locked.ref,
          });
        }

        const urls = nixLockedUrls(locked);
        if (urls.vcsUrl) {
          pkg.properties.push({
            name: "cdx:nix:vcs_url",
            value: urls.vcsUrl,
          });
        }
        if (urls.downloadUrl) {
          pkg.properties.push({
            name: "cdx:nix:download_url",
            value: urls.downloadUrl,
          });
        }

        pkg.properties.push({
          name: "cdx:purl:proposedType",
          value: "nix",
        });

        const purl = nixGenericPurl(nodeName, version, {
          ...(urls.vcsUrl ? { vcs_url: urls.vcsUrl } : {}),
        });
        if (purl) {
          pkg.purl = purl;
          pkg["bom-ref"] = decodeURIComponent(purl);
        } else {
          pkg["bom-ref"] = `library:${nodeName}:${version}`;
        }

        pkgList.push(pkg);
      }

      // Collect the root's direct inputs as bom-refs. The root dependency edge
      // itself is built by createNixBom, which is the only place that knows the
      // parent component's real bom-ref. Emitting a synthetic root here with a
      // guessed ref produced a dangling edge (no component carried that ref).
      if (lockData.nodes?.root?.inputs) {
        const inputNames = Object.keys(lockData.nodes.root.inputs);
        for (const input of inputNames) {
          const ref = pkgList.find((pkg) => pkg.name === input)?.["bom-ref"];
          if (ref) {
            rootInputs.push(ref);
          }
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to parse ${flakeLockFile}: ${error.message}`);
  }

  return { pkgList, dependencies, rootInputs };
}

/**
 * Derive version-control and download URLs for a flake lock `locked` node.
 *
 * flake.lock records a `type` discriminator (github, gitlab, sourcehut,
 * bitbucket, path, tarball, …). Only the git-hosted forge types carry enough
 * information to reconstruct a resolvable archive URL; local `path` inputs have
 * none and are left without URLs so downstream tooling does not chase a
 * non-existent artefact.
 *
 * @param {object} locked The `locked` object from a flake.lock node
 * @returns {{vcsUrl: string|null, downloadUrl: string|null}} derived URLs
 */
function nixLockedUrls(locked) {
  const { type, owner, repo, rev } = locked;
  if (!type || !owner || !repo) {
    return { vcsUrl: null, downloadUrl: null };
  }
  const lower = `${type}`.toLowerCase();
  let vcsUrl = null;
  let downloadUrl = null;
  if (lower === "github") {
    vcsUrl = `https://github.com/${owner}/${repo}`;
    if (rev) {
      downloadUrl = `https://github.com/${owner}/${repo}/archive/${rev}.tar.gz`;
    }
  } else if (lower === "gitlab") {
    vcsUrl = `https://gitlab.com/${owner}/${repo}`;
    if (rev) {
      downloadUrl = `https://gitlab.com/${owner}/${repo}/-/archive/${rev}/${repo}-${rev}.tar.gz`;
    }
  } else if (lower === "bitbucket") {
    vcsUrl = `https://bitbucket.org/${owner}/${repo}`;
    if (rev) {
      downloadUrl = `https://bitbucket.org/${owner}/${repo}/get/${rev}.tar.gz`;
    }
  } else if (lower === "sourcehut" || lower === "sr.ht") {
    vcsUrl = `https://sr.ht/${owner}/${repo}`;
  }
  return { vcsUrl, downloadUrl };
}

/**
 * Parse composer.json file
 *
 * @param {string} composerJsonFile composer.json file
 *
 * @returns {Object} Object with rootRequires and parent component
 */
export function parseComposerJson(composerJsonFile) {
  const moduleParent = {};
  const composerData = JSON.parse(
    readFileSync(composerJsonFile, { encoding: "utf-8" }),
  );
  const rootRequires = {
    ...composerData.require,
    ...composerData["require-dev"],
  };
  const pkgName = composerData.name;
  if (pkgName) {
    moduleParent.group = dirname(pkgName);
    if (moduleParent.group === ".") {
      moduleParent.group = "";
    }
    moduleParent.name = basename(pkgName);
    moduleParent.type = "application";
    moduleParent.version = composerData.version;
    if (composerData.description) {
      moduleParent.description = composerData.description;
    }
    if (composerData.license) {
      moduleParent.licenses = getLicenses({
        expression: composerData.license,
      });
    }
    moduleParent.purl = build({
      type: "composer",
      namespace: moduleParent.group || null,
      name: moduleParent.name,
      version: moduleParent.version || null,
    });
    moduleParent["bom-ref"] = decodeURIComponent(moduleParent.purl);
  }
  return { rootRequires, moduleParent };
}

/**
 * Parse composer lock file
 *
 * @param {string} pkgLockFile composer.lock file
 * @param {array} rootRequires require section from composer.json
 */
export function parseComposerLock(pkgLockFile, rootRequires) {
  const pkgList = [];
  const dependenciesList = [];
  const dependenciesMap = {};
  const pkgNamePurlMap = {};
  const rootList = [];
  const rootRequiresMap = {};
  if (rootRequires) {
    for (const rr of Object.keys(rootRequires)) {
      // Skip platform requirements (php, hhvm, ext-*, lib-*) — they are never
      // Composer package names and must not be used to identify root packages.
      if (
        rr === "php" ||
        rr === "hhvm" ||
        rr.startsWith("ext-") ||
        rr.startsWith("lib-")
      ) {
        continue;
      }
      rootRequiresMap[rr] = true;
    }
  }
  if (safeExistsSync(pkgLockFile)) {
    let lockData = {};
    try {
      lockData = JSON.parse(readFileSync(pkgLockFile, { encoding: "utf-8" }));
    } catch (_e) {
      console.error("Invalid composer.lock file:", pkgLockFile);
      return [];
    }
    if (lockData) {
      const packages = {};
      if (lockData["packages"]) {
        packages["required"] = lockData["packages"];
      }
      if (lockData["packages-dev"]) {
        packages["optional"] = lockData["packages-dev"];
      }
      // Pass 1: Collect all packages
      for (const compScope in packages) {
        for (const i in packages[compScope]) {
          const pkg = packages[compScope][i];
          // Be extra cautious. Potential fix for #236
          if (!pkg?.name || !pkg.version) {
            continue;
          }

          let group = dirname(pkg.name);
          if (group === ".") {
            group = "";
          }
          const name = basename(pkg.name);
          const purl = build({
            type: "composer",
            namespace: group || null,
            name: name,
            version: pkg.version?.toString() || null,
          });
          const apkg = {
            group: group,
            name: name,
            purl,
            "bom-ref": decodeURIComponent(purl),
            version: pkg.version?.toString(),
            repository: pkg.source,
            license: pkg.license,
            description: pkg.description,
            scope: compScope,
            properties: [
              {
                name: "internal:SrcFile",
                value: pkgLockFile,
              },
            ],
            evidence: {
              identity: {
                field: "purl",
                confidence: 1,
                methods: [
                  {
                    technique: "manifest-analysis",
                    confidence: 1,
                    value: pkgLockFile,
                  },
                ],
              },
            },
          };
          if (pkg?.dist?.url) {
            // Replace placeholders like %prettyVersion% with actual version
            let distUrl = pkg.dist.url;
            if (
              distUrl.includes("%prettyVersion%") ||
              distUrl.includes("%version%")
            ) {
              const version = pkg.version || "unknown";
              distUrl = distUrl
                .replace(/%prettyVersion%/g, version)
                .replace(/%version%/g, version);
            }
            apkg.distribution = { url: distUrl };
          }
          if (pkg?.authors?.length) {
            apkg.authors = pkg.authors.map((a) => {
              return { name: a.name, email: a.email };
            });
          }
          if (pkg?.keywords?.length) {
            apkg.tags = pkg.keywords;
          }
          if (pkg.autoload && Object.keys(pkg.autoload).length) {
            const namespaces = [];
            for (const aaload of Object.keys(pkg.autoload)) {
              if (aaload.startsWith("psr")) {
                for (const ans of Object.keys(pkg.autoload[aaload])) {
                  namespaces.push(ans.trim());
                }
              }
            }
            if (namespaces.length) {
              apkg.properties.push({
                name: "internal:Namespaces",
                value: namespaces.join(", "),
              });
            }
          }
          pkgList.push(apkg);
          dependenciesMap[purl] = new Set();
          pkgNamePurlMap[pkg.name] = purl;
          // Add this package to the root list if needed
          if (rootRequiresMap[pkg.name]) {
            rootList.push(apkg);
          }
        }
      }
      // Pass 2: Construct dependency tree
      for (const compScope in packages) {
        for (const i in packages[compScope]) {
          const pkg = packages[compScope][i];
          if (!pkg?.name || !pkg.version) {
            continue;
          }
          if (!pkg.require || !Object.keys(pkg.require).length) {
            continue;
          }
          const purl = pkgNamePurlMap[pkg.name];
          for (const adepName of Object.keys(pkg.require)) {
            if (pkgNamePurlMap[adepName]) {
              dependenciesMap[purl].add(pkgNamePurlMap[adepName]);
            }
          }
        }
      }
    }
  }
  for (const ref in dependenciesMap) {
    dependenciesList.push({
      ref: ref,
      dependsOn: Array.from(dependenciesMap[ref]).sort(),
    });
  }
  return {
    pkgList,
    dependenciesList,
    rootList,
  };
}

function convertStdoutToList(result) {
  if (result.status !== 0 || result.error) {
    return undefined;
  }
  const stdout = result.stdout;
  if (stdout) {
    const cmdOutput = Buffer.from(stdout).toString();
    return cmdOutput
      .trim()
      .toLowerCase()
      .split("\n")
      .filter((p) => p.length > 2 && p.includes("."))
      .sort();
  }
  return undefined;
}

/**
 * Method to execute dpkg --listfiles to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export function executeDpkgList(pkgName) {
  const result = safeSpawnSync("dpkg", ["--listfiles", "--no-pager", pkgName]);
  return convertStdoutToList(result);
}

/**
 * Method to execute dnf repoquery to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export function executeRpmList(pkgName) {
  let result = safeSpawnSync("dnf", ["repoquery", "-l", pkgName]);
  // Fallback to rpm
  if (result.status !== 0 || result.error) {
    result = safeSpawnSync("rpm", ["-ql", pkgName]);
  }
  return convertStdoutToList(result);
}

/**
 * Method to execute apk -L info to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export function executeApkList(pkgName) {
  const result = safeSpawnSync("apk", ["-L", "info", pkgName]);
  return convertStdoutToList(result);
}

/**
 * Method to execute alpm -Ql to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export function executeAlpmList(pkgName) {
  const result = safeSpawnSync("pacman", ["-Ql", pkgName]);
  return convertStdoutToList(result);
}

/**
 * Method to execute equery files to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export function executeEqueryList(pkgName) {
  const result = safeSpawnSync("equery", ["files", pkgName]);
  return convertStdoutToList(result);
}

/**
 * Parse swift dependency tree output json object
 *
 * @param {Array} pkgList Package list
 * @param {Array} dependenciesList Dependencies
 * @param {string} jsonObject Swift dependencies json object
 * @param {string} pkgFile Package.swift file
 */
export function parseSwiftJsonTreeObject(
  pkgList,
  dependenciesList,
  jsonObject,
  pkgFile,
) {
  let purl;
  const urlOrPath = jsonObject.url || jsonObject.path;
  if (jsonObject?.url?.startsWith("http")) {
    const version = jsonObject.version;
    purl = purlFromUrlString("swift", urlOrPath, version);
  } else {
    // Local swift packages have no remote URL and therefore no valid swift
    // namespace (cdx-purl requires host/owner). Construct the component
    // directly without a purl.
    purl = null;
  }
  const rootPkg = applyPurl(
    {
      name: purl ? purl.name : jsonObject.name,
      group: purl ? purl.namespace : "",
      version: purl ? purl.version : jsonObject.version,
    },
    purl ? purl.toString() : null,
    jsonObject.name,
  );
  const properties = [];
  if (jsonObject.name && jsonObject.name !== rootPkg.name) {
    properties.push({
      name: "cdx:swift:packageName",
      value: jsonObject.name,
    });
  }
  if (jsonObject?.path?.includes("checkouts")) {
    const relativeCheckoutPath = relative(dirname(pkgFile), jsonObject.path);
    if (!relativeCheckoutPath.startsWith("..")) {
      properties.push({
        name: "cdx:swift:localCheckoutPath",
        value: relativeCheckoutPath,
      });
    }
  }
  if (urlOrPath) {
    if (urlOrPath.startsWith("http")) {
      rootPkg.repository = { url: urlOrPath };
    } else {
      rootPkg.type = "application";
      properties.push({
        name: "internal:SrcPath",
        value: urlOrPath,
      });
      if (pkgFile) {
        properties.push({
          name: "internal:SrcFile",
          value: pkgFile,
        });
      }
    }
  }
  if (properties.length) {
    rootPkg.properties = properties;
  }
  pkgList.push(rootPkg);
  const depList = new Set();
  if (jsonObject.dependencies) {
    for (const dependency of jsonObject.dependencies) {
      const res = parseSwiftJsonTreeObject(
        pkgList,
        dependenciesList,
        dependency,
        pkgFile,
      );
      depList.add(res);
    }
  }
  dependenciesList.push({
    ref: rootPkg["bom-ref"],
    dependsOn: [...depList].sort(),
  });
  return rootPkg["bom-ref"];
}

/**
 * Parse swift dependency tree output
 * @param {string} rawOutput Swift dependencies json output
 * @param {string} pkgFile Package.swift file
 */
export function parseSwiftJsonTree(rawOutput, pkgFile) {
  if (!rawOutput) {
    return {};
  }
  const pkgList = [];
  const dependenciesList = [];
  try {
    const jsonData = JSON.parse(rawOutput);
    parseSwiftJsonTreeObject(pkgList, dependenciesList, jsonData, pkgFile);
  } catch (e) {
    if (DEBUG_MODE) {
      console.log(e);
    }
    return {};
  }
  const rootList = pkgList.filter((p) => p.type === "application");
  return {
    rootList,
    pkgList,
    dependenciesList,
  };
}

/**
 * Parse swift package resolved file
 * @param {string} resolvedFile Package.resolved file
 */
export function parseSwiftResolved(resolvedFile) {
  const pkgList = [];
  if (safeExistsSync(resolvedFile)) {
    try {
      const pkgData = JSON.parse(
        readFileSync(resolvedFile, { encoding: "utf-8" }),
      );
      let resolvedList = [];
      if (pkgData.pins) {
        resolvedList = pkgData.pins;
      } else if (pkgData.object?.pins) {
        resolvedList = pkgData.object.pins;
      }
      for (const adep of resolvedList) {
        const locationOrUrl = adep.location || adep.repositoryURL;
        const version = adep.state?.version || adep.state?.revision;
        // A pin with no remote URL (a local checkout) has no valid swift
        // namespace, so it becomes a component without a purl instead of
        // aborting the rest of the file.
        const purl = purlFromUrlString("swift", locationOrUrl, version);
        const name =
          purl?.name ||
          adep.identity ||
          adep.package ||
          (locationOrUrl ? basename(locationOrUrl).replace(/\.git$/, "") : "");
        if (!name) {
          continue;
        }
        const rootPkg = {
          name,
          group: purl?.namespace || "",
          version: purl ? purl.version : version,
          properties: [
            {
              name: "internal:SrcFile",
              value: resolvedFile,
            },
          ],
          evidence: {
            identity: {
              field: purl ? "purl" : "name",
              confidence: 1,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 1,
                  value: resolvedFile,
                },
              ],
            },
          },
        };
        applyPurl(rootPkg, purl ? purl.toString() : null);
        if (locationOrUrl) {
          rootPkg.repository = { url: locationOrUrl };
        }
        pkgList.push(rootPkg);
      }
    } catch (_err) {
      // continue regardless of error
    }
  }
  return pkgList;
}

/**
 * Compute the bom-ref of a `swift package show-dependencies` node the same
 * way parseSwiftJsonTreeObject does.
 *
 * @param {Object} node show-dependencies node
 * @returns {undefined|string} bom-ref
 */
function swiftTreeNodeRef(node) {
  if (node?.url?.startsWith("http")) {
    const purl = purlFromUrlString("swift", node.url, node.version);
    if (purl) {
      return decodeURIComponent(purl.toString());
    }
  }
  return node?.name;
}

function swiftTreeNodeKeys(node) {
  const repoName = (node?.url || "")
    .split("?")[0]
    .replace(/\/+$/, "")
    .split("/")
    .pop()
    ?.replace(/\.git$/, "");
  return [node?.identity, node?.name, repoName]
    .filter(Boolean)
    .map((k) => String(k).toLowerCase());
}

// Target types that are part of what the package builds and ships
const SWIFT_PRODUCTION_TARGET_TYPES = new Set([
  "executable",
  "macro",
  "plugin",
]);

/**
 * Identify the targets of a Swift package that are part of what it ships.
 *
 * Production targets are the non-test targets that are part of a product,
 * executables, macros, plugins, targets nothing else depends on, and every
 * target they depend on. The remaining non-test targets only serve tests,
 * such as snapshot or fixture helper libraries.
 *
 * @param {Object} dumpJson `swift package dump-package` document
 * @returns {Set<string>} Lowercase names of the production targets
 */
export function collectSwiftProductionTargets(dumpJson) {
  const targets = dumpJson?.targets || [];
  const targetsByName = new Map(
    targets.map((t) => [String(t?.name || "").toLowerCase(), t]),
  );
  const localTargetRefs = (target) => {
    const refs = [];
    for (const adep of target?.dependencies || []) {
      const name = adep?.target?.[0] ?? adep?.byName?.[0];
      if (name && targetsByName.has(String(name).toLowerCase())) {
        refs.push(String(name).toLowerCase());
      }
    }
    return refs;
  };
  const productTargets = new Set(
    (dumpJson?.products || []).flatMap((p) =>
      (p?.targets || []).map((t) => String(t).toLowerCase()),
    ),
  );
  const referencedTargets = new Set(targets.flatMap((t) => localTargetRefs(t)));
  const productionTargets = new Set();
  const stack = targets
    .filter(
      (t) =>
        !isSwiftTestTarget(t) &&
        (productTargets.has(String(t.name).toLowerCase()) ||
          SWIFT_PRODUCTION_TARGET_TYPES.has(t.type) ||
          !referencedTargets.has(String(t.name).toLowerCase())),
    )
    .map((t) => String(t.name).toLowerCase());
  while (stack.length) {
    const name = stack.pop();
    if (productionTargets.has(name)) {
      continue;
    }
    productionTargets.add(name);
    stack.push(...localTargetRefs(targetsByName.get(name)));
  }
  return productionTargets;
}

/**
 * Classify the dependencies of a Swift package into the packages its shipped
 * code needs and the packages only its tests need.
 *
 * Production targets are the non-test targets that are part of a product,
 * executables, macros, plugins, targets nothing else depends on, and every
 * target they depend on. The remaining non-test targets only serve tests
 * (test-support libraries). A package is test-only when only test and
 * test-support targets reference its products or use its plugins. With the dependency graph from
 * `swift package show-dependencies`, the packages reachable only through
 * test-only packages are test-only as well; a package reachable from a
 * production dependency, or from a declared dependency no target references,
 * stays required.
 *
 * Target dependencies reference products either as
 * `{"product": [name, package]}` or `{"byName": [name]}`; SwiftPM resolves a
 * `byName` product through the package of the same name. When a production
 * `byName` reference names neither a local target nor a package, the
 * classification is abandoned rather than risking a required package being
 * scoped optional.
 *
 * @param {Object|String} dumpJson `swift package dump-package` document, parsed or as text
 * @param {Object|String} [treeJson] `swift package show-dependencies --format json` document, parsed or as text
 * @returns {Object} `{ optionalRefs, requiredRefs, optionalNames, requiredNames }`:
 *   bom-refs from the dependency graph, and lowercase package identities,
 *   names, and repository names (the only result without a graph)
 */
export function classifySwiftDependencyScopes(dumpJson, treeJson) {
  // Command output may be handed over unparsed
  const parseJson = (value) => {
    if (typeof value !== "string") {
      return value;
    }
    try {
      return JSON.parse(value);
    } catch (_e) {
      return undefined;
    }
  };
  dumpJson = parseJson(dumpJson);
  treeJson = parseJson(treeJson);
  const empty = {
    optionalRefs: new Set(),
    requiredRefs: new Set(),
    optionalNames: new Set(),
    requiredNames: new Set(),
  };
  const targets = dumpJson?.targets || [];
  if (!targets.length) {
    return empty;
  }
  const targetsByName = new Map(
    targets.map((t) => [String(t?.name || "").toLowerCase(), t]),
  );
  const productionTargets = collectSwiftProductionTargets(dumpJson);
  const packageKeys = (target) => {
    const keys = [];
    const unresolved = [];
    for (const adep of target?.dependencies || []) {
      if (adep?.product) {
        keys.push(String(adep.product[1] ?? adep.product[0]).toLowerCase());
      } else if (adep?.byName?.[0]) {
        const name = String(adep.byName[0]).toLowerCase();
        if (!targetsByName.has(name)) {
          unresolved.push(name);
        }
      }
    }
    // Build tool plugins count for the target that uses them, so a plugin
    // used only by test targets is test-only
    for (const ausage of target?.pluginUsages || []) {
      if (ausage?.plugin?.[1]) {
        keys.push(String(ausage.plugin[1]).toLowerCase());
      }
    }
    return { keys, unresolved };
  };
  const directNodes = treeJson?.dependencies || [];
  const nodesByKey = new Map();
  for (const node of directNodes) {
    for (const key of swiftTreeNodeKeys(node)) {
      if (!nodesByKey.has(key)) {
        nodesByKey.set(key, node);
      }
    }
  }
  const prodKeys = new Set();
  const testKeys = new Set();
  for (const target of targets) {
    const isProduction =
      !isSwiftTestTarget(target) &&
      productionTargets.has(String(target.name).toLowerCase());
    const { keys, unresolved } = packageKeys(target);
    const bucket = isProduction ? prodKeys : testKeys;
    for (const key of keys) {
      bucket.add(key);
    }
    for (const name of unresolved) {
      // byName products resolve through the package of the same name
      if (!treeJson || nodesByKey.has(name)) {
        bucket.add(name);
      } else if (isProduction) {
        return empty;
      }
    }
  }
  if (!treeJson) {
    return {
      ...empty,
      optionalNames: new Set([...testKeys].filter((k) => !prodKeys.has(k))),
      requiredNames: prodKeys,
    };
  }
  // Package graph keyed by bom-ref
  const childrenByRef = new Map();
  const keysByRef = new Map();
  const collectGraph = (node) => {
    const ref = swiftTreeNodeRef(node);
    if (!ref || childrenByRef.has(ref)) {
      return ref;
    }
    childrenByRef.set(ref, new Set());
    keysByRef.set(ref, swiftTreeNodeKeys(node));
    for (const child of node?.dependencies || []) {
      const childRef = collectGraph(child);
      if (childRef) {
        childrenByRef.get(ref).add(childRef);
      }
    }
    return ref;
  };
  const prodRoots = [];
  const testRoots = [];
  for (const node of directNodes) {
    const ref = collectGraph(node);
    const keys = swiftTreeNodeKeys(node);
    const usedByProduction = keys.some((k) => prodKeys.has(k));
    const usedByTests = keys.some((k) => testKeys.has(k));
    if (usedByTests && !usedByProduction) {
      testRoots.push(ref);
    } else {
      // Production dependencies, and declared dependencies no target uses
      prodRoots.push(ref);
    }
  }
  const reach = (roots) => {
    const seen = new Set();
    const pending = [...roots];
    while (pending.length) {
      const ref = pending.pop();
      if (!ref || seen.has(ref)) {
        continue;
      }
      seen.add(ref);
      pending.push(...(childrenByRef.get(ref) || []));
    }
    return seen;
  };
  const requiredRefs = reach(prodRoots);
  const optionalRefs = new Set(
    [...reach(testRoots)].filter((ref) => !requiredRefs.has(ref)),
  );
  // Components from Package.resolved can carry a different version or URL
  // spelling than the graph, so the package names are reported as well
  const namesOf = (refs) =>
    new Set([...refs].flatMap((ref) => keysByRef.get(ref) || []));
  return {
    optionalRefs,
    requiredRefs,
    optionalNames: namesOf(optionalRefs),
    requiredNames: namesOf(requiredRefs),
  };
}

/**
 * Decide whether a dump-package target is a test target. The `type` field is
 * usually the string `"test"`, but manifest APIs have also been observed
 * representing it as an object.
 *
 * @param {Object} atarget dump-package target
 * @returns {boolean} `true` for test targets
 */
export function isSwiftTestTarget(atarget) {
  return atarget?.type === "test" || atarget?.type?.test === true;
}

/**
 * Parse a CMake-generated dot/graphviz file and extract components and their dependency
 * relationships.
 *
 * The first `digraph` entry becomes the parent component. Subsequent `node` entries
 * with a `label` attribute are treated as direct dependencies, while commented
 * `node -> node` relationships are used to construct the dependency graph.
 *
 * @param {string} dotFile Path to the CMake-generated dot file
 * @param {string} pkgType PackageURL type to assign to extracted packages (e.g. `"generic"`)
 * @param {Object} options CLI options; may contain `projectGroup`, `projectName`, and `projectVersion`
 * @returns {{ parentComponent: Object, pkgList: Object[], dependenciesList: Object[] }}
 */
export function parseCmakeDotFile(dotFile, pkgType, options = {}) {
  const dotGraphData = readFileSync(dotFile, { encoding: "utf-8" });
  const pkgList = [];
  const dependenciesMap = {};
  const pkgBomRefMap = {};
  let parentComponent = {};
  dotGraphData.split("\n").forEach((l) => {
    l = l.replaceAll("\r", "").trim();
    if (l === "\n" || l.startsWith("#")) {
      return;
    }
    let name = "";
    const group = "";
    const version = "";
    let path;
    if (l.startsWith("digraph")) {
      const tmpA = l.split(" ");
      if (tmpA && tmpA.length > 1) {
        name = tmpA[1].replace(/"/g, "");
      }
    } else if (l.startsWith('"node')) {
      // Direct dependencies are represented as nodes
      if (l.includes("label =")) {
        const tmpA = l.split('label = "');
        if (tmpA && tmpA.length > 1) {
          name = tmpA[1].split('"')[0];
        }
        if (name.includes("\\n")) {
          name = name.split("\\n")[0];
        } else if (name.includes(_sep)) {
          path = name;
          name = basename(name);
        }
      } else if (l.includes("// ")) {
        // Indirect dependencies are represented with comments
        const tmpA = l.split("// ");
        if (tmpA?.length) {
          const relationship = tmpA[1];
          if (relationship.includes("->")) {
            const tmpB = relationship.split(" -> ");
            if (tmpB && tmpB.length === 2) {
              if (tmpB[0].includes(_sep)) {
                tmpB[0] = basename(tmpB[0]);
              }
              if (tmpB[1].includes(_sep)) {
                tmpB[1] = basename(tmpB[1]);
              }
              const ref = pkgBomRefMap[tmpB[0]];
              const depends = pkgBomRefMap[tmpB[1]];
              if (ref && depends) {
                if (!dependenciesMap[ref]) {
                  dependenciesMap[ref] = new Set();
                }
                dependenciesMap[ref].add(depends);
              }
            }
          }
        }
      }
    }
    if (!Object.keys(parentComponent).length) {
      parentComponent = {
        group: options.projectGroup || "",
        name: "project-name" in options ? options.projectName : name,
        version: options.projectVersion || "",
        type: "application",
      };
      parentComponent["purl"] = build({
        type: pkgType,
        namespace: parentComponent.group || null,
        name: parentComponent.name,
        version: parentComponent.version || null,
        subpath: path || null,
      });
      parentComponent["bom-ref"] = decodeURIComponent(parentComponent["purl"]);
    } else if (name) {
      const apkg = {
        name: name,
        type: pkgType,
        purl: build({
          type: pkgType,
          namespace: group || null,
          name: name,
          version: version || null,
          subpath: path ? path.replace(/^\/+/, "") : null,
        }),
      };
      apkg["bom-ref"] = decodeURIComponent(apkg["purl"]);
      pkgList.push(apkg);
      pkgBomRefMap[name] = apkg["bom-ref"];
    }
  });
  const dependenciesList = [];
  for (const pk of Object.keys(dependenciesMap)) {
    const dependsOn = Array.from(dependenciesMap[pk] || []).sort();
    dependenciesList.push({
      ref: pk,
      dependsOn,
    });
  }
  return {
    parentComponent,
    pkgList,
    dependenciesList,
  };
}

/** CMake `URL_HASH` algorithm names, their CycloneDX spelling and hex length. */
const CMAKE_HASH_ALGORITHMS = {
  MD5: ["MD5", 32],
  SHA1: ["SHA-1", 40],
  SHA256: ["SHA-256", 64],
  SHA384: ["SHA-384", 96],
  SHA512: ["SHA-512", 128],
  SHA3_256: ["SHA3-256", 64],
  SHA3_384: ["SHA3-384", 96],
  SHA3_512: ["SHA3-512", 128],
};

/** Keywords of the CMake `find_*` commands; they are never package names. */
const CMAKE_FIND_KEYWORDS = new Set([
  "BYPASS_PROVIDER",
  "CMAKE_FIND_ROOT_PATH_BOTH",
  "COMPONENTS",
  "CONFIG",
  "CONFIGS",
  "DOC",
  "ENV",
  "EXACT",
  "GLOBAL",
  "HINTS",
  "MODULE",
  "NAMES",
  "NAMES_PER_DIR",
  "NO_CACHE",
  "NO_CMAKE_BUILDS_PATH",
  "NO_CMAKE_ENVIRONMENT_PATH",
  "NO_CMAKE_FIND_ROOT_PATH",
  "NO_CMAKE_INSTALL_PREFIX",
  "NO_CMAKE_PACKAGE_REGISTRY",
  "NO_CMAKE_PATH",
  "NO_CMAKE_SYSTEM_PACKAGE_REGISTRY",
  "NO_CMAKE_SYSTEM_PATH",
  "NO_DEFAULT_PATH",
  "NO_MODULE",
  "NO_PACKAGE_ROOT_PATH",
  "NO_POLICY_SCOPE",
  "NO_SYSTEM_ENVIRONMENT_PATH",
  "ONLY_CMAKE_FIND_ROOT_PATH",
  "OPTIONAL",
  "OPTIONAL_COMPONENTS",
  "PATHS",
  "PATH_SUFFIXES",
  "QUIET",
  "REGISTRY_VIEW",
  "REQUIRED",
  "VALIDATOR",
]);

const CMAKE_FIND_COMMANDS = new Set([
  "find_package",
  "find_library",
  "find_dependency",
  "find_file",
]);

/**
 * A download URL that is safe to publish: http(s) or ftp only, with any user
 * information, query string and fragment removed.
 *
 * @param {string} url URL as written in the build file
 * @returns {string|undefined} The cleaned URL, or undefined when it is not one
 */
function publishableDownloadUrl(url) {
  if (!url || url.includes("${")) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if (!["http:", "https:", "ftp:"].includes(parsed.protocol)) {
      return undefined;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * The repository and version of a GitHub source archive URL:
 * `https://github.com/<owner>/<repo>/archive/<ref>.zip` (also `refs/tags/...`
 * and `.tar.gz`) and
 * `https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`.
 *
 * @param {string} url Download URL
 * @returns {{owner: string, repo: string, version: string}|undefined}
 */
function githubArchiveCoordinates(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname !== "github.com") {
    return undefined;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 4) {
    return undefined;
  }
  const [owner, repo, section, ...rest] = segments;
  let version;
  if (section === "archive") {
    let ref = rest.join("/");
    for (const prefix of ["refs/tags/", "refs/heads/"]) {
      if (ref.startsWith(prefix)) {
        ref = ref.slice(prefix.length);
      }
    }
    for (const ext of [".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".zip"]) {
      if (ref.endsWith(ext)) {
        ref = ref.slice(0, -ext.length);
        break;
      }
    }
    version = ref;
  } else if (section === "releases" && rest[0] === "download" && rest[1]) {
    version = rest[1];
  }
  if (!version) {
    return undefined;
  }
  return { owner, repo: repo.replace(/\.git$/, ""), version };
}

/**
 * The source archive of the WrapDB release a Meson dependency name resolved to,
 * as a distribution reference carrying the archive's hash. The hash describes
 * that release's archive, which is not known to be the version the project
 * builds, so it belongs to the reference rather than to the component.
 *
 * @param {Object} awrap WrapDB entry
 * @returns {Object|undefined} External reference, or undefined without a URL
 */
function wrapDbReference(awrap) {
  const url = publishableDownloadUrl(awrap?.analyzed_source_url);
  if (!url) {
    return undefined;
  }
  const reference = {
    type: "distribution",
    url,
    comment:
      `WrapDB release ${awrap.name_with_version || awrap.analyzed_version || ""}`.trim(),
  };
  if (/^[0-9a-fA-F]{64}$/.test(awrap.analyzed_source_hash || "")) {
    reference.hashes = [
      { alg: "SHA-256", content: awrap.analyzed_source_hash.toLowerCase() },
    ];
  }
  return reference;
}

/**
 * The component for a dependency a CMake file downloads at configure time
 * (`FetchContent_Declare`, `ExternalProject_Add`, `CPMAddPackage`).
 *
 * A git repository becomes a `github` purl, or a `generic` one with a
 * `vcs_url`, at its tag or commit. A GitHub archive URL becomes a `github` purl
 * at the ref it names. Any other URL becomes a `generic` purl with a
 * `download_url`, and a `URL_HASH` becomes a hash. A version that still holds an
 * unresolved `${VAR}` is left out rather than published.
 *
 * @param {Object} dep Dependency facts from `cmakeFetchDependencies`
 * @param {string} srcFile The CMake file the dependency was read from
 * @returns {Object} The component
 */
export function cmakeFetchDependencyComponent(dep, srcFile) {
  const resolved = (value) =>
    value && !value.includes("${") ? value : undefined;
  let version = resolved(dep.gitTag) || resolved(dep.version);
  let coords;
  const gitUrl = publishableDownloadUrl(dep.gitRepository);
  const downloadUrl = publishableDownloadUrl(dep.url);
  if (gitUrl) {
    coords = submodulePurlCoordinates(gitUrl, version);
  } else if (downloadUrl) {
    const archive = githubArchiveCoordinates(downloadUrl);
    if (archive) {
      version = version || archive.version;
      coords = {
        type: "github",
        namespace: archive.owner,
        name: archive.repo,
        version,
      };
    } else {
      coords = {
        type: "generic",
        name: dep.name,
        version: version || null,
        qualifiers: { download_url: downloadUrl },
      };
    }
  }
  const purl =
    (coords && tryBuildPurl(coords)) ||
    tryBuildPurl({ type: "generic", name: dep.name, version: version || null });
  const confidence = version ? 0.6 : 0.3;
  const component = {
    name: dep.name,
    version: version || "",
    type: "library",
    evidence: {
      identity: {
        field: "purl",
        confidence,
        methods: [
          {
            technique: "manifest-analysis",
            confidence,
            value: `Filename ${srcFile}`,
          },
        ],
      },
    },
    properties: [
      { name: "cdx:cmake:depKind", value: dep.kind },
      { name: "cdx:cmake:resolvedVia", value: "cmake-lists" },
    ],
  };
  applyPurl(component, purl, `library:${dep.name}:${version || ""}`);
  const [alg, content] = (dep.urlHash || "").split("=");
  const [cdxAlg, hexLength] = CMAKE_HASH_ALGORITHMS[alg?.toUpperCase()] || [];
  if (
    cdxAlg &&
    content?.length === hexLength &&
    /^[0-9a-fA-F]+$/.test(content)
  ) {
    component.hashes = [{ alg: cdxAlg, content: content.toLowerCase() }];
  }
  return component;
}

/**
 * Parse a CMake-like build file (CMakeLists.txt, meson.build, etc.) and extract the
 * parent component and list of dependency packages.
 *
 * Handles `set`, `project`, `find_package`, `find_library`, `find_dependency`,
 * `find_file` and `dependency()` directives (CMake command names in any case),
 * and, for CMake files, the dependencies downloaded at configure time by
 * `FetchContent_Declare`, `ExternalProject_Add` and `CPMAddPackage`.
 * Uses the MesonWrapDB to improve name resolution confidence.
 *
 * @param {string} cmakeListFile Path to the CMake-like build file
 * @param {string} pkgType PackageURL type to assign to extracted packages (e.g. `"generic"`)
 * @param {Object} options CLI options; may contain `projectGroup`, `projectName`, and `projectVersion`
 * @returns {{ parentComponent: Object, pkgList: Object[] }}
 */
export function parseCmakeLikeFile(cmakeListFile, pkgType, options = {}) {
  const rawData = readFileSync(cmakeListFile, { encoding: "utf-8" });
  let cmakeListData = rawData;
  const pkgList = [];
  const pkgAddedMap = {};
  const versionSpecifiersMap = {};
  const versionsMap = {};
  let parentComponent = {};
  const templateValues = {};
  // A dependency fetched at configure time is the same package a find_package()
  // of the same name asks for: the fetched component, with its source and pin,
  // stands for both.
  const fetchedNames = new Set();
  if (!basename(cmakeListFile).startsWith("meson")) {
    const fetchedRefs = new Set();
    for (const dep of cmakeFetchDependencies(rawData)) {
      const component = cmakeFetchDependencyComponent(dep, cmakeListFile);
      if (fetchedRefs.has(component["bom-ref"])) {
        continue;
      }
      fetchedRefs.add(component["bom-ref"]);
      fetchedNames.add(dep.name.toLowerCase());
      pkgList.push(component);
    }
  }
  cmakeListData = cmakeListData
    .replace(/^ {2}/g, "")
    .replace(/\(\r\n/g, "(")
    .replace(/\(\n/g, "(")
    .replace(/,\r\n/g, ",")
    .replace(/,\n/g, ",");
  cmakeListData.split("\n").forEach((l) => {
    l = l.replaceAll("\r", "").trim();
    if (l === "\n" || l.startsWith("#")) {
      return;
    }
    const group = "";
    const path = undefined;
    const name_list = [];
    // CMake command names are case-insensitive: `PROJECT(...)` and
    // `Find_Package(...)` are the same commands as their lower-case spellings.
    const openParen = l.indexOf("(");
    const command =
      openParen > 0 ? l.slice(0, openParen).trim().toLowerCase() : "";
    let commandArgs = openParen > 0 ? l.slice(openParen + 1) : "";
    if (command === "set") {
      const tmpA = commandArgs.replace(")", "").trim().split(" ");
      if (tmpA && tmpA.length === 2) {
        templateValues[tmpA[0]] = tmpA[1];
      }
    } else if (command === "project" && !Object.keys(parentComponent).length) {
      if (commandArgs.includes("${")) {
        for (const tmplKey of Object.keys(templateValues)) {
          commandArgs = commandArgs.replace(
            `\${${tmplKey}}`,
            templateValues[tmplKey] || "",
          );
        }
      }
      const tmpB = commandArgs
        .trim()
        .replace(/["']/g, "")
        .replace(/ /g, ",")
        .split(")")[0]
        .split(",")
        .filter((v) => v.length > 1);
      const parentName = tmpB.length > 0 ? tmpB[0].replace(":", "").trim() : "";
      let parentVersion;
      // In case of meson.build we can find the version number after the word version
      // thanks to our replaces and splits
      const versionIndex = tmpB.findIndex(
        (v) => v?.toLowerCase() === "version",
      );
      if (versionIndex > -1 && tmpB.length > versionIndex) {
        parentVersion = tmpB[versionIndex + 1];
      }
      // A `${VAR}` that no `set()` in this file defines stays literal. It is
      // not a version, and percent-encoding it into a purl publishes the
      // variable name as the version, so the field is left empty instead.
      // CMakeCache.txt carries the evaluated value when a build tree exists.
      if (parentVersion?.includes("$")) {
        parentVersion = undefined;
      }
      if (parentName?.length && !parentName.includes("$")) {
        parentComponent = {
          group: options.projectGroup || "",
          name: parentName,
          version: parentVersion || options.projectVersion || "",
          type: "application",
        };
        const safePath = path ? path.replace(/^\/+/, "") : null;
        parentComponent["purl"] = build({
          type: pkgType,
          namespace: parentComponent.group || null,
          name: parentComponent.name,
          version: parentComponent.version || null,
          subpath: safePath,
        });
        parentComponent["bom-ref"] = decodeURIComponent(
          parentComponent["purl"],
        );
      }
    } else if (CMAKE_FIND_COMMANDS.has(command)) {
      let tmpB = commandArgs.split(")")[0].split(" ");
      tmpB = tmpB.filter(
        (v) =>
          !CMAKE_FIND_KEYWORDS.has(v) &&
          !v.includes("$") &&
          !v.startsWith("CMAKE_") &&
          v.length,
      );
      // find_package(Catch2)
      // find_package(GTest REQUIRED)
      // find_package(Boost 1.79 COMPONENTS date_time)
      // find_library(PTHREADPOOL_LIB pthreadpool REQUIRED)
      // find_library and find_file name the cache variable that receives the
      // result in their first argument, so that argument is a destination
      // rather than a package. Every other command in this list opens with a
      // package name, including names such as `ZLIB` that read like a
      // variable.
      // Their names are the values after NAMES, or else the one argument after
      // the variable; the remaining arguments are search paths and options.
      if (command === "find_library" || command === "find_file") {
        const tokens = commandArgs
          .split(")")[0]
          .split(" ")
          .filter((v) => v.length);
        const namesAt = tokens.indexOf("NAMES");
        let names = tokens.slice(1, 2);
        if (namesAt > -1) {
          names = [];
          for (const token of tokens.slice(namesAt + 1)) {
            if (CMAKE_FIND_KEYWORDS.has(token)) {
              break;
            }
            names.push(token);
          }
        }
        tmpB = names.filter((v) => !v.includes("$") && !v.startsWith("CMAKE_"));
      }
      if (tmpB.length) {
        const working_name = tmpB[0];
        name_list.push(working_name);
        if (command === "find_package" && tmpB.length > 1) {
          if (
            /^\d+/.test(tmpB[1]) &&
            !tmpB[1].includes("${") &&
            !tmpB[1].startsWith("@")
          ) {
            versionsMap[working_name] = tmpB[1];
          }
        } else {
          for (const n of tmpB) {
            if (n.match(/^\d/)) {
              continue;
            }
            if (n.includes(_sep)) {
              if (n.includes(".so") || n.includes(".a") || n.includes(".dll")) {
                name_list.push(basename(n));
              }
            } else {
              name_list.push(n);
            }
          }
        }
      }
    } else if (l.includes("dependency(")) {
      if (!l.includes("_dependency") && !l.includes(".dependency")) {
        const depMatch = l.match(/dependency\(\s*['"]?([^'",)\s]+)['"]?/);
        const depName = depMatch?.[1]?.trim();
        if (depName) {
          name_list.push(depName);
          const versionMatch = l.match(/version\s*:\s*['"]?([^'",)\s]+)['"]?/);
          const depVersion = versionMatch?.[1]?.trim();
          if (depVersion) {
            if (depVersion.includes(">") || depVersion.includes("<")) {
              // We have a version specifier
              versionSpecifiersMap[depName] = depVersion;
            } else if (
              /^\d+/.test(depVersion) &&
              !depVersion.includes("${") &&
              !depVersion.startsWith("@")
            ) {
              // We have a valid version
              versionsMap[depName] = depVersion;
            }
          }
        }
      }
    }
    for (let n of name_list) {
      const props = [];
      let confidence = 0;
      let wrapReference;
      if (
        n &&
        n.length > 1 &&
        !pkgAddedMap[n] &&
        !fetchedNames.has(n.toLowerCase()) &&
        !n.startsWith(_sep) &&
        !n.startsWith("@")
      ) {
        n = n.replace(/"/g, "");
        const scrapedName = n;
        // Can this be replaced with a db lookup?
        for (const wrapkey of Object.keys(mesonWrapDB)) {
          const awrap = mesonWrapDB[wrapkey];
          if (
            awrap.PkgProvides.includes(n) ||
            awrap.PkgProvides.includes(n.toLowerCase())
          ) {
            // Use the new name
            n = wrapkey;
            wrapReference = wrapDbReference(awrap);
            props.push({ name: "cdx:meson:wrapdb:wrap", value: wrapkey });
            if (awrap.analyzed_version) {
              props.push({
                name: "cdx:meson:wrapdb:latestVersion",
                value: awrap.analyzed_version,
              });
            }
            props.push({
              name: "internal:PkgProvides",
              value: awrap.PkgProvides.join("|"),
            });
            // Our confidence has improved from 0 since there is a matching wrap so we know the correct name
            // and url. We lack the version details.
            confidence = 0.5;
            break;
          }
        }
        // A wrap match renames the package, so the same directive reached under
        // its scraped name and under its wrap name describe one component. Both
        // spellings are remembered to keep the second arrival out of the list.
        if (pkgAddedMap[n]) {
          pkgAddedMap[scrapedName] = true;
          continue;
        }
        // The version maps are keyed by the name the directive spelled, which a
        // wrap match has since replaced, so the scraped name is the fallback.
        const versionSpecifier =
          versionSpecifiersMap[n] || versionSpecifiersMap[scrapedName];
        const version = versionsMap[n] || versionsMap[scrapedName] || "";
        if (versionSpecifier) {
          props.push({
            name: "cdx:build:versionSpecifiers",
            value: versionSpecifier,
          });
        }
        const apkg = {
          name: n,
          version,
          type: pkgType,
          purl: build({
            type: pkgType,
            namespace: group || null,
            name: n,
            version: version || null,
            subpath: path || null,
          }),
          evidence: {
            identity: {
              field: "purl",
              confidence,
              methods: [
                {
                  technique: "source-code-analysis",
                  confidence: 0.5,
                  value: `Filename ${cmakeListFile}`,
                },
              ],
            },
          },
          properties: props,
        };
        if (wrapReference) {
          apkg.externalReferences = [wrapReference];
        }
        apkg["bom-ref"] = decodeURIComponent(apkg["purl"]);
        pkgList.push(apkg);
        pkgAddedMap[n] = true;
        pkgAddedMap[scrapedName] = true;
      }
    }
  });
  return {
    parentComponent,
    pkgList,
  };
}

/**
 * Parse an atom C/C++ usage-slice report into per-file package usage data.
 *
 * Walks the `objectSlices` of an atom report, collecting resolved method names
 * and full names per source file while skipping include globals and compiler
 * internals.
 *
 * @param {object} sliceData Parsed atom usage-slice report.
 * @returns {Object<string, Set<string>>|undefined} Map of file name to the set
 *   of used symbols, or undefined when sliceData is empty.
 */
export function parseCUsageSlice(sliceData) {
  if (!sliceData) {
    return undefined;
  }
  const usageData = {};
  const objectSlices = sliceData.objectSlices || [];
  for (const slice of objectSlices) {
    // One malformed slice must not cost the slices after it.
    try {
      const fileName = slice?.fileName || "";
      const isInclude = (slice?.code || "").startsWith("#include");
      if (
        (!fileName && !isInclude) ||
        fileName.startsWith("<includes") ||
        fileName.startsWith("<global") ||
        fileName.includes("__")
      ) {
        continue;
      }
      const allLines = (fileName && usageData[fileName]) || new Set();
      if (slice.fullName && slice.fullName.length > 3) {
        if (isInclude) {
          // an included file keeps the symbols already recorded for it
          usageData[slice.fullName] = usageData[slice.fullName] || new Set();
        } else {
          allLines.add(slice.fullName);
        }
      }
      for (const ausage of slice.usages || []) {
        const calls = (ausage?.invokedCalls || []).concat(
          ausage?.argToCalls || [],
        );
        for (const acall of calls) {
          const resolvedMethod = acall?.resolvedMethod;
          if (resolvedMethod && !resolvedMethod.includes("->")) {
            allLines.add(resolvedMethod);
          }
        }
      }
      if (fileName && allLines.size) {
        usageData[fileName] = allLines;
      }
    } catch (err) {
      thoughtLog("Skipping a C usage slice that could not be read.", {
        error: err?.message,
      });
    }
  }
  return usageData;
}

/**
 * Function to parse the .d make files
 *
 * @param {String} dfile .d file path
 *
 * @returns {Object} pkgFilesMap Object with package name and list of files
 */
export function parseMakeDFile(dfile) {
  const pkgFilesMap = {};
  const dData = readFileSync(dfile, { encoding: "utf-8" });
  const pkgName = basename(dfile).split("-").shift();
  const filesList = new Set();
  dData.split("\n").forEach((l) => {
    l = l.replaceAll("\r", "");
    if (!l.endsWith(".rs:")) {
      return;
    }
    const fileName = `.cargo/${l.split(".cargo/").pop()}`.replace(
      ".rs:",
      ".rs",
    );
    filesList.add(fileName);
  });
  pkgFilesMap[pkgName] = Array.from(filesList);
  return pkgFilesMap;
}

/**
 * Resolve a path a lockfile names against the lockfile's directory, refusing
 * absolute paths and any that leave the scanned directory. The value comes
 * from the scanned project, so it must not steer the scan at files outside
 * it. The bound is the scan root, not the lockfile's directory: a React
 * Native `ios/Podfile` names its pods as `../node_modules/...`.
 *
 * @param {String} projectPath Directory of the Podfile.lock
 * @param {String} value Path as the lockfile writes it
 * @param {String} [scanRoot] Directory the scan was asked for; the lockfile's
 *   directory when not given
 * @returns {String|undefined} The resolved path, or undefined when refused
 */
function resolveInsideScan(projectPath, value, scanRoot = projectPath) {
  if (typeof value !== "string" || !value.length) {
    return undefined;
  }
  if (
    isAbsolute(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith("\\\\")
  ) {
    return undefined;
  }
  const resolved = resolve(projectPath, value);
  const back = relative(resolve(scanRoot), resolved);
  if (back.startsWith("..") || isAbsolute(back)) {
    return undefined;
  }
  return resolved;
}

/**
 * Whether a pod name can be used as a file name. Pod names come from the
 * lockfile and are joined onto directories.
 *
 * @param {String} podName Root pod name
 * @returns {Boolean}
 */
function isSafePodFileName(podName) {
  return (
    typeof podName === "string" &&
    podName.length > 0 &&
    !podName.includes("/") &&
    !podName.includes("\\") &&
    !podName.includes("\0") &&
    podName !== "." &&
    podName !== ".."
  );
}

/**
 * Parse the contents of a 'Podfile.lock'
 *
 * @param {Object} podfileLock The content of the podfile.lock as an Object
 * @param {String} projectPath The path to the project root
 * @param {String} [scanRoot] Directory the scan was asked for. Local `:path`
 *   and `:podspec` sources outside it are not read. Defaults to projectPath.
 * @returns {Map} Map of all dependencies with their direct dependencies
 */
export async function parsePodfileLock(podfileLock, projectPath, scanRoot) {
  const dependencies = new Map();
  for (const pod of podfileLock["PODS"]) {
    const dependency = {};
    if (pod.constructor === Object) {
      for (const key in pod) {
        dependency.metadata = parseCocoaDependency(key);
        const subDependencies = new Set();
        for (const subPod of pod[key]) {
          subDependencies.add(parseCocoaDependency(subPod, false));
        }
        dependency.dependencies = Array.from(subDependencies);
      }
    } else {
      dependency.metadata = parseCocoaDependency(pod);
    }
    const podName = dependency.metadata.name.includes("/")
      ? dependency.metadata.name.substring(
          0,
          dependency.metadata.name.indexOf("/"),
        )
      : dependency.metadata.name;
    if (podfileLock["EXTERNAL SOURCES"]?.[podName] && isSafePodFileName(podName)) {
      const externalPod = podfileLock["EXTERNAL SOURCES"][podName];
      if (externalPod[":git"]) {
        // The podspec of a checked out pod, which `pod install` writes
        // alongside the sources it downloaded. Reading it needs no request,
        // so it answers before any raw repository URL.
        const localPodspec = join(
          projectPath,
          "Pods",
          "Local Podspecs",
          `${podName}.podspec.json`,
        );
        if (safeExistsSync(localPodspec)) {
          dependency.metadata.properties = [
            {
              name: "cdx:pods:podspecLocation",
              value: localPodspec,
            },
          ];
        } else {
          let projectRepo = externalPod[":git"];
          if (isGitHubUrl(projectRepo)) {
            projectRepo = projectRepo.replace(
              "github.com",
              "raw.githubusercontent.com",
            );
          }
          if (projectRepo.endsWith(".git")) {
            projectRepo = projectRepo.substring(0, projectRepo.length - 4);
          }
          // The commit the lockfile recorded in CHECKOUT OPTIONS names the
          // exact revision CocoaPods checked out, so its podspec is asked
          // for directly instead of probing the default branch names. It
          // wins over a branch, whose head may have moved since.
          const checkoutCommit =
            podfileLock["CHECKOUT OPTIONS"]?.[podName]?.[":commit"];
          const projectRepoBranchOrTag =
            typeof checkoutCommit === "string" &&
            /^[0-9a-f]{7,64}$/i.test(checkoutCommit)
              ? checkoutCommit
              : externalPod[":tag"]
                ? `refs/tags/${externalPod[":tag"]}`
                : externalPod[":branch"]
                  ? `refs/heads/${externalPod[":branch"]}`
                  : "refs/heads/<DEFAULT>";
          dependency.metadata.properties = [
            {
              name: "cdx:pods:podspecLocation",
              value: `${projectRepo}/${projectRepoBranchOrTag}/${podName}.podspec`,
            },
          ];
        }
      } else if (externalPod[":path"]) {
        const projectLocation = resolveInsideScan(
          projectPath,
          externalPod[":path"],
          scanRoot,
        );
        if (projectLocation) {
          dependency.metadata.properties = [
            {
              name: "cdx:pods:projectDir",
              value: projectLocation,
            },
          ];
          let podspec = join(projectLocation, `${podName}.podspec`);
          if (!safeExistsSync(podspec)) {
            podspec = `${podspec}.json`;
          }
          if (safeExistsSync(podspec)) {
            dependency.metadata.properties.push({
              name: "cdx:pods:podspecLocation",
              value: podspec,
            });
          }
        }
      } else if (externalPod[":podspec"]) {
        const podspecLocation = resolveInsideScan(
          projectPath,
          externalPod[":podspec"],
          scanRoot,
        );
        if (podspecLocation) {
          dependency.metadata.properties = [
            {
              name: "cdx:pods:projectDir",
              value: dirname(podspecLocation),
            },
            {
              name: "cdx:pods:podspecLocation",
              value: podspecLocation,
            },
          ];
        }
      }
    }
    dependencies.set(dependency.metadata.name, dependency);
  }
  if (
    !["false", "0"].includes(readEnvironmentVariable("COCOA_MERGE_SUBSPECS"))
  ) {
    for (const subspecComponentName of [...dependencies.keys()].filter((name) =>
      name.includes("/"),
    )) {
      const subspecComponent = dependencies.get(subspecComponentName);
      const mainComponentName = subspecComponentName.split("/")[0];
      let mainComponent = dependencies.get(mainComponentName);
      if (!mainComponent) {
        mainComponent = {
          metadata: {
            name: mainComponentName,
            version: subspecComponent.metadata.version,
          },
        };
        dependencies.set(mainComponentName, mainComponent);
      }
      if (subspecComponent.dependencies) {
        if (mainComponent.dependencies) {
          mainComponent.dependencies = [
            ...mainComponent.dependencies,
            ...subspecComponent.dependencies,
          ];
        } else {
          mainComponent.dependencies = subspecComponent.dependencies;
        }
      }
      mainComponent.metadata.properties = [
        ...(mainComponent.metadata.properties
          ? mainComponent.metadata.properties
          : []),
        {
          name: "cdx:pods:Subspec",
          value: subspecComponentName.substring(
            subspecComponentName.indexOf("/") + 1,
          ),
        },
        ...(subspecComponent.metadata.propertie
          ? subspecComponent.metadata.properties
          : []),
      ];
      dependencies.delete(subspecComponentName);
    }
    for (const [dependencyName, dependency] of dependencies) {
      if (dependency.dependencies) {
        dependency.dependencies.forEach((dep) => {
          dep.name = dep.name.split("/")[0];
        });
        dependency.dependencies = [
          ...new Map(
            dependency.dependencies
              .filter((dep) => dep.name !== dependencyName)
              .map((dep) => [dep.name, dep]),
          ).values(),
        ];
        if (dependency.dependencies.length === 0) {
          delete dependency.dependencies;
        }
      }
    }
  }
  return dependencies;
}

/**
 * Parse all targets and their direct dependencies from the 'Podfile'
 *
 * @param {Object} target A JSON-object representing a target
 * @param {Map} allDependencies The map containing all parsed direct dependencies for a target
 * @param {String} [prefix=undefined] Prefix to add to the targets name
 */
export function parsePodfileTargets(
  target,
  allDependencies,
  prefix = undefined,
) {
  const targetName = (prefix ? `${prefix}/` : "") + target.name;
  const targetDependencies = new Set(
    prefix && allDependencies.has(prefix)
      ? allDependencies.get(prefix)
      : targetName !== "Pods"
        ? allDependencies.get("Pods")
        : [],
  );
  if (target["dependencies"]) {
    for (const targetDependency of target["dependencies"]) {
      if (targetDependency.constructor === Object) {
        targetDependencies.add(Object.keys(targetDependency)[0]);
      } else {
        targetDependencies.add(targetDependency);
      }
    }
  }
  allDependencies.set(targetName, Array.from(targetDependencies));
  if (target.children) {
    const childPrefix = targetName === "Pods" ? undefined : targetName;
    for (const childTarget of target.children) {
      parsePodfileTargets(childTarget, allDependencies, childPrefix);
    }
  }
}

/**
 * Parse a single line representing a dependency
 *
 * @param {String} dependencyLine The line that should be parsed as a dependency
 * @param {boolean} [parseVersion=true] Include parsing the version of the dependency
 * @returns {Object} Object representing a dependency
 */
export function parseCocoaDependency(dependencyLine, parseVersion = true) {
  const dependencyData = dependencyLine.split(" (");
  const dependency = { name: dependencyData[0] };
  if (parseVersion) {
    dependency.version = dependencyData[1].substring(
      0,
      dependencyData[1].length - 1,
    );
  }
  return dependency;
}

/**
 * Execute the 'pod'-command with parameters
 *
 * @param {String[]} parameters The parameters for the command
 * @param {String} path The path where the command should be executed
 * @param {Object} options CLI options
 * @returns {Object} The result of running the command
 */
export function executePodCommand(parameters, path, options) {
  if (DEBUG_MODE) {
    if (path) {
      console.log("Executing pod", parameters.join(" "), "in", path);
    } else {
      console.log("Executing pod", parameters.join(" "));
    }
  }
  const result = safeSpawnSync(
    readEnvironmentVariable("POD_CMD") || "pod",
    parameters,
    {
      cwd: path,
      shell: isWin,
    },
  );
  if (result.status !== 0 || result.error) {
    if (result?.stderr?.includes("Unable to find a pod")) {
      console.log(
        "Try again by running 'pod install' before invoking 'cdxgen'.",
      );
    }
    if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true") {
      recordDegradation("cocoa.pods.missing", {
        ecosystem: "cocoa",
        tool: "pod",
        impact: "transitive-deps",
        command: `pod ${parameters.join(" ")}`,
        exitCode: typeof result.status === "number" ? result.status : undefined,
        detail:
          "The pod command did not succeed, so the cocoapods dependency graph was not resolved.",
      });
      console.log(
        "Consider using the cdxgen container image (`ghcr.io/cdxgen/cdxgen`), which includes cocoapods and additional build tools.",
      );
    } else if (!DEBUG_MODE) {
      console.log(
        "Something went wrong when trying to execute cocoapods -- Set the environment variable 'CDXGEN_DEBUG_MODE=debug' to troubleshoot cocoapods related errors",
      );
    }
    if (options.failOnError || DEBUG_MODE) {
      if (result.stdout) {
        console.log(result.stdout);
      }
      if (result.stderr) {
        console.log(result.stderr);
      }
      deferFailOnError(options, {
        ecosystem: "cocoa",
        tool: "pod",
        detail: "the pod command failed",
      });
    }
  }
  return result;
}

/**
 * Method that handles object creation for cocoa pods.
 *
 * @param {Object} dependency The dependency that is to be transformed into an SBOM object
 * @param {Object} options CLI options
 * @param {String} [type="library"] The type of Object to create
 * @returns {Object} An object representing the pod in SBOM-format
 */
export async function buildObjectForCocoaPod(
  dependency,
  options,
  type = "library",
) {
  let component;
  if (
    !["false", "0"].includes(
      readEnvironmentVariable("COCOA_RESOLVE_FROM_NODE"),
    ) &&
    dependency.properties?.find(({ name }) => name === "cdx:pods:projectDir")
  ) {
    let tmpDir = dependency.properties.find(
      ({ name }) => name === "cdx:pods:projectDir",
    ).value;
    const exclusionDirs = readEnvironmentVariable(
      "COCOA_RESOLVE_FROM_NODE_EXCLUSION_DIRS",
    )
      ? readEnvironmentVariable("COCOA_RESOLVE_FROM_NODE_EXCLUSION_DIRS").split(
          ",",
        )
      : [];
    if (
      tmpDir &&
      !exclusionDirs.some((dir) =>
        `${tmpDir.replaceAll("\\", "/")}/`.includes(
          `/${dir.replaceAll("\\", "/")}/`.replaceAll("//", "/"),
        ),
      ) &&
      tmpDir.indexOf("node_modules") !== -1
    ) {
      do {
        const npmPackages = await parsePkgJson(join(tmpDir, "package.json"));
        if (npmPackages.length === 1) {
          component = npmPackages[0];
          component.type = "library";
          component.properties = component.properties.concat(
            {
              name: "cdx:pods:PodName",
              value: dependency.name,
            },
            dependency.properties,
          );
          tmpDir = undefined;
        } else {
          tmpDir = dirname(tmpDir);
        }
      } while (tmpDir && tmpDir.indexOf("node_modules") !== -1);
    }
  }
  if (!component) {
    let name = dependency.name;
    let subspec = null;
    const locationOfSubspec = dependency.name.indexOf("/");
    if (locationOfSubspec !== -1) {
      name = dependency.name.substring(0, locationOfSubspec);
      subspec = dependency.name.substring(locationOfSubspec + 1);
    }
    component = {
      ...dependency,
      type,
    };
    if (subspec) {
      if (!component.properties) {
        component.properties = [];
      }
      component.properties.push({
        name: "cdx:pods:Subspec",
        value: subspec,
      });
    }
    const purl = build({
      type: "cocoapods",
      namespace: "" || null,
      name: name,
      version: component.version || null,
      subpath: subspec || null,
    });
    component["purl"] = purl;
    component["bom-ref"] = decodeURIComponent(purl);
    if (
      options &&
      !["false", "0"].includes(readEnvironmentVariable("COCOA_FULL_SCAN"))
    ) {
      await fullScanCocoaPod(dependency, component, options);
    }
  }
  return component;
}

/**
 * The podspec URLs to try, in the order `fullScanCocoaPod` tries them.
 *
 * A location carrying `<DEFAULT>` stands for "the repository's default branch",
 * which the lockfile does not name, so both conventional names are probed and
 * each is probed twice: CocoaPods publishes some podspecs as `.podspec` and
 * some as `.podspec.json` at the same path.
 *
 * @param {String} podspecLocation Location with an unresolved `<DEFAULT>`.
 * @returns {Array<String>} Candidate URLs, most likely first.
 */
function podspecCandidates(podspecLocation) {
  const candidates = [];
  for (const branchName of ["main", "master"]) {
    const resolved = podspecLocation.replace("<DEFAULT>", branchName);
    candidates.push(resolved, `${resolved}.json`);
  }
  return candidates;
}

/**
 * Podspec documents, prefetched by {@link prefetchCocoaPodspecs}.
 *
 * Module state for the same reason as the other prefetch maps: the reader is
 * several call frames below the point where the whole pod list is in hand. A
 * miss means the scan issues its own request.
 */
let cocoaPodspecPrefetch = new Map();

/**
 * Discard prefetched podspecs. Tests only.
 */
export function resetCocoaPodspecPrefetch() {
  cocoaPodspecPrefetch = new Map();
}

registerRunReset("cocoapods:podspecs", resetCocoaPodspecPrefetch);

/**
 * Prefetch the remote podspecs a full CocoaPods scan is about to read.
 *
 * The probe is speculative — up to four URLs per pod — so batching all of them
 * at once would issue requests the serial path never makes: a pod whose podspec
 * sits on `main` is one request there and would be four here. Instead each
 * candidate position is its own round, and a round carries only the pods that
 * every earlier round missed. That is the same set of requests the serial path
 * makes, in the same order of preference, with the pods within a round
 * overlapped rather than queued. Rounds are bounded at four however many pods
 * there are.
 *
 * @param {Array<Object>} dependencies Pod metadata objects, each optionally
 *   carrying a `cdx:pods:podspecLocation` property.
 * @returns {Promise<void>}
 */
export async function prefetchCocoaPodspecs(dependencies) {
  if (!prefetchEnabled() || !Array.isArray(dependencies)) {
    return;
  }
  if (["false", "0"].includes(readEnvironmentVariable("COCOA_FULL_SCAN"))) {
    return;
  }
  let pending = [];
  for (const dependency of dependencies || []) {
    const location = dependency?.properties?.find(
      ({ name }) => name === "cdx:pods:podspecLocation",
    )?.value;
    if (location?.startsWith("http")) {
      pending.push(podspecCandidates(location));
    }
  }
  if (!pending.length) {
    return;
  }
  const rounds = Math.max(...pending.map((candidates) => candidates.length));
  for (let position = 0; position < rounds && pending.length; position++) {
    const requests = [];
    const seen = new Set();
    for (const candidates of pending) {
      const url = candidates[position];
      if (!url || seen.has(url) || cocoaPodspecPrefetch.has(url)) {
        continue;
      }
      seen.add(url);
      requests.push({ url, responseType: "text" });
    }
    if (requests.length) {
      for (const [key, value] of await prefetchJson(requests)) {
        cocoaPodspecPrefetch.set(key, value);
      }
    }
    // A pod whose candidate resolved is done; the rest fall through to the next
    // position, exactly as the serial probe would.
    pending = pending.filter(
      (candidates) => !cocoaPodspecPrefetch.get(candidates[position])?.ok,
    );
  }
}

async function fullScanCocoaPod(dependency, component, options) {
  let result;
  if (
    component.properties?.find(
      ({ name }) => name === "cdx:pods:podspecLocation",
    )
  ) {
    let podspecLocation = component.properties.find(
      ({ name }) => name === "cdx:pods:podspecLocation",
    ).value;
    if (
      component.properties.find(({ name }) => name === "cdx:pods:projectDir")
    ) {
      component.properties.push({
        name: "internal:SrcFile",
        value: podspecLocation,
      });
    }
    let replacements = [];
    if (
      podspecLocation.endsWith(".podspec") &&
      readEnvironmentVariable("COCOA_PODSPEC_REPLACEMENTS")
    ) {
      replacements = readEnvironmentVariable(
        "COCOA_PODSPEC_REPLACEMENTS",
      ).split(";");
    } else if (
      podspecLocation.endsWith(".json") &&
      readEnvironmentVariable("COCOA_PODSPEC_JSON_REPLACEMENTS")
    ) {
      replacements = readEnvironmentVariable(
        "COCOA_PODSPEC_JSON_REPLACEMENTS",
      ).split(";");
    }
    if (replacements || podspecLocation.startsWith("http")) {
      let podspecContent;
      if (podspecLocation.startsWith("http")) {
        let httpResult;
        for (const candidate of podspecCandidates(podspecLocation)) {
          try {
            httpResult =
              prefetchedResponse(cocoaPodspecPrefetch, candidate) ||
              (await gatedGet(candidate, { responseType: "text" }));
            podspecLocation = candidate;
          } catch (_err) {
            continue;
          }
          component.properties.find(
            ({ name }) => name === "cdx:pods:podspecLocation",
          ).value = podspecLocation;
          podspecLocation = `${randomUUID()}.${podspecLocation.substring(podspecLocation.lastIndexOf(".") + 1)}`;
          podspecContent = httpResult.body;
          break;
        }
      } else {
        podspecContent = readFileSync(podspecLocation, "utf-8");
      }
      // A location none of the candidates served contributes nothing: the
      // component keeps what the lockfile already said about the pod.
      if (podspecContent === undefined) {
        return;
      }
      for (const replacement of replacements) {
        const replacementPair = replacement.split("=");
        let match = replacementPair[0].replaceAll("<NEWLINE>", "\n");
        if (match.startsWith("/") && match.endsWith("/")) {
          match = new RegExp(match.substring(1, match.length - 1), "g");
        }
        const repl = replacementPair[1].replaceAll("<NEWLINE>", "\n");
        podspecContent = podspecContent.replaceAll(match, repl);
      }
      podspecLocation = join(
        dirname(podspecLocation),
        `${randomUUID()}.${podspecLocation.substring(podspecLocation.lastIndexOf(".") + 1)}`,
      );
      safeWriteSync(podspecLocation, podspecContent);
      temporaryFiles.add(podspecLocation);
    }
    result = executePodCommand(
      ["ipc", "spec", "--silent", podspecLocation],
      undefined,
      options,
    );
  } else {
    let dependencyName = dependency.name;
    if (dependencyName.includes("/")) {
      dependencyName = dependencyName.substring(0, dependencyName.indexOf("/"));
    }
    // `pod` may not be installed at all, in which case spawn returns a result
    // with no stdout. Calling .trim() on that threw and aborted the whole
    // CocoaPods scan, so any machine without CocoaPods could not generate a
    // BOM from a Podfile.lock it had already parsed successfully.
    const srcFileResult = executePodCommand(
      [
        "spec",
        "which",
        `^${dependencyName}$`,
        "--regex",
        `--version=${dependency.version}`,
      ],
      undefined,
      options,
    );
    if (srcFileResult?.stdout) {
      const srcFileProperty = {
        name: "internal:SrcFile",
        value: srcFileResult.stdout.trim(),
      };
      if (component.properties) {
        component.properties.push(srcFileProperty);
      } else {
        component.properties = [srcFileProperty];
      }
    }
    result = executePodCommand(
      [
        "spec",
        "cat",
        `^${dependencyName}$`,
        "--regex",
        `--version=${dependency.version}`,
      ],
      undefined,
      options,
    );
  }
  // Same reason as above: no `pod` binary means no result to parse.
  const podspecText = result?.stdout;
  if (!podspecText) {
    return;
  }
  let podspec;
  try {
    podspec = JSON.parse(
      podspecText.substring(
        podspecText.indexOf("{"),
        podspecText.lastIndexOf("}") + 1,
      ),
    );
  } catch (_e) {
    return;
  }
  const externalRefs = [];
  if (podspec.authors) {
    component.authors = [];
    if (podspec.authors.constructor === Object) {
      Object.entries(podspec.authors).forEach(([name, email]) => {
        email.includes("@")
          ? component.authors.push({ name, email })
          : component.authors.push({ name });
      });
    } else if (podspec.authors.constructor === Array) {
      podspec.authors.forEach((name) => {
        component.authors.push({ name });
      });
    } else {
      component.authors.push({ name: podspec.authors });
    }
  }
  if (podspec.description) {
    component.description = podspec.description;
  } else if (podspec.summary) {
    component.description = podspec.summary;
  }
  if (podspec.documentation_url) {
    externalRefs.push({
      type: "documentation",
      url: podspec.documentation_url,
    });
  } else if (podspec.readme) {
    externalRefs.push({
      type: "documentation",
      url: podspec.readme,
    });
  }
  if (podspec.homepage) {
    externalRefs.push({
      type: "website",
      url: podspec.homepage,
    });
  }
  if (podspec.license) {
    if (podspec.license.constructor === Object) {
      if (podspec.license.type === "Copyright") {
        component.copyright = podspec.license.text;
      } else {
        component.licenses = [{ license: {} }];
        if (spdxLicenses.includes(podspec.license.type)) {
          component.licenses[0].license.id = podspec.license.type;
        } else {
          component.licenses[0].license.name = podspec.license.type;
        }
        const licenseText = [];
        if (podspec.license.text) {
          if (podspec.license.text.startsWith("http")) {
            component.licenses[0].license.url = podspec.license.text;
          } else {
            licenseText.push(podspec.license.text);
          }
        }
        if (podspec.license.file) {
          if (podspec.license.file.startsWith("http")) {
            if (component.licenses[0].license.url) {
              if (licenseText.length !== 0) {
                licenseText.push("");
              }
              licenseText.push(
                `See also: ${component.licenses[0].license.url}`,
              );
            }
            component.licenses[0].license.url = podspec.license.file;
          } else {
            if (licenseText.length !== 0) {
              licenseText.push("");
            }
            licenseText.push(`See license in file '${podspec.license.file}'`);
          }
        }
        if (licenseText.length !== 0) {
          component.licenses[0].license.text = {
            content: licenseText.join("\n"),
          };
        }
      }
    } else {
      if (spdxLicenses.includes(podspec.license)) {
        component.licenses = [{ license: { id: podspec.license } }];
      } else {
        component.licenses = [{ license: { name: podspec.license } }];
      }
    }
  }
  if (podspec.social_media_url) {
    externalRefs.push({
      type: "social",
      url: podspec.social_media_url,
    });
  }
  if (podspec.source) {
    const comment = [];
    if (podspec.source.http) {
      const sourceDistro = {
        type: "source-distribution",
        url: podspec.source.http,
      };
      const hashes = [];
      if (podspec.source.http.sha1) {
        hashes.push({
          alg: "SHA-1",
          content: podspec.source.http.sha1,
        });
      }
      if (podspec.source.http.sha256) {
        hashes.push({
          alg: "SHA-256",
          content: podspec.source.http.sha256,
        });
      }
      if (hashes.length !== 0) {
        sourceDistro.hashes = hashes;
      }
      if (podspec.source.flatten) {
        comment.push(`Flatten: ${podspec.source.flatten}`);
      }
      if (podspec.source.type) {
        comment.push(`Type: ${podspec.source.type}`);
      }
      if (podspec.source.headers) {
        comment.push(`Headers: ${podspec.source.headers}`);
      }
      if (comment.length !== 0) {
        sourceDistro.comment = comment.join("\n");
      }
      externalRefs.push(sourceDistro);
    } else {
      let url;
      if (podspec.source.git) {
        url = podspec.source.git;
        comment.push("Type: git");
        if (podspec.source.branch) {
          comment.push(`Branch: ${podspec.source.branch}`);
        }
        if (podspec.source.commit) {
          comment.push(`Commit: ${podspec.source.commit}`);
        }
        if (podspec.source.tag) {
          comment.push(`Tag: ${podspec.source.tag}`);
        }
        if (podspec.source.submodules) {
          comment.push(`Submodules: ${podspec.source.submodules}`);
        }
      } else if (podspec.source.hg) {
        url = podspec.source.hg;
        comment.push("Type: hg");
        if (podspec.source.revision) {
          comment.push(`Revision: ${podspec.source.revision}`);
        }
      } else if (podspec.source.svn) {
        url = podspec.source.svn;
        comment.push("Type: svn");
        if (podspec.source.folder) {
          comment.push(`Folder: ${podspec.source.folder}`);
        }
        if (podspec.source.revision) {
          comment.push(`Revision: ${podspec.source.revision}`);
        }
        if (podspec.source.tag) {
          comment.push(`Tag: ${podspec.source.tag}`);
        }
      }
      if (url) {
        externalRefs.push({
          type: "vcs",
          url: url,
          comment: comment.join("\n"),
        });
      } else {
        console.warn(
          `${dependency.name} has property 'source' defined, but it does not contain a URL -- ignoring...`,
        );
      }
    }
  }
  if (externalRefs.length !== 0) {
    component.externalReferences = externalRefs;
  }
}

/**
 * Parse an xmake `xmake-requires.lock` file.
 *
 * The lock is a Lua table, written when the `package.requires_lock` policy is
 * enabled. Its top level holds a `__meta__` entry plus one section per build
 * configuration, keyed `platform|arch`; each section maps a requirement key
 * (`"zlib#31fecfc4"`, or `"sol2 v3.2.1#72267bd5"` when the requirement
 * carries a version) to a table with the resolved `version` and the
 * `repo` revision the package definition came from.
 *
 * The same package appears once per configuration, so entries are collapsed
 * by name and version, and the configurations a package was resolved for are
 * kept as a property. A requirement key without a `version` field names a
 * system package xmake did not resolve; it is inventoried without a version.
 *
 * No `xmake` purl type is registered, so packages are identified as generic
 * carrying a `cdx:purl:proposedType=xmake` property, following the
 * convention used for nix and zig.
 *
 * @param {string} lockFile Path to `xmake-requires.lock`
 * @returns {Object[]} Package records for the pinned requirements
 */
export function parseXmakeRequiresLock(lockFile) {
  let text;
  try {
    text = readFileSync(lockFile, "utf-8");
  } catch (error) {
    console.warn(`Failed to read ${lockFile}: ${error.message}`);
    return [];
  }
  const byKey = new Map();
  // The outermost `{` is the file's own table, so a configuration section
  // opens at depth 1 and a requirement inside it at depth 2. Each is dropped
  // again once the brace depth falls back to where it opened.
  const CONFIGURATION_DEPTH = 1;
  const REQUIREMENT_DEPTH = 2;
  let configuration;
  let requirement;
  let depth = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("--")) {
      continue;
    }
    // `["macosx|arm64"] = {` opens a configuration; `["zlib#hash"] = {` opens
    // a requirement inside one.
    const opener = line.match(/^\[\s*"([^"]+)"\s*\]\s*=\s*\{/u);
    if (opener && depth === CONFIGURATION_DEPTH) {
      // `__meta__` is normally written unquoted, but a lock that quotes it
      // must not become a configuration section either.
      configuration = opener[1] === "__meta__" ? undefined : opener[1];
    } else if (opener && depth === REQUIREMENT_DEPTH && configuration) {
      requirement = xmakeRequirementName(opener[1]);
      const key = `${configuration}|${requirement}`;
      if (requirement && !byKey.has(key)) {
        byKey.set(key, { name: requirement, configuration });
      }
    } else if (!opener && configuration && requirement) {
      const version = line.match(/^version\s*=\s*"([^"]*)"/u);
      if (version) {
        const record = byKey.get(`${configuration}|${requirement}`);
        if (record) {
          record.version = version[1];
        }
      }
    }
    depth = Math.max(0, depth + countXmakeBraces(line));
    if (depth <= REQUIREMENT_DEPTH) {
      requirement = undefined;
    }
    if (depth <= CONFIGURATION_DEPTH) {
      configuration = undefined;
    }
  }

  // Collapse the per-configuration entries into one component per resolved
  // coordinate, listing the configurations it was resolved for.
  const merged = new Map();
  for (const record of byKey.values()) {
    const key = `${record.name}@${record.version || ""}`;
    const existing = merged.get(key);
    if (existing) {
      existing.configurations.add(record.configuration);
      continue;
    }
    merged.set(key, {
      name: record.name,
      version: record.version,
      configurations: new Set([record.configuration]),
    });
  }

  const pkgList = [];
  for (const record of merged.values()) {
    // A malformed coordinate in an untrusted lock costs one entry, not the
    // whole scan.
    const purl = tryBuildPurl({
      type: "generic",
      namespace: "xmake",
      name: record.name,
      version: record.version || null,
    });
    if (!purl) {
      continue;
    }
    pkgList.push({
      name: record.name,
      ...(record.version ? { version: record.version } : {}),
      type: "library",
      scope: "required",
      purl,
      "bom-ref": decodeURIComponent(purl),
      properties: [
        { name: "internal:SrcFile", value: lockFile },
        { name: "cdx:purl:proposedType", value: "xmake" },
        {
          name: "cdx:xmake:configurations",
          value: [...record.configurations].sort().join(", "),
        },
      ],
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.5,
          methods: [
            {
              technique: "source-code-analysis",
              confidence: 0.5,
              value: `Filename ${lockFile}`,
            },
          ],
        },
      },
    });
  }
  return pkgList;
}

/**
 * Reduce an xmake requirement key to the package name.
 *
 * Keys look like `zlib#31fecfc4` or `sol2 v3.2.1#72267bd5`: the trailing
 * `#<hash>` identifies the resolved configuration and the optional second
 * token is the requested version range, neither of which is the name.
 *
 * @param {string} key Requirement key as written in the lock
 * @returns {string|undefined} Package name
 */
function xmakeRequirementName(key) {
  const name = key.split("#")[0].trim().split(/\s+/u)[0];
  return name || undefined;
}

/**
 * Net brace change contributed by one line of a Lua table.
 *
 * @param {string} line Line to scan
 * @returns {number} Opens minus closes
 */
function countXmakeBraces(line) {
  let delta = 0;
  for (const char of line) {
    if (char === "{") {
      delta += 1;
    } else if (char === "}") {
      delta -= 1;
    }
  }
  return delta;
}
