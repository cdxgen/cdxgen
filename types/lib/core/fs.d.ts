import { Buffer } from "node:buffer";
/**
 * Safely check if a file path exists without crashing due to a lack of permissions
 *
 * @param {String} filePath File path
 * @Boolean True if the path exists. False otherwise
 */
export declare function safeExistsSync(filePath: string): any;
/**
 * Permission-aware check for whether a path exists and carries the executable
 * bit for the current user. Answers false instead of throwing when the path
 * is absent, unreadable, or blocked by secure mode.
 *
 * @param {string} filePath File path to check.
 * @returns {boolean} True when the path exists and is executable.
 */
export declare function safeIsExecutableSync(filePath: string): boolean;
/**
 * Permission- and dry-run-aware wrapper around writeFileSync. Records the
 * activity and returns undefined when blocked.
 *
 * The last component of the path is never followed when it is a symbolic
 * link: the link is replaced with a regular file. The standard streams and
 * descriptor paths, such as /dev/stdout, are written through as given.
 *
 * @param {string} filePath File path to write.
 * @param {string|Buffer} data Data to write.
 * @param {Object} [options] writeFileSync options (encoding, mode, flag).
 * @returns {void}
 */
export declare function safeWriteSync(filePath: string, data: string | Buffer, options?: Object): void;
/**
 * Remove a symbolic link from a path that an external tool is about to write.
 * safeWriteSync() keeps cdxgen's own writes from following such a link, but a
 * tool that is handed the path on its command line opens the file itself and
 * would write to the file the link points at. Call this right before the tool
 * runs. The standard streams and descriptor paths are left as given, and nothing is removed
 * in dry-run mode, where the tool does not run either.
 *
 * @param {string} filePath Output path handed to the tool.
 * @returns {boolean} False when the path could not be checked or a symbolic
 *   link there could not be removed, in which case the tool must not be given
 *   the path.
 */
export declare function safeRemoveOutputLinkSync(filePath: string): boolean;
/**
 * Permission- and dry-run-aware write of a sequence of chunks, for content too
 * large to join into one string first. The chunks go to a temporary file next
 * to the target, which is renamed into place once complete, so a chunk may be
 * read from the file being replaced and a failed write leaves the target as it
 * was.
 *
 * @param {string} filePath File path to write.
 * @param {Iterable<string|Buffer>} chunks Chunks written in order.
 * @returns {void}
 */
export declare function safeWriteChunksSync(filePath: string, chunks: Iterable<string | Buffer>): void;
/**
 * Permission-aware wrapper around readFileSync that returns undefined instead
 * of throwing. Reads are allowed in dry-run mode, so unlike the write wrappers
 * this only guards secure-mode read permission; the read itself is not recorded
 * in the activity ledger because inspection of classified paths is already
 * recorded by safeExistsSync and a read has no side effect to audit.
 *
 * @param {string} filePath File path to read.
 * @param {Object|string} [options] readFileSync options; defaults to UTF-8 text.
 * @returns {string|Buffer|undefined} File content, or undefined when the path cannot be read.
 */
export declare function safeReadFileSync(filePath: string, options?: Object | string): string | Buffer | undefined;
/**
 * Safely create a directory without crashing due to a lack of permissions
 *
 * @param {String} filePath File path
 * @param options {Options} mkdir options
 * @Boolean True if the path exists. False otherwise
 */
export declare function safeMkdirSync(filePath: string, options: Options): undefined;
/**
 * Dry-run-aware wrapper around mkdtempSync that records the activity. In dry-run
 * mode, returns a synthetic path without touching the filesystem.
 *
 * @param {string} prefix Path prefix for the temporary directory.
 * @param {string|Object} [options] Encoding or mkdtempSync options.
 * @returns {string|undefined} The created directory path, a synthetic path in dry-run mode, or undefined when blocked.
 */
export declare function safeMkdtempSync(prefix: string, options?: string | Object): string | undefined;
/**
 * Dry-run-aware wrapper around rmSync. Records the activity and returns
 * undefined when blocked.
 *
 * @param {string} filePath Path to remove.
 * @param {Object} [options] rmSync options (recursive, force, etc.).
 * @returns {void}
 */
export declare function safeRmSync(filePath: string, options?: Object): void;
/**
 * Dry-run-aware wrapper around unlinkSync. Records the activity and returns
 * undefined when blocked.
 *
 * @param {string} filePath File path to unlink.
 * @returns {void}
 */
