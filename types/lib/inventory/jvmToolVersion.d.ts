/**
 * The version a path names: the directory under `candidates/<tool>` of
 * sdkman, `Cellar/<tool>` of Homebrew, or a directory named like the
 * distribution (`apache-maven-3.9.9`, `gradle-8.14`).
 *
 * @param {string} realPath real path of the executable
 * @param {string} tool tool name, such as `mvn`
 * @returns {string|undefined} version, or undefined
 */
export declare function versionFromToolPath(realPath: string, tool: string): string | undefined;
/**
 * Resolve the version of an executed JVM build tool.
 *
 * @param {string} tool tool name as the registry keys it (`mvn`, `gradle`,
 *   `sbt`, or a wrapper)
 * @param {{command?: string, cwd?: string}} [invocation] how it was invoked
 * @returns {string|undefined} version, or undefined when none is known
 */
export declare function resolveJvmToolVersion(tool: string, invocation?: {
    command?: string;
    cwd?: string;
}): string | undefined;
//# sourceMappingURL=jvmToolVersion.d.ts.map