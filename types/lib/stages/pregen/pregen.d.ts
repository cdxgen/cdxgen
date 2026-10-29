/**
 * Method to prepare the build environment for BOM generation purposes.
 *
 * @param {String} filePath Path
 * @param {Object} options CLI options
 */
export declare function prepareEnv(filePath: string, options: Object): void;
/**
 * Check that dosai, which deep runs use for .NET evidence, can start. The
 * dosai bundled with cdxgen-plugins-bin is framework-dependent, so it needs a
 * .NET runtime at least as new as the one it targets (.NET 11 from dosai
 * 5.0.0). Running it lets the .NET host apply its own version rules. Skipped
 * in the container images, which ship a dosai that works with their SDK, and
 * when DOSAI_CMD names another build, such as the self-contained -full one.
 *
 * @param {String} filePath Project path
 * @param {Object} options CLI options
 */
export declare function prepareDotnetEnv(filePath: string, options: Object): void;
/**
 * Method to prepare sdkman build environment for BOM generation purposes.
 *
 * @param {String} projectType Project type
 */
export declare function prepareSdkmanBuild(projectType: string): boolean | undefined;
/**
 * Method to detect and provision JVM build tools (maven, gradle, sbt, scala)
 * plus a compatible JDK before BOM generation.
 *
 * Two styles are supported:
 * - Explicit: a versioned project type such as `-t maven3.9.9` installs that
 *   exact sdkman version and pins it for the generation step.
 * - Automatic: with the `jvm-tool-setup` feature flag, tool versions are
 *   derived from repo markers (`.sdkmanrc`, build tool wrappers,
 *   `project/build.properties`) and missing tools are provisioned. Projects
 *   pinning a tool through a wrapper are left alone because the wrapper
 *   provisions itself; only JDK compatibility is checked.
 *
 * @param {String} filePath Project path
 * @param {Object} options CLI options
 *
 * @returns {String|undefined} The `javaNN` project type whose JDK this call
 *   already provisioned, so the caller can skip installing it again.
 */
export declare function prepareJvmBuildEnv(filePath: string, options: Object): string | undefined;
/**
 * Report the JVM toolchain that would be provisioned, without provisioning it.
 *
 * Dry-run exists so that the reader can see every side effect cdxgen would
 * cause before allowing it to run for real, and provisioning a toolchain is
 * the largest side effect this stage has: it downloads and installs software
 * and then rewrites the command environment used for the rest of the run.
 * Skipping the stage silently would hide exactly what dry-run is for, so each
 * install, each JDK decision, and each environment variable that would change
 * is recorded as a blocked activity instead.
 *
 * @param {Object} options CLI options
 * @param {Array} installPins Tools that would be installed
 * @param {Object} detected Repo detection result
 */
export declare function recordJvmBuildEnvIntent(options: Object, installPins: any[], detected: Object): void;
/**
 * Detect the JVM build tools a project needs from its own version pins, in
 * precedence order: MAVEN_TOOL style overrides, `.sdkmanrc`, container/CI
 * version hints, then build tool wrappers and repo markers. Wrapper-pinned
 * tools are returned as known versions without an install because the
 * wrapper downloads its own distribution.
 *
 * @param {String} filePath Project path
 * @param {Array} explicitPins Pins collected from versioned project types
 *
 * @returns {Object} `{ installPins, wrapperVersions, javaVersionHint }`
 */
export declare function detectJvmToolsFromRepo(filePath: string, explicitPins: any[]): Object;
/**
 * Resolve a tool pin to an exact, locally known version. Exact versions that
 * are already installed pass through untouched; otherwise the available
 * sdkman versions are consulted to resolve partial prefixes such as `3.9`
 * and to pick defaults.
 *
 * @param {Object} pin `{ tool, version?, source }`
 * @param {Number|undefined} javaMajor JDK major the project declared or
 *   configured, when known. Constrains the default Gradle install so a
 *   project on a new JDK never resolves a Gradle that cannot run on it.
 *
 * @returns {Object|undefined} Pin with an exact version, or undefined when no
 *   version could be determined.
 */
export declare function resolveJvmToolPinVersion(pin: Object, javaMajor?: number): Object | undefined;
/**
 * Fetch the versions available for a candidate via `sdk list`.
 *
 * @param {String} tool sdkman candidate name
 *
 * @returns {String|undefined} Command output, or undefined on failure.
 */
export declare function fetchSdkmanVersionList(tool: string): string | undefined;
/**
 * Check whether a JVM build tool already has a usable command, honouring the
 * existing `MVN_CMD`/`GRADLE_CMD`/`SBT_CMD` overrides.
 *
 * The probe deliberately runs outside the scanned project. Build tool
 * launchers read JVM arguments from the working directory before doing
 * anything else - Maven from `.mvn/jvm.config` and sbt from `.jvmopts` or
 * `.sbtopts` - so a `--version` call inside a project would let that project
 * inject options such as `-javaagent` into the probe. Only the presence of a
 * working command is being established here, which the project cannot affect.
 *
 * @param {String} tool Tool name
 *
 * @returns {Boolean} True when the tool responds to `--version`.
 */
export declare function isJvmToolUsable(tool: string): boolean;
/**
 * Ensure a JDK compatible with the pinned tools is active. Installs a JDK
 * only when the current java is missing or older than required; an explicit
 * `javaNN` project type is honoured as-is with a warning when it is too old.
 *
 * @param {String} filePath Project path
 * @param {Object} options CLI options
 * @param {Array} knownToolVersions Tool versions that will run
 * @param {Number} javaVersionHint JDK major requested by the repo
 *
 * @returns {Number|undefined} Effective JDK major after the check.
 */
export declare function ensureCompatibleJdk(filePath: string, options: Object, knownToolVersions: any[], javaVersionHint: number): number | undefined;
/**
 * JDK major a versioned java project type names, such as 27 for `java27`.
 *
 * @param {string} projectType Project type
 * @returns {number|undefined} The major, or undefined for any other type
 */
export declare function javaMajorFromProjectType(projectType: string): number | undefined;
/**
 * Pick the closest `javaNN` alias covering a required JDK major.
 *
 * @param {Number} major Required JDK major
 *
 * @returns {String|undefined} Alias such as `java17`.
 */
export declare function pickJavaAliasForMajor(major: number): string | undefined;
/**
 * Warn when the Gradle version in play cannot run on the effective JDK.
 *
 * @param {Array} knownToolVersions Tool versions that will run
 * @param {Number} javaMajor Effective JDK major
 */
export declare function warnGradleJavaIncompatibility(knownToolVersions: any[], javaMajor: number): void;
/**
 * Install a pinned tool unless it is already available, applying the failure
 * policy used by the ruby preparation: continue with whatever exists unless
 * both `deep` and `failOnError` are set.
 *
 * @param {Object} pin `{ tool, version, source }`
 * @param {Object} options CLI options
 *
 * @returns {Boolean} True when the exact version is active.
 */
export declare function provisionJvmTool(pin: Object, options: Object): boolean;
/**
 * Point the tool command environment variables at the freshly provisioned
 * binary so the existing resolvers pick it up deterministically.
 *
 * @param {Object} pin `{ tool, version }`
 */
export declare function setJvmToolCommandEnv(pin: Object): void;
/**
 * Method to check and prepare the environment for python
 *
 * @param {String} _filePath Path
 * @param {Object} options CLI Options
 */
export declare function preparePythonEnv(_filePath: string, options: Object): void;
/**
 * Method to check and prepare the environment for node
 *
 * @param {String} filePath Path
 * @param {Object} options CLI Options
 */
export declare function prepareNodeEnv(filePath: string, options: Object): void;
/**
 * If NVM_DIR is in path, however nvm command is not loaded.
 * it is possible that required nodeVersion is not installed.
 * This function loads nvm and install the nodeVersion
 *
 * @param {String} nodeVersion required version number
 *
 * @returns {Boolean} true if successful, otherwise false
 */
export declare function tryLoadNvmAndInstallTool(nodeVersion: string): boolean;
/**
 * This method installs and create package-lock.json
 *
 * @param {String} filePath Path
 * @param {String} nvmNodePath Path to node version in nvm
 * @param {Object} [options] CLI options
 */
export declare function doNpmInstall(filePath: string, nvmNodePath: string, options?: Object): void;
/**
 * Method to check and build the swift project
 *
 * @param {String} filePath Path
 * @param {Object} options CLI Options
 */
export declare function prepareSwiftEnv(filePath: string, options: Object): void;
export declare function prepareRubyEnv(filePath: any, options: any): void;
//# sourceMappingURL=pregen.d.ts.map