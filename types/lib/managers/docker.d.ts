import { Buffer } from "node:buffer";
/** True when the current operating system is Windows. */
export declare const isWin: boolean;
/**
 * Canonical Docker Hub registry hostname used as the default registry when
 * parsing image names.
 *
 * @type {string}
 */
export declare const DOCKER_HUB_REGISTRY: string;
/**
 * Strip absolute path prefixes from a path string, handling both Unix and
 * Windows paths (including UNC and extended-length paths such as //?/C:/).
 * Taken from https://github.com/isaacs/node-tar/blob/main/src/strip-absolute-path.ts
 *
 * @param {string} path The path to strip
 * @returns {string} The path with its absolute root removed
 */
export declare const stripAbsolutePath: (path: string) => string;
/**
 * Detect colima
 */
export declare function detectColima(): any;
/**
 * Detect if Rancher desktop is running on a mac.
 */
export declare function detectRancherDesktop(): any;
/**
 * Establish (or reuse) a `got` client connected to the local Docker or Podman
 * daemon. Tries multiple socket / URL candidates in order: the default Docker
 * socket, the rootless Docker socket, the Windows TCP endpoint, the rootless
 * Podman socket, and the root Podman socket. Sets the module-level flags
 * `isPodman`, `isPodmanRootless`, `isDockerRootless`, and `isWinLocalTLS` as a
 * side-effect. Returns `undefined` when containerd / nerdctl is in use or no
 * daemon could be reached.
 *
 * @param {Object} _options Additional options (currently unused; retained for
 *   backwards compatibility with existing callers)
 * @param {string} [forRegistry] Registry hostname forwarded to `getDefaultOptions`
 * @returns {Promise<Object|undefined>} A daemon connection object bound to the
 *   daemon base URL, or `undefined`
 */
export declare const getConnection: (_options: Object, forRegistry?: string) => Promise<Object | undefined>;
/**
 * Send a single HTTP request to the Docker / Podman daemon via the connection
 * returned by {@link getConnection}. GET requests are parsed as JSON; all other
 * methods receive a Buffer response body.
 *
 * @param {string} path API path relative to the daemon base URL (e.g. "images/ubuntu:latest/json")
 * @param {string} method HTTP method (e.g. "GET", "POST", "DELETE")
 * @param {string} [forRegistry] Registry hostname forwarded to `getDefaultOptions` for auth headers
 * @returns {Promise<Object|Buffer|undefined>} Parsed JSON object for GET
 *   requests, raw Buffer for other methods, or `undefined` if no client is available
 */
export declare const makeRequest: (path: string, method: string, forRegistry?: string) => Promise<Object | Buffer | undefined>;
/**
 * Decide whether a CLI path argument is a container image reference in the
 * styles the container pipeline documents: name, name:tag, namespace/name,
 * registry/namespace/name:tag, registry:port/..., and any of those with a
 * @digest. Everything that smells like a filesystem path, a URL or a CLI
 * option never matches, so strings such as "c:\Users", "c:/tmp" or
 * "file:///etc" can never reach the container clients: backslashes and
 * schemes are rejected outright, and a drive-letter prefix fails because a
 * lone letter is neither a dotted host nor a host:port, and a tag may not
 * begin with the "/" that follows the colon in "c:/tmp".
 *
 * The check mirrors how the distribution reference grammar detects a registry
 * host: the first component counts as a host only when it carries a dot, a
 * numeric port, or is exactly localhost. Each piece is validated by a linear
 * regex or plain string splitting, and the input is length-capped, so hostile
 * inputs cannot backtrack expensively.
 *
 * @param {string} fullImageName Candidate image reference
 * @returns {boolean} true when the string is a plausible image reference
 */
export declare const isImageReference: (fullImageName: string) => boolean;
/**
 * Whether an image named in a scanned manifest, such as a docker-compose file
 * or a Kubernetes spec, may be pulled and inventoried. The name comes from the
 * scanned project, so a local archive path would read files outside the
 * allowed paths and a registry outside CDXGEN_ALLOWED_HOSTS would bypass the
 * host allowlist.
 *
 * @param {string} fullImageName Image name from the manifest
 * @param {Object} [imageObj] Result of parseImageName for the same name
 * @returns {boolean} true when the image may be followed
 */
export declare const isFollowableManifestImage: (fullImageName: string, imageObj?: Object) => boolean;
/**
 * Parse image name
 *
 * docker pull debian
 * docker pull debian:jessie
 * docker pull ubuntu@sha256:45b23dee08af5e43a7fea6c4cf9c25ccf269ee113168c19722f87876677c5cb2
 * docker pull myregistry.local:5000/testing/test-image
 */
export declare const parseImageName: (fullImageName: any) => {
    registry: string;
    repo: string;
    tag: string;
    digest: string;
    platform: string;
    group: string;
    name: string;
};
/**
 * Prefer cli on windows, nerdctl on mac, or when using tcp/ssh based host.
 * On Windows, fall back to wslc (WSL Containers) when the docker CLI is not
 * installed, so OCI image scans work on hosts that only have WSL.
 *
 * @returns {string} Container CLI command to invoke
 */
