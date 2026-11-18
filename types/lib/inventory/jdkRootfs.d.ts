/**
 * The most JDK homes one rootfs is probed at, including the ones the image
 * config names.
 *
 * @type {number}
 */
export declare const MAX_JDK_HOMES: number;
/**
 * The JDK home candidates of an extracted rootfs: the children of the fixed
 * parents that are plain directories (a symbolic link such as sdkman's
 * `current` names a home found under its real name), and any JAVA_HOME the
 * image config names.
 *
 * @param {string} basePath extracted rootfs
 * @param {string[]|undefined} envValues environment of the image config
 * @returns {string[]} absolute home paths, at most MAX_JDK_HOMES
 */
export declare function candidateJdkHomes(basePath: string, envValues: string[] | undefined): string[];
/**
 * Identify the JDKs installed in an extracted rootfs. Each home becomes
 * one `platform` component per identity (a JDK installed twice is one
 * component with two occurrences); the `bin/java` launcher component, when
 * the executables scan found one, is tagged and linked to it. A home an OS
 * package owns is left to that package.
 *
 * @param {string} basePath extracted rootfs the paths are relative to
 * @param {string[]|undefined} ownedFilePaths root-relative paths owned by OS
 *   packages
 * @param {string[]|undefined} envValues environment of the image config
 * @param {Object[]} executables file components from
 *   `fileComponents(.., "executable")`
 * @param {string[]|undefined} osPackageNames names of the OS packages the
 *   scan found. Some package managers list no files (trivy gives none for an
 *   rpm), so a home under a directory only JDK packages install to, such as
 *   /usr/lib/jvm, is package-owned when a JDK package is installed
 * @returns {{jdkComponents: Object[], dependencies: Object[]}}
 */
export declare function collectJdkInfo(basePath: string, ownedFilePaths: string[] | undefined, envValues: string[] | undefined, executables: Object[], osPackageNames: string[] | undefined): {
    jdkComponents: Object[];
    dependencies: Object[];
};
//# sourceMappingURL=jdkRootfs.d.ts.map