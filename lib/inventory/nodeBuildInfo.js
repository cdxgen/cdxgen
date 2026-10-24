// Bounded Node.js build-version reader for unpackaged `node` binaries.
//
// The Node.js the Docker Official images, the release tarballs, nvm, fnm and
// volta install is not owned by any package manager, so a BOM sees it only as
// a file. Its version decides whether the runtime is affected by advisories
// such as CVE-2026-111497 (fixed in 22.23.4, 24.22.1 and 26.12.1).
//
// Two markers are compiled into the binary:
// - the release URLs, `https://nodejs.org/download/<channel>/v<version>/`,
//   which a build configured with release URLs (every nodejs.org build)
//   carries for process.release.sourceUrl and headersUrl
//   https://github.com/nodejs/node/blob/v24.22.0/src/node_metadata.cc#L191-L197
// - `node.js/v<version>`, NUL-terminated, the inspector's /json/version
//   Browser string, which every build with the inspector carries; it is the
//   fallback for a build without release URLs.
//   https://github.com/nodejs/node/blob/v24.22.0/src/inspector_socket_server.cc#L117
//
// process.versions.brotli is not a usable signal: Node.js backports the
// decoder fix without changing it (24.22.1 still reports 1.2.0). The decoder
// state is read separately, by brotliDecoder.js.

import { basename } from "node:path";

import { scanFileMarkers } from "../core/boundedFile.js";
import { applyPurl, tryBuildPurl } from "./purl.js";

const RELEASE_URL_MARKER = Buffer.from("https://nodejs.org/download/");
const USER_AGENT_MARKER = Buffer.from("node.js/v");
const MAX_VERSION_LENGTH = 64;
const VERSION_RE = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z][0-9A-Za-z.]*))?$/;
const CHANNELS = new Set(["release", "rc", "nightly", "test", "v8-canary"]);

/**
 * The most node-named files one scan opens in search of a build version.
 *
 * @type {number}
 */
export const MAX_NODE_PROBES = 64;

/**
 * Whether a file name is one the Node.js runtime is installed under.
 *
 * @param {string} fileName basename or path of the candidate
 * @returns {boolean} true for `node`, `nodejs` and `node.exe`
 */
export function isNodeBinaryName(fileName) {
  if (typeof fileName !== "string" || !fileName) {
    return false;
  }
  const name = basename(fileName.replaceAll("\\", "/"));
  return name === "node" || name === "nodejs" || name === "node.exe";
}

/**
 * Parse a Node.js version in the grammar the release tooling produces:
 * `24.22.1`, `25.0.0-rc.1`, `26.0.0-nightly20260301abcdef`.
 *
 * @param {string} text candidate version, without the leading `v`
 * @returns {string|undefined} the version, or undefined
 */
export function parseNodeVersion(text) {
  if (typeof text !== "string" || !text || text.length > MAX_VERSION_LENGTH) {
    return undefined;
  }
  return VERSION_RE.test(text) ? text : undefined;
}

function versionFromReleaseUrl(after) {
  // <channel>/v<version>/...
  const text = after.toString("latin1");
  const slash = text.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const channel = text.slice(0, slash);
  if (!CHANNELS.has(channel) || text[slash + 1] !== "v") {
    return undefined;
  }
  const end = text.indexOf("/", slash + 2);
  if (end === -1) {
    return undefined;
  }
  const version = parseNodeVersion(text.slice(slash + 2, end));
  return version ? { version, channel } : undefined;
}

function versionFromUserAgent(after) {
  const end = after.indexOf(0);
  if (end <= 0) {
    return undefined;
  }
  return parseNodeVersion(after.toString("latin1", 0, end));
}

/**
 * Read the Node.js version a `node` binary was built as.
 *
 * @param {string} absPath absolute path of the binary
 * @param {string|undefined} rootDir extracted root, when the file came from one
 * @returns {{version: string, source: string, channel?: string}|undefined}
 *   source is `release-url` or `binary`
 */