export declare const getContainerCliCmd: () => string;
/**
 * Method to get image to the local registry by pulling from the remote if required
 */
export declare const getImage: (fullImageName: any) => Promise<any>;
export type TarReadEntryLike = {
    path: string;
};
/**
 * Extract a container image tar archive into a destination directory.
 * Applies path sanitisation, ownership/permission preservation settings, and
 * an entry filter to skip problematic files and device nodes. Handles common
 * tar errors gracefully, logging only unexpected ones.
 *
 * @param {string} fullImageName Path to the source tar archive
 * @param {string} dir Destination directory to extract into
 * @param {Object} options CLI options (uses `options.failOnError`)
 * @returns {Promise<boolean>} `true` on success, `false` when the archive is
 *   empty or a non-fatal error was encountered
 */
export declare const extractTar: (fullImageName: string, dir: string, options: Object) => Promise<boolean>;
/**
 * Method to export a container image archive.
 * Returns the location of the layers with additional packages related metadata
 */
export declare const exportArchive: (fullImageName: any, options?: {}) => Promise<Object | undefined>;
/**
 * Parse a Docker/containerd manifest file and extract all image layers into a
 * single merged directory. Resolves the last layer's config to determine the
 * container's working directory, and builds the package path list for
 * subsequent analysis.
 *
 * @param {string} manifestFile Path to the manifest.json (or index.json) file
 * @param {Object} localData Local image inspect data (e.g. from `docker inspect`)
 * @param {string} tempDir Temporary directory that holds the unpacked image
 * @param {string} allLayersExplodedDir Directory where all layers are merged
 * @param {Object} options CLI options (uses `options.failOnError`)
 * @returns {Promise<Object>} Export data object containing `manifest`,
 *   `allLayersDir`, `allLayersExplodedDir`, `lastLayerConfig`,
 *   `lastWorkingDir`, `binPaths`, and `pkgPathList`
 */
export declare const extractFromManifest: (manifestFile: string, localData: Object, tempDir: string, allLayersExplodedDir: string, options: Object) => Promise<Object>;
/**
 * Method to export a container image by using the export feature in docker or podman service.
 * Returns the location of the layers with additional packages related metadata
 */
export declare const exportImage: (fullImageName: any, options: any) => Promise<any>;
/**
 * The gem directories an image's environment names in GEM_HOME, GEM_PATH and
 * BUNDLE_PATH. Only absolute paths without `..` segments are kept, so an image
 * cannot steer the scan outside its own root, and each is normalized; the root
 * and broad system directories such as /usr or /var are refused, so an image
 * cannot turn the gem scan into a scan of the whole tree.
 *
 * @param {string[]|undefined} env image config Env entries, `NAME=value`
 * @returns {string[]} absolute in-image directories, deduplicated, at most
 *   MAX_IMAGE_GEM_DIRS
 */
export declare function imageGemDirs(env: string[] | undefined): string[];
/**
 * Method to retrieve path list for system-level packages
 */
export declare const getPkgPathList: (exportData: any, lastWorkingDir: any) => any[];
/**
 * Remove a container image from the local Docker / Podman daemon.
 *
 * @param {string} fullImageName Full image name including tag or digest (e.g. "ubuntu:22.04")
 * @param {boolean} [force=false] When `true`, force-remove the image even if it is in use
 * @returns {Promise<Buffer|undefined>} Raw response buffer from the daemon, or
 *   `undefined` if no daemon connection is available
 */
export declare const removeImage: (fullImageName: string, force?: boolean) => Promise<Buffer | undefined>;
/**
 * Retrieve a base64url-encoded authentication token for a registry server by
 * invoking the `docker-credential-<exeSuffix>` credential helper binary.
 * Results are cached in `registry_auth_keys` to avoid redundant subprocess
 * calls.
 *
 * @param {string} exeSuffix Credential helper name suffix (e.g. "osxkeychain", "wincred", "pass")
 * @param {string} serverAddress Registry server address (e.g. "https://index.docker.io/v1/")
 * @returns {string|undefined} Base64url-encoded JSON auth token, or `undefined`
 *   if the helper is unavailable or returns an error
 */
export declare const getCredsFromHelper: (exeSuffix: string, serverAddress: string) => string | undefined;
/**
 * Append skipped source-file entries to the `internal:SrcFile` properties of matching
 * components. A component matches when its `oci:SrcImage` property value
 * equals the skipped image's `image` field and the source file path is not
 * already listed.
 *
 * @param {Array<{image: string, src: string}>} skippedImageSrcs List of skipped image/source pairs
 * @param {Array<Object>} components CycloneDX component objects to update in place
 */
export declare const addSkippedSrcFiles: (skippedImageSrcs: Array<{
    image: string;
    src: string;
}>, components: Array<Object>) => void;
//# sourceMappingURL=docker.d.ts.map