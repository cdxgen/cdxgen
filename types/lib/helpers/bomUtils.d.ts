/**
 * The default CycloneDX specification version used across cdxgen when a caller
 * does not specify one (matches the `--spec-version` CLI default).
 */
export const DEFAULT_CDX_SPEC_VERSION: 1.7;
export const CYCLONEDX_COMPONENT_TYPES_BY_SPEC_VERSION: Readonly<{
    1.4: readonly string[];
    1.5: readonly string[];
    1.6: readonly string[];
    1.7: readonly string[];
    "2.0": readonly string[];
}>;
export function isSpdxJsonLd(bomJson: any): boolean;
export function normalizeCycloneDxSpecVersion(specVersion: any): number | undefined;
export function toCycloneDxSpecVersionString(specVersion: any): string | undefined;
export function isCycloneDxSpecVersionAtLeast(specVersion: any, minimumVersion: any): boolean;
export function isCycloneDx20SpecVersion(specVersion: any): boolean;
export function getSupportedCycloneDxComponentTypes(specVersion?: number): any[];
export function normalizeCycloneDxComponentTypeFilter(componentType: any): string[];
export function isCycloneDxComponentTypeEnabled(componentType: any, options?: {}): boolean;
export function getCycloneDxRootFormatKey(specVersionOrBom: any): "specFormat" | "bomFormat";
export function getCycloneDxFormat(bomJson: any): any;
export function hasCycloneDxFormat(bomJson: any): boolean;
export function isCycloneDxBom(bomJson: any): boolean;
export function setCycloneDxFormat(bomJson: object, specVersion: string | number, { preserveLegacyBomFormat }?: object): object;
export function detectBomFormat(bomJson: any): "unknown" | "cyclonedx" | "spdx";
export function getNonCycloneDxErrorMessage(bomJson: any, commandName?: string): string;
//# sourceMappingURL=bomUtils.d.ts.map