export function readNodeBuildVersion(absPath, rootDir) {
  const scan = scanFileMarkers(
    absPath,
    rootDir,
    [RELEASE_URL_MARKER, USER_AGENT_MARKER],
    { contextBytes: MAX_VERSION_LENGTH + 32, maxHits: 8 },
  );
  if (!scan || scan.skipped) {
    return undefined;
  }
  const [releaseHits, userAgentHits] = scan.hits;
  const fromBinary = userAgentHits
    .map((hit) => versionFromUserAgent(hit.after))
    .find(Boolean);
  for (const hit of releaseHits) {
    const release = versionFromReleaseUrl(hit.after);
    // The headers URL names the release a binary was published as. A binary
    // whose own version string disagrees is not that release, so the URL is
    // used only when the two agree or the version string is missing.
    if (release && (!fromBinary || fromBinary === release.version)) {
      return {
        version: release.version,
        source: "release-url",
        channel: release.channel,
      };
    }
  }
  return fromBinary ? { version: fromBinary, source: "binary" } : undefined;
}

/**
 * The CPE that lets a downstream scanner match a Node.js version. NVD names the
 * product node.js and keeps a pre-release in the update field.
 *
 * @param {string} version Node.js version
 * @returns {string} CPE 2.3 string
 */
export function nodeCpe(version) {
  const match = VERSION_RE.exec(version || "");
  if (!match) {
    return `cpe:2.3:a:nodejs:node.js:${version}:*:*:*:*:*:*:*`;
  }
  const update = match[2] ? match[2].replaceAll(".", "").toLowerCase() : "*";
  return `cpe:2.3:a:nodejs:node.js:${match[1]}:${update}:*:*:*:*:*:*`;
}

/**
 * A Node.js runtime is one `platform` component per distinct version, like the
 * PHP and Go stdlib components. Its identity is `pkg:generic/node`: it is only
 * used where no package manager owns the runtime.
 *
 * @param {string} version Node.js version
 * @returns {Object} component with `purl`, `bom-ref` and `cpe`
 */
export function createNodeRuntimeComponent(version) {
  return applyPurl(
    { type: "platform", name: "node", version, cpe: nodeCpe(version) },
    tryBuildPurl({ type: "generic", name: "node", version }),
  );
}

/**
 * The properties a node file component carries once its build is known.
 *
 * @param {{version: string, source: string, channel?: string}} build result of readNodeBuildVersion
 * @returns {{name: string, value: string}[]} properties to append
 */
export function nodeBuildProperties(build) {
  const properties = [
    { name: "cdx:node:buildVersion", value: build.version },
    { name: "cdx:node:buildVersionSource", value: build.source },
  ];
  if (build.channel) {
    properties.push({ name: "cdx:node:releaseChannel", value: build.channel });
  }
  return properties;
}

/**
 * Start collecting the runtime components and edges of one scan.
 *
 * @returns {{runtimeComponents: Object[], dependencies: Object[], runtimeRefs: Set<string>}}
 */
export function createNodeRuntimeInventory() {
  return { runtimeComponents: [], dependencies: [], runtimeRefs: new Set() };
}

/**
 * Tag a node file component with its build facts and link it to the runtime
 * component of its version, creating that component on first use. Mutates the
 * component in place.
 *
 * @param {{runtimeComponents: Object[], dependencies: Object[], runtimeRefs: Set<string>}} inventory
 *   accumulator from createNodeRuntimeInventory
 * @param {Object} component file component, with a `properties` array
 * @param {{version: string, source: string, channel?: string}} build result of readNodeBuildVersion
 */
export function attachNodeBuild(inventory, component, build) {
  component.properties.push(...nodeBuildProperties(build));
  const runtime = createNodeRuntimeComponent(build.version);
  const runtimeRef = runtime["bom-ref"];
  if (!runtimeRef) {
    return;
  }
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
