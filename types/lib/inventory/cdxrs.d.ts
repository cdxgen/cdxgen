/**
 * cdxrs — JS bridge to the Rust-native CycloneDX BOM tooling binary.
 *
 * This module is the ONLY place that spawns the `cdxrs` binary. It enforces
 * the governing invariant: **no failure mode may abort SBOM generation.**
 * Every failure (missing binary, non-zero exit, timeout, oversized stdout,
 * malformed stdout, version-major mismatch, CDXGEN_RS_DISABLE) logs once at
 * `warn` and returns a sentinel that makes the caller take the JS path.
 *
 * Protocol:
 *   cdxrs <subcommand> --input <file|-> --output <file|-> --format json
 *   stdin/stdout carry JSON; stderr carries newline-delimited JSON log records.
 *   Exit codes: 0 ok, 1 operational failure, 2 bad usage, 3 validation findings.
 *
 * See docs/CDXRS_PROTOCOL.md for the full specification.
 */
/** Sentinel returned when the Rust path is unavailable. Callers take JS path. */
export declare const CDXRS_FALLBACK: Readonly<{
    ok: false;
    reason: "fallback";
    stdout: "";
    exitCode: null;
}>;
/**
 * Determine whether a subcommand is disabled by env vars or the --no-rust alias.
 *
 * @param {string} subcommand The subcommand name (e.g. "info").
 * @returns {boolean} True when the Rust path should be skipped.
 */
export declare function cdxrsDisabled(subcommand: string): boolean;
/**
 * Resolve the cdxrs binary path for the current platform.
 *
 * @returns {string|undefined} Path to the binary, or undefined if not found.
 */
export declare function cdxrsBinaryPath(): string | undefined;
/**
 * Check whether cdxrs may be used for a subcommand: it must not be disabled,
 * the binary must be present, the run's policies must allow starting it (see
 * `cdxrsMayStart`), and its major version must match.
 *
 * The disable check comes first and is deliberate. Callers gate on this function
 * to decide between the Rust and JS paths, so it has to honour
 * `CDXGEN_RS_DISABLE` / `--no-rust`; otherwise a disabled run still reports (and
 * would still select) Rust, and `--no-rust` becomes a no-op for every caller
 * that does not go through `runCdxrs`.
 *
 * @param {string} [subcommand] Subcommand to check, e.g. "info".
 * @returns {{ available: boolean, version?: string, reason?: string }}
 */
export declare function cdxrsAvailable(subcommand?: string): {
    available: boolean;
    version?: string;
    reason?: string;
};
/**
 * Optional behaviours the cdxrs binary advertises in the `capabilities` list
 * of `cdxrs schema-version`, such as `fetch-github-token`. A binary that
 * predates the list, or that cannot be used at all, has none. The answer is
 * remembered per binary path for the rest of the run.
 *
 * @param {string} [subcommand] Subcommand the capability belongs to, checked
 *   with {@link cdxrsAvailable} first.
 * @returns {Set<string>} Capability names.
 */
export declare function cdxrsCapabilities(subcommand?: string): Set<string>;
/**
 * Forget the remembered capabilities, for tests that swap the binary.
 */
export declare function resetCdxrsCapabilities(): void;
/**
 * Spawn the cdxrs binary, collect stdout/stderr, enforce a timeout, and
 * kill the process group if the child hangs.
 *
 * Every failure mode logs once at `warn` and returns the CDXRS_FALLBACK
 * sentinel so the caller can take the JS path.
 *
 * Pass BOM data one of two ways:
 *   - `content`: an in-memory string/Buffer, fed to the child over stdin with
 *     `--input -`. Content larger than 32 MB is spilled to a temp file and
 *     passed by path instead, per the protocol; the file is always removed.
 *   - `input`: a path to a file already on disk.
 *
 * Passing `content` is the normal case, since cdxgen holds BOMs in memory.
 *
 * Collected stdout is bounded: it must become a single JS string, so a child
 * that would exceed V8's string limit (by default; see
 * CDXGEN_RS_MAX_STDOUT_BYTES) is killed and reported as a fallback instead of
 * crashing the process at the concat.
 *
 * @param {string} subcommand The subcommand to run (e.g. "info").
 * @param {Object} opts
 * @param {string|Buffer} [opts.content] BOM data to feed over stdin.
 * @param {string} [opts.input] Input file path. Defaults to "-" (stdin), which
 *   requires `content`.
 * @param {string[]} [opts.args] Extra arguments to pass.
 * @param {number} [opts.timeoutMs] Timeout in milliseconds.
 * @param {boolean} [opts.secretContent] The content carries a credential, so
 *   it is never spilled to a temp file; above the stdin limit the call falls
 *   back instead.
 * @returns {Promise<{ok: boolean, stdout: string, exitCode: number|null, reason?: string}>}
 */
export declare function runCdxrs(subcommand: string, opts?: {
    content?: string | Buffer;
    input?: string;
    args?: string[];
    timeoutMs?: number;
    secretContent?: boolean;
}): Promise<{
    ok: boolean;
    stdout: string;
    exitCode: number | null;
    reason?: string;
}>;
//# sourceMappingURL=cdxrs.d.ts.map