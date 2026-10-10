/**
 * Pure parser for Terraform / OpenTofu module and provider source addresses.
 *
 * A module `source` argument can be a local path, a registry shorthand, a git
 * URL (forced with `git::` or detected from a github.com/gitlab.com/bitbucket.org
 * host or an scp-style `git@host:path` string), a mercurial URL, or an archive
 * URL over http/s3/gcs. The grammar is go-getter's: an optional `<getter>::`
 * prefix, a base address, an optional `//subdirectory` suffix that starts after
 * the `://` of a URL when one is present, and go-getter query parameters such
 * as `ref`, `rev`, `checksum` and `archive`.
 *
 * Source strings are untrusted and can carry credentials (URL passwords, the
 * git `sshkey` parameter, S3 keys), so this module never returns the raw input.
 * The `url` field is rebuilt from parsed, sanitized pieces — userinfo, query
 * and fragment removed — and `displaySource` is assembled from those pieces
 * only. `credentialInSource` flags that a secret-shaped parameter was present
 * without repeating it.
 *
 * Layer 1: no filesystem, no network, no purl construction. Callers turn the
 * returned plain data into components and purls.
 */
export declare const TERRAFORM_REGISTRY_HOST = "registry.terraform.io";
export declare const OPENTOFU_REGISTRY_HOST = "registry.opentofu.org";
/**
 * Parse a module `source` argument into a classified descriptor.
 *
 * @param {string} source Module source string as written in the configuration
 * @param {Object} [options]
 * @param {string} [options.defaultRegistryHost] Host for 3-segment registry
 *   shorthand (`registry.terraform.io` unless the caller knows better)
 * @returns {null|Object} `null` for non-strings, otherwise a descriptor whose
 *   `kind` is `local`, `registry`, `git`, `hg`, `http`, `s3`, `gcs`, `file` or
 *   `unknown`
 */
export declare function parseModuleSource(source: string, { defaultRegistryHost }?: {
    defaultRegistryHost?: string;
}): null | Object;
/**
 * Parse a `required_providers` source string into a provider address.
 *
 * @param {string} source Provider source such as `hashicorp/aws` or
 *   `registry.terraform.io/hashicorp/aws`
 * @param {Object} [options]
 * @param {string} [options.defaultRegistryHost] Host for 2-segment shorthand
 * @returns {null|Object} `{ host, namespace, type, address }` lower-cased,
 *   `{ builtin: true }` for `terraform.io/builtin/*`, or `null`
 */
export declare function parseProviderSource(source: string, { defaultRegistryHost }?: {
    defaultRegistryHost?: string;
}): null | Object;
/**
 * Classify a module `version` constraint by how tightly it pins.
 *
 * @param {string} constraint Constraint string from the configuration
 * @returns {Object} `{ pinning: "exact", version }`, `{ pinning: "range" }` or
 *   `{ pinning: "none" }`
 */
export declare function classifyVersionConstraint(constraint: string): Object;
/**
 * Classify a git/hg ref by how immutably it identifies a commit.
 *
 * @param {string} ref Ref value from `?ref=` or `?rev=`
 * @returns {"sha"|"tag"|"branch"|"none"}
 */
export declare function classifyVcsRef(ref: string): "sha" | "tag" | "branch" | "none";
//# sourceMappingURL=terraformSource.d.ts.map