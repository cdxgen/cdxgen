/**
 * The most Go-named files one scan opens in search of a toolchain version.
 *
 * @type {number}
 */
export declare const MAX_GO_PROBES: number;
export declare const GO_VERSION_FILE_MAX_BYTES = 64;
export declare const GO_VERSION_FILE_NAME = "VERSION";
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
export declare function parseGoVersionOutput(text: string): string | undefined;
/**
 * The CPE that lets a downstream scanner match a Go toolchain version. NVD
 * names the product golang:go and keeps a pre-release in the update field,
 * as in cpe:2.3:a:golang:go:1.28:rc1:*:*:*:*:*:*.
 *
 * @param {string} version Go version without the `go` prefix
 * @returns {string} CPE 2.3 string
 */
export declare function goCpe(version: string): string;
/**
 * A Go toolchain is one `platform` component per distinct version, like the
 * PHP and Ruby runtime components. Its identity is `pkg:generic/go`: cdx-purl
 * refuses `pkg:golang/toolchain`, and no package manager owns a toolchain
 * whose VERSION file was read from a GOROOT.
 *
 * @param {string} version Go version without the `go` prefix
 * @returns {Object} component with `purl` and `bom-ref`
 */
export declare function createGoToolchainComponent(version: string): Object;
/**
 * The bom-ref of the toolchain component for a version.
 *
 * @param {string} version Go version without the `go` prefix
 * @returns {string} bom-ref, which is the toolchain's purl
 */
export declare function goToolchainRef(version: string): string;
/**
 * The Go standard library component for a toolchain version: one `library`
 * component, statically linked into every Go binary built with it. Source
 * scans and container scans build it through this function, so a stdlib of
 * one version is one component whichever scan found it.
 *
 * @param {string} goVersion the toolchain version as Go spells it, with the
 *   `go` prefix (`go1.27.2`)
 * @returns {Object} component with the shared bom-ref, the `v`-prefixed
 *   version trivy reports and, for a released version, the Go CPE
 */
export declare function goStdlibComponent(goVersion: string): Object;
/**
 * The name the `go` executable of a GOROOT carries.
 *
 * @param {string} [platform] `win32` names `go.exe`, everything else `go`
 * @returns {string}
 */
export declare function goBinaryName(platform?: string): string;
/**
 * Whether a file name is one a Go toolchain installs its launcher under:
 * `go`, `go.exe`, and the `go1.x.y` downloads `golang.org/dl` places beside
 * it in the sdk tree.
 *
 * @param {string} fileName basename or path of the candidate
 * @returns {string|undefined} `go` for the launcher, `sdk-go` for a
 *   version-named download, or undefined
 */
export declare function classifyGoBinary(fileName: string): string | undefined;
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
export declare function readGoToolchainVersion(goRoot: string, rootDir: string | undefined, readText: Function): {
    version: string;
    source: string;
} | undefined;
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
export declare function goToolchainProperties(build: {
    version: string;
    source: string;
}): {
    name: string;
    value: string;
}[];
/**
 * Start collecting the Go toolchain components and edges of one scan.
 *
 * @returns {{runtimeComponents: Object[], dependencies: Object[], runtimeRefs: Set<string>}}
 */
export declare function createGoToolchainInventory(): {
    runtimeComponents: Object[];
    dependencies: Object[];
    runtimeRefs: Set<string>;
};
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
export declare function attachGoToolchain(inventory: {
    runtimeComponents: Object[];
    dependencies: Object[];
    runtimeRefs: Set<string>;
}, component: Object, build: {
    version: string;
    source: string;
}): void;
//# sourceMappingURL=goToolchain.d.ts.map