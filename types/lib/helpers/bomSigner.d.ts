/**
 * Recursively applies signatures to the BOM and its granular components.
 *
 * @param {Object} bomJson - CycloneDX BOM Object
 * @param {Object} options - Signing options { privateKey, algorithm, mode, ... }
 * @returns {Object} - Signed BOM Object
 */
export function signBom(bomJson: Object, options?: Object): Object;
/**
 * Verifies the integrity of a specific element node (e.g., BOM root, Component, Service, Annotation).
 * Resolves standard JSF signatures, multisignature (signers), and chains.
 *
 * @param {Object} node - The BOM or granular object to verify
 * @param {string|crypto.KeyObject} publicKey - The public key corresponding to the signature
 * @returns {boolean|Object} - Signature block if signature is valid. False otherwise.
 */
export function verifyNode(node: Object, publicKey: string | crypto.KeyObject): boolean | Object;
/**
 * Verifies the integrity of a BOM's top-level signature, as well as nested components, services, and annotations.
 * Returns true only if the root signature is valid AND all signed nested elements are valid.
 *
 * @param {Object} bom - CycloneDX BOM Object
 * @param {string|crypto.KeyObject} publicKey - The public key corresponding to the signature
 * @returns {boolean|Object} - Signature block if signature is valid. False otherwise.
 */
export function verifyBom(bom: Object, publicKey: string | crypto.KeyObject): boolean | Object;
//# sourceMappingURL=bomSigner.d.ts.map