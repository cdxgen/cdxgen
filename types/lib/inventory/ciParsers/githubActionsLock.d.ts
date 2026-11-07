/**
 * Maximum accepted lockfile size. `gh actions-lock` writes files that stay
 * far below this; anything larger is treated as corrupt rather than parsed.
 * @type {number}
 */
export declare const MAX_ACTIONS_LOCKFILE_BYTES: number;
export type ActionsLockDependency = {
    /**
     * Owner name, lower case.
     */
    owner: string;
    /**
     * Repository name, lower case.
     */
    repo: string;
    /**
     * Ref the commit was resolved from, with its case
     * preserved. For a v0.0.1 entry this is the tag, else the branch. It can
     * differ from the ref in the pin key: the key keeps the ref the workflow
     * wrote (for example `v4`) while this field records the resolved one (for
     * example `v4.3.1`).
     */
    ref: string;
    /**
     * "sha1" or "sha256".
     */
    hashAlgo: string;
    /**
     * Hex digest without the algorithm prefix.
     */
    commit: string;
    /**
     * Numeric id of the action's owner.
     */
    ownerId: number;
    /**
     * Numeric id of the action's repository.
     */
    repoId: number;
    /**
     * Set only when the entry records one
     * (v0.0.3); undefined means the home host.
     */
    hostname: string | undefined;
    /**
     * Normalised pin keys of the direct dependencies;
     * empty for leaf actions.
     */
    uses: string[];
};
export type ActionsLockfile = {
    /**
     * Version as written in the file; null for an
     * empty result.
     */
    version: string | null;
    /**
     * Set only when an older version
     * was normalised.
     */
    sourceVersion: string | undefined;
    /**
     * Map of repository-relative
     * workflow path (always with "/" separators) to its flat pin list.
     */
    workflows: Record<string, string[]>;
    /**
     * Map of
     * normalised pin key to the resolved entry.
     */
    dependencies: Record<string, ActionsLockDependency>;
    /**
     * Human-readable problems found while reading.
     */
    warnings: string[];
};
/**
 * Parse an actions lockfile from its text content.
 *
 * Every problem, including a file that cannot be parsed at all, is reported
 * as a warning and collapses the result to the empty shape; the function
 * never throws.
 *
 * @param {string} text Lockfile content
 * @param {string} [filePath] Path the content came from, used in warnings
 * @returns {ActionsLockfile} Parsed lockfile, or the empty shape
 */
export declare function parseActionsLockfileString(text: string, filePath?: string): ActionsLockfile;
/**
 * Read and parse an actions lockfile such as
 * `.github/workflows/actions.lock`.
 *
 * The file is size-checked before it is read, and every problem is reported
 * as a warning and collapses the result to the empty shape; the function
 * never throws.
 *
 * @param {string} filePath Path to the lockfile
 * @returns {ActionsLockfile} Parsed lockfile, or the empty shape
 */
export declare function parseActionsLockfile(filePath: string): ActionsLockfile;
//# sourceMappingURL=githubActionsLock.d.ts.map