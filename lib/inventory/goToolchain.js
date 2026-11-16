// The one place a Go toolchain version becomes a component, for the source
// scan, the container scan, the OS scan and formulation alike. Go 1.27.4 and
// 1.26.11 (2026-11-10) fixed twelve CVEs, eleven of them in cmd/go and cgo,
// so a BOM has to name the toolchain that resolved a project's dependencies
// and the one an image carries (issue #4849).
//
// A toolchain version is read, never executed: from the output of `go version`
// or `go env GOVERSION`, and from the VERSION file every GOROOT carries next
// to bin/go. Version comparison in Go follows internal/gover, which since
// 1.21 keeps the language version apart from the first release of its cycle:
// 1.21 < 1.21rc1 < 1.21.0, with the kinds ordering "" < alpha < beta < rc.
// The version is therefore kept in the form Go itself reports ("1.21" stays
// "1.21"; it is not normalized to "1.21.0"), so the CPE and the purl name the
// release the vendor named.
//
// NVD's CPE for Go is cpe:2.3:a:golang:go. cdx-purl accepts no
// `pkg:golang/toolchain` and no `pkg:golang/stdlib`, so the toolchain's
// identity is `pkg:generic/go`, as PHP's and Ruby's runtimes are `pkg:generic`.

import { readScanFileText } from "../core/boundedFile.js";
import { applyPurl, tryBuildPurl } from "./purl.js";

// The body of a Go version after the `go` prefix: 1.27.4, 1.21, 1.28rc1,
// 1.19beta1, 1.9.2rc2. A development build carries a dash and a commit hash
// instead of a release number.
const VERSION_BODY_RE = /^\d+(?:\.\d+)*(?:(?:alpha|beta|rc)\d+)?$/;
// The longest a version token may be, enough for every Go grammar form.
const MAX_VERSION_TOKEN_LENGTH = 32;
// The VERSION file of a GOROOT holds one line, `go1.27.1`. Reading a bounded
// first line is enough; the rest of the file is never looked at.
export const GO_VERSION_FILE_MAX_BYTES = 64;
export const GO_VERSION_FILE_NAME = "VERSION";

/**
 * Parse the version from the output of `go version`, `go env GOVERSION`, or
 * the first line of a GOROOT's VERSION file.
 *
 * Accepted forms:
 * - `go version go1.27.4 darwin/arm64` -> `1.27.4`
 * - `go version go1.26.10 X:boringcrypto darwin/arm64` -> `1.26.10`
 * - `go1.28rc1`, `go1.19beta1` -> `1.28rc1`, `1.19beta1`
 * - `go1.21` -> `1.21`: since Go 1.21 a patchless version names the language
 *   version, which Go keeps apart from `1.21.0` (1.21 < 1.21rc1 < 1.21.0), so
 *   it is not rewritten. For a cycle before 1.21, Go itself reads a missing
 *   patch as `.0`, but the reported form is kept there too.
 * - `go1.21.3-mycorp` -> `1.21.3`: a dash after a release names a
 *   custom-built suffix, which Go's own version reader strips.
 * - `go version devel go1.28-9d1f2f0 <date> <arch>` -> undefined, and the
 *   same for a VERSION file holding a commit-named snapshot: a development
 *   build is no release, and its commit matches no advisory.
 *
 * @param {string} text command output or the first line of a VERSION file
 * @returns {string|undefined} the version without the `go` prefix, or
 *   undefined when the text names no released Go toolchain
 */
export function parseGoVersionOutput(text) {
  if (typeof text !== "string") {
    return undefined;
  }
  const line = text.split(/\r?\n/, 1)[0].trim();
  if (!line || line.length > MAX_VERSION_TOKEN_LENGTH * 4) {
    return undefined;
  }
  const tokens = line.split(/\s+/);
  // A source build reports itself as `devel go1.NN-hash ...`, and so does
  // `go env GOVERSION` on one; the banner puts the marker after
  // `go version`.
  if (tokens.includes("devel")) {
    return undefined;
  }
  for (const token of tokens) {
    if (!token.startsWith("go")) {
      continue;
    }
    const body = token.slice(2);
    // Only a digit after the prefix makes this a version, so plain words that
    // start with go are skipped.
    if (!body || body.length > MAX_VERSION_TOKEN_LENGTH || !/^\d/.test(body)) {
      continue;
    }
    const dash = body.indexOf("-");
    if (dash !== -1) {
      const release = body.slice(0, dash);
      // A dash after a release names the suffix of a rebuild, which Go's own
      // version reader strips. A dash after a patchless version names the
      // commit of a development snapshot, which is no release.
      if (release.split(".").length < 3) {
        continue;
      }
      if (!VERSION_BODY_RE.test(release)) {
        continue;
      }
      return release;
    }
    if (!VERSION_BODY_RE.test(body)) {
      continue;
    }
    return body;
  }
  return undefined;
}

/**
 * The CPE that lets a downstream scanner match a Go toolchain version. NVD
 * names the product golang:go and keeps a pre-release in the update field,
 * as in cpe:2.3:a:golang:go:1.28:rc1:*:*:*:*:*:*.
 *
 * @param {string} version Go version without the `go` prefix
 * @returns {string} CPE 2.3 string
 */
export function goCpe(version) {
  const match = /^(\d+(?:\.\d+)*)(alpha|beta|rc)(\d+)$/.exec(version || "");
  if (!match) {
    return `cpe:2.3:a:golang:go:${version}:*:*:*:*:*:*:*`;
  }
  return `cpe:2.3:a:golang:go:${match[1]}:${match[2]}${match[3]}:*:*:*:*:*:*`;
}

/**
 * A Go toolchain is one `platform` component per distinct version, like the
 * PHP and Ruby runtime components. Its identity is `pkg:generic/go`: cdx-purl
 * refuses `pkg:golang/toolchain`, and no package manager owns a toolchain
 * whose VERSION file was read from a GOROOT.
 *
 * @param {string} version Go version without the `go` prefix
 * @returns {Object} component with `purl` and `bom-ref`
 */
export function createGoToolchainComponent(version) {
  return applyPurl(
    { type: "platform", name: "go", version, cpe: goCpe(version) },
    tryBuildPurl({ type: "generic", name: "go", version }),
  );
}

/**
 * The bom-ref of the toolchain component for a version.
 *
 * @param {string} version Go version without the `go` prefix
 * @returns {string} bom-ref, which is the toolchain's purl
 */
export function goToolchainRef(version) {
  return createGoToolchainComponent(version)["bom-ref"];
}

// The Go standard library has no module path, so `pkg:golang/stdlib@v<x>` is
// not a purl cdx-purl will build (the same reason trivy's stdlib purl is
// dropped further up). The bom-ref below is the decoded form of that string,
// exactly the ref trivy-produced stdlib components already carry, so both
// paths land on one component. Trivy reports the stdlib version without the
// `go` prefix (`v1.27.2`) while buildinfo keeps it (`go1.27.2`).
function goStdlibRef(goVersion) {
  // "go1.26.10 X:boringcrypto" names the toolchain go1.26.10.
  return `pkg:golang/stdlib@v${goVersion.split(/\s/)[0].replace(/^go/, "")}`;
}

/**
 * The Go standard library component for a toolchain version: one `library`
 * component, statically linked into every Go binary built with it. Source
 * scans and container scans build it through this function, so a stdlib of
 * one version is one component whichever scan found it.
 *
 * @param {string} goVersion the toolchain version as Go spells it, with the
 *   `go` prefix (`go1.27.2`)
 * @returns {Object} component with the shared bom-ref and the `v`-prefixed
 *   version trivy reports
 */
export function goStdlibComponent(goVersion) {
  const stdlibRef = goStdlibRef(goVersion);
  return {
    "bom-ref": stdlibRef,
    name: "stdlib",
    type: "library",
    version: stdlibRef.slice("pkg:golang/stdlib@".length),
    group: "",
  };
}

/**
 * The name the `go` executable of a GOROOT carries.
 *
 * @param {string} [platform] `win32` names `go.exe`, everything else `go`
 * @returns {string}
 */
export function goBinaryName(platform) {
  return platform === "win32" ? "go.exe" : "go";
}

/**
 * Whether a file name is one a Go toolchain installs its launcher under:
 * `go`, `go.exe`, and the `go1.x.y` downloads `golang.org/dl` places beside
 * it in the sdk tree.
 *
 * @param {string} fileName basename or path of the candidate
 * @returns {string|undefined} `go` for the launcher, `sdk-go` for a
 *   version-named download, or undefined
 */
export function classifyGoBinary(fileName) {
  if (typeof fileName !== "string" || !fileName) {
    return undefined;
  }
  const name = fileName.split(/[\\/]/).pop();
  if (name === "go" || name === "go.exe") {
    return "go";
  }
  return /^go1\.\d+(\.\d+)?(\.exe)?$/.test(name) ? "sdk-go" : undefined;
}

/**
 * Read the toolchain version a GOROOT reports about itself, from the first
 * line of its VERSION file. The file is read through the bounded file
 * helpers, so only a regular file inside the scan root is opened, the read
 * is capped, and nothing in the tree is executed.
 *
 * @param {string} goRoot absolute path of the GOROOT
 * @param {string|undefined} rootDir directory the GOROOT must live in: an
 *   extracted rootfs or the real root of a host probe
 * @param {function(string, number, string): (string|undefined)} [readText]
 *   bounded text reader, `readScanFileText` unless a test brings one
 * @returns {{version: string, source: string}|undefined} source is
 *   `version-file`
 */
export function readGoToolchainVersion(goRoot, rootDir, readText) {
  if (typeof goRoot !== "string" || !goRoot) {
    return undefined;
  }
  const reader = readText || readScanFileText;
  const text = reader(
    `${goRoot.replace(/[\\/]+$/, "")}/${GO_VERSION_FILE_NAME}`,
    GO_VERSION_FILE_MAX_BYTES,
    rootDir,
  );
  const version = parseGoVersionOutput(text || "");
  return version ? { version, source: "version-file" } : undefined;
}

/**
 * The properties a Go launcher file component carries once its GOROOT's
 * VERSION file was read. They belong on `file` components only: a toolchain a
 * package manager installed is identified by its package, and distros backport
 * fixes under the old upstream version.
 *
 * @param {{version: string, source: string}} build result of
 *   readGoToolchainVersion
 * @returns {{name: string, value: string}[]} properties to append
 */
export function goToolchainProperties(build) {
  return [
    { name: "cdx:go:toolchainVersion", value: build.version },
    { name: "cdx:go:toolchainVersionSource", value: build.source },
  ];
}

/**
 * Start collecting the Go toolchain components and edges of one scan.
 *
 * @returns {{runtimeComponents: Object[], dependencies: Object[], runtimeRefs: Set<string>}}
 */
export function createGoToolchainInventory() {
  return { runtimeComponents: [], dependencies: [], runtimeRefs: new Set() };
}

/**
 * Tag a Go launcher file component with its toolchain facts and link it to
 * the toolchain component of its version, creating that component on first
 * use. Mutates the component in place, as the PHP and Ruby collectors do.
 *
 * @param {{runtimeComponents: Object[], dependencies: Object[], runtimeRefs: Set<string>}} inventory
 *   accumulator from createGoToolchainInventory
 * @param {Object} component file component, with a `properties` array
 * @param {{version: string, source: string}} build result of
 *   readGoToolchainVersion
 */
export function attachGoToolchain(inventory, component, build) {
  component.properties.push(...goToolchainProperties(build));
  const toolchain = createGoToolchainComponent(build.version);
  const toolchainRef = toolchain["bom-ref"];
  if (!inventory.runtimeRefs.has(toolchainRef)) {
    inventory.runtimeRefs.add(toolchainRef);
    inventory.runtimeComponents.push(toolchain);
    inventory.dependencies.push({ ref: toolchainRef, dependsOn: [] });
  }
  if (component["bom-ref"]) {
    inventory.dependencies.push({
      ref: component["bom-ref"],
      dependsOn: [toolchainRef],
    });
  }
}