export declare function safeUnlinkSync(filePath: string): void;
/**
 * Dry-run-aware wrapper around copyFileSync. Records the activity and returns
 * undefined when blocked.
 *
 * The last component of the destination is never followed when it is a
 * symbolic link: the link is replaced with a regular file. The standard
 * streams and descriptor paths are copied to as given.
 *
 * @param {string} src Source file path.
 * @param {string} dest Destination file path.
 * @param {number} [mode] Optional copy mode bitmask.
 * @returns {void}
 */
export declare function safeCopyFileSync(src: string, dest: string, mode?: number): void;
/**
 * Dry-run-aware wrapper around chmodSync for a file found in a scanned tree,
 * such as a build wrapper that needs its execute bit. Records the activity
 * and returns undefined when blocked.
 *
 * Only a regular file gets the mode. chmodSync follows symbolic links, so a
 * link committed to a scanned repository under a name cdxgen makes
 * executable, such as gradlew, would pass the mode on to the file or
 * directory it points at. The mode is set through a descriptor opened with
 * O_NOFOLLOW where the platform has it, so a link that appears after the
 * check makes the call fail rather than follow it. Links in the parent
 * directories are followed as usual. Node.js disables fchmod under the
 * permission model, so there the call throws and the mode stays as it was.
 *
 * @param {string} filePath File path to change the mode of.
 * @param {number} mode File mode, such as 0o775.
 * @returns {boolean|undefined} True when the mode was set, false when the path is not a regular file.
 */
export declare function safeChmodSync(filePath: string, mode: number): boolean | undefined;
/**
 * Run an archive extractor under dry-run/debug activity tracing. In dry-run
 * mode the extraction is recorded as blocked and resolves false without running.
 *
 * @param {string} sourcePath Path to the source archive.
 * @param {string} targetPath Path to extract into.
 * @param {() => Promise} extractor Async function performing the extraction.
 * @param {string} [kind="unzip"] Archive kind label for tracing.
 * @param {Object} [options] Optional tracing metadata, blockedReason, and failureReason.
 * @returns {Promise<boolean>} True when extraction succeeded, false when blocked by dry-run.
 */
export declare function safeExtractArchive(sourcePath: string, targetPath: string, extractor: () => Promise<any>, kind?: string, options?: Object): Promise<boolean>;
/**
 * The number of bytes a zip archive may unpack to. The archive is untrusted
 * input and a small one can declare any amount of data, so the allowance
 * follows the size of the file. Archives found inside it are extracted against
 * the same budget, or every level of nesting would multiply it again.
 *
 * @param {string} zipFile Path to the zip archive.
 * @returns {{remainingBytes: number}} Budget for {@link extractZipWithinBudget}.
 */
export declare function createUnzipBudget(zipFile: string): {
    remainingBytes: number;
};
/**
 * Extract every entry of a zip archive, as `zip.extract(null, targetPath)`
 * does, but never write more than the budget allows. An archive whose entries
 * declare more than that is refused before anything is written. The declared
 * sizes are the archive's own claim, so the bytes written are counted as well.
 * A write that fails, as on a full disk, rejects like any other error.
 *
 * @param {Object} zip Open `StreamZip.async` instance for the archive.
 * @param {string} zipFile Path to the zip archive.
 * @param {string} targetPath Directory to extract into.
 * @param {{remainingBytes: number}} [budget] Budget shared with the enclosing archive. Defaults to one for this archive.
 * @returns {Promise<void>}
 */
export declare function extractZipWithinBudget(zip: Object, zipFile: string, targetPath: string, budget?: {
    remainingBytes: number;
}): Promise<void>;
/** Set of temporary file paths written by cdxgen that are removed on process exit. */
export declare const temporaryFiles: Set<any>;
/** Set accumulating every executable command spawned via safeSpawnSync. */
export declare const commandsExecuted: Set<any>;
/**
 * Check a command against the CDXGEN_ALLOWED_COMMANDS allowlist. Every command
 * is allowed when no allowlist is configured.
 *
 * @param {string} command The executable, exactly as it is passed to spawn
 * @param {string} [allowedCommandsEnv] Comma-separated allowlist; defaults to CDXGEN_ALLOWED_COMMANDS
 * @returns {boolean} True when the command may be started
 */
export declare function isAllowedCommand(command: string, allowedCommandsEnv?: string): boolean;
/**
 * Quote one argument of a shell command line that is built as a single
 * string. The shell flag exists so cmd.exe can resolve bare command names,
 * `.cmd` shims and scripts, and every argument is data (paths, flags) that
 * must arrive as one token whatever it contains: joined unquoted, an
 * argument with spaces splits into several and hands the tool the wrong
 * tokens.
 *
 * Windows follows the quoting rules cmd.exe and the MSVC runtimes share:
 * wrap in double quotes, doubling the backslashes that precede a quote and
 * escaping the quote itself. Inside double quotes cmd.exe already treats
 * `&`, `|`, `<`, `>`, `^` and parentheses as literals, and the
 * shell-metacharacter block above refuses `%` and the rest before this
 * runs. A POSIX shell gets single quotes, which no expansion can leave.
 *
 * The same quoting is applied to the command itself when it names an
 * existing file under a path with spaces; a command the shell must parse
 * (a bare name, `sh -c`) never names a file as a whole and stays verbatim.
 *
 * @param {string} arg Argument to quote
 * @param {boolean} [forWindows] Quote for cmd.exe rather than a POSIX shell; defaults to the current platform
 * @returns {string} The argument, quoted when the shell needs it
 */
export declare function shellQuoteArgument(arg: string, forWindows?: boolean): string;
/**
 * Build the single command string a shell spawn runs. Every argument is
 * quoted for the platform shell, so an argument containing spaces stays one
 * token and cannot alter the command, and a command that is itself a file
 * under a path with spaces (`C:\Program Files\...\node.exe`) is quoted too;
 * a command the shell must parse (`sh -c`, a bare name) never names an
 * existing file as a whole and is left verbatim.
 *
 * The one exception is a caller that composes shell fragments itself (sbt
 * command lines embed their own quoting for the shell to strip): it passes
 * `rawShellArgs` and keeps the verbatim join, under the shell-metacharacter
 * block in safeSpawnSync like every other argument.
 *
 * @param {string} command The executable
 * @param {string[]|undefined} args Arguments, when the caller passed any
 * @param {boolean} [rawShellArgs] Join the arguments verbatim instead of quoting them
 * @returns {string} The command line the shell will run
 */
export declare function joinShellCommand(command: string, args: string[] | undefined, rawShellArgs?: boolean): string;
/**
 * Copy an environment into an object without a prototype. Node.js builds a
 * child's environment with for...in, which also lists properties inherited
 * from Object.prototype, so a child must be handed such a copy to receive
 * only the variables that are really set.
 *
 * @param {Object} [env] Environment to copy, process.env by default
 * @returns {Object} Null-prototype copy holding the own properties of env
 */
export declare function ownEnvironment(env?: Object): Object;
/**
 * Start a synchronous child whose environment is exactly the one passed in
 * the options, and return a Node-shaped spawnSync result.
 *
 * Deno's node:child_process spawnSync merges the parent environment under
 * the env option instead of replacing it, so a child started there with a
 * reduced environment still receives every dropped variable
 * (denoland/deno#27343, unfixed as of Deno 2.9). Deno.Command with
 * clearEnv replaces the environment the way Node always has, so under Deno
 * this helper starts the child that way; under every other runtime it
 * delegates to spawnSync, whose env option already replaces.
 *
 * Two spawnSync features have no outputSync equivalent, and this helper
 * cannot honour them: outputSync runs the child to completion however
 * timeout and maxBuffer are set, and it cannot write to a piped stdin, so a
 * caller feeding the child input must stay on the compat spawn. A
 * synchronous child nobody feeds reads an immediately closed stdin either
 * way, which is why every stdin mode but "inherit" maps to the null device.
 *
 * A caller that asks for a shell together with separate arguments gets the
 * metacharacter refusal safeSpawnSync applies, on every runtime: the
 * arguments are folded into one line here, and such a refusal is the only
 * way to keep a quoted argument from becoming a second command.
 *
 * @param {string} command The executable to spawn
 * @param {string[]} [args] Arguments to pass to the command
 * @param {Object} [options] Options as spawnSync accepts them (cwd, env,
 *   stdio, encoding, timeout, shell); input is not supported here
 * @returns {Object} spawnSync result object with status, stdout, stderr and
 *   error fields
 */
export declare function denoClearEnvSpawnSync(command: string, args?: string[], options?: Object): Object;
/**
 * Safe wrapper around spawnSync that enforces permission checks, injects default
 * options (maxBuffer, encoding, timeout), warns about unsafe Python and pip/uv
 * invocations, and records every executed command in the commandsExecuted set.
 *
 * @param {string} command The executable to spawn
 * @param {string[]} args Arguments to pass to the command
 * @param {Object} options Options forwarded to spawnSync (e.g. cwd, env, shell)
 * @returns {Object} spawnSync result object with status, stdout, stderr, and error fields
 */
export declare function safeSpawnSync(command: string, args: string[], options: Object): Object;
/**
 * Asynchronous counterpart of safeSpawnSync for commands that wait on a remote
 * peer: the same checks, defaults and records, without holding the event loop
 * while the command runs. stdout and stderr are always captured and the
 * command gets no input.
 *
 * @param {string} command The executable to spawn
 * @param {string[]} args Arguments to pass to the command
 * @param {Object} options Options as for safeSpawnSync (e.g. cwd, env, shell, timeout)
 * @returns {Promise<Object>} Resolves with a result object shaped like that of safeSpawnSync
 */
export declare function safeSpawn(command: string, args: string[], options: Object): Promise<Object>;
/** Default spawn timeout in milliseconds (20 minutes), overridable via CDXGEN_TIMEOUT_MS. */
export declare const TIMEOUT_MS: number;
/** Default maxBuffer size for spawned process stdout/stderr (100 MB), overridable via CDXGEN_MAX_BUFFER. */
export declare const MAX_BUFFER: number;
/**
 * Method to get files matching a pattern
 *
 * A match that a symbolic link, or a `..` or absolute path in the pattern,
 * places outside the directory searched is left out.
 *
 * @param {string} dirPath Root directory for search
 * @param {string} pattern Glob pattern (eg: *.gradle)
 * @param {Object} options CLI options
 * @param {string} [rootDir] Directory the matches must resolve inside, for a
 *   dirPath that was named by the scanned project. Defaults to dirPath, or to
 *   the exploded image that holds it.
 *
 * @returns {Array[string]} List of matched files
 */
export declare function getAllFiles(dirPath: string, pattern: string, options?: Object, rootDir?: string): any;
/**
 * Confine directory-walk caching to one subtree, or switch it off.
 *
 * @param {string|undefined} rootDir Subtree whose contents are fixed for the rest of the scan
 */
export declare function setDirWalkCacheRoot(rootDir: string | undefined): void;
/**
 * Release every cached directory walk.
 *
 * Called when a BOM generation cycle starts, so that a long-lived process such
 * as the server never serves a scan from an earlier scan's view of the
 * filesystem, and so the retained directory entries are freed.
 */
export declare function clearFileDiscoveryCache(): void;
/**
 * Bound the symbolic links a glob walk goes through.
 *
 * `follow: false` only keeps `**` from walking on through the symbolic links
 * it meets. Every other segment of a pattern, a `*` or a name, goes through
 * the link it matches. Links that lead back into the tree then let a pattern
 * of n segments reach a directory along 2^n paths: two links to `.` and a
 * workspace member pattern of `*` segments are enough, and so are two
 * directories that each hold a link to `..`. A walk with the returned options
 * goes through at most one link on any path below the directory it starts
 * from. That keeps a workspace member that is a link, and bounds the paths of
 * a walk by the links in the tree rather than by the length of the pattern.
 * Use it for every walk whose pattern comes from scanned content.
 *
 * @param {object} globOptions Options of the glob call, including `cwd` and any `ignore` patterns
 * @returns {object} The options to pass to glob instead
 */
export declare function linkBoundedGlobOptions(globOptions: object): object;
/**
 * Method to get files matching a pattern
 *
 * @param {string} dirPath Root directory for search
 * @param {string} pattern Glob pattern (eg: *.gradle)
 * @param {Boolean} includeDot whether hidden files can be included.
 * @param {Array} ignoreList Directory patterns to ignore
 * @param {string} [rootDir] Directory the matches must resolve inside once
 *   symbolic links are followed. Defaults to dirPath.
 *
 * @returns {Array[string]} List of matched files
 */
export declare function getAllFilesWithIgnore(dirPath: string, pattern: string, includeDot: boolean, ignoreList: any[], rootDir?: string): any;
/**
 * Return the current timestamp in YYYY-MM-DDTHH:MM:SSZ format.
 *
 * @returns {string} ISO formatted timestamp, without milliseconds.
 */
export declare function getTimestamp(): string;
/**
 * Return the temp directory, creating CDXGEN_TEMP_DIR when it is set but does
 * not yet exist. Falls back to the OS tmpdir when unset.
 *
 * @returns {string} Resolved temp directory path.
 */
export declare function getTmpDir(): string;
/**
 * Computes the checksum for a file path using the given hash algorithm
 *
 * @param {string} hashName name of hash algorithm
 * @param {string} path path to file
 * @returns {Promise<String>} hex value of hash
 */
export declare function checksumFile(hashName: string, path: string): Promise<string>;
/**
 * Computes multiple checksum for a file path using the given hash algorithms
 *
 * @param {Array[String]} algorithms Array of algorithms
 * @param {string} path path to file
 * @returns {Promise<Object>} hashes object
 */
export declare function multiChecksumFile(algorithms: any, path: string): Promise<Object>;
//# sourceMappingURL=fs.d.ts.map