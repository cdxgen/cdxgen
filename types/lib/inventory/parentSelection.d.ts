/**
 * Which detected project becomes the parent (`metadata.component`) when one
 * scan covers several ecosystems and no parent was given.
 *
 * Each ecosystem detects its own project from its own manifest. The project
 * whose manifest sits at the scan root describes the repository; one found
 * deeper is a part of it (a web client in `tools/ui/`, a helper script's
 * `pyproject.toml`). So candidates are ordered by how deep their ecosystem's
 * manifests sit, the scan root first, and ties keep the ecosystem order the
 * scan ran in.
 */
/**
 * How deep the shallowest manifest of an ecosystem sits under a scan root:
 * 0 for one at the root itself, `Infinity` when there is none (or the
 * ecosystem is not one this module knows).
 *
 * @param {string} root Scan root
 * @param {string} purlType Purl type of the ecosystem
 * @param {Object} options CLI options (exclusions)
 * @returns {number}
 */
export declare function manifestDepth(root: string, purlType: string, options?: Object): number;
/**
 * Order parent candidates by the depth of their ecosystem's manifests under
 * the scan roots (the shallowest first). The sort is stable, so candidates of
 * equal depth keep the order the ecosystems were scanned in.
 *
 * @param {Object[]} candidates Detected parent components, in scan order
 * @param {string[]} roots Scan roots
 * @param {Object} options CLI options
 * @returns {Object[]} The candidates, reordered
 */
export declare function orderParentCandidates(candidates: Object[], roots: string[], options?: Object): Object[];
//# sourceMappingURL=parentSelection.d.ts.map