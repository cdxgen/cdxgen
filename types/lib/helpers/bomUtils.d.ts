export function isSpdxJsonLd(bomJson: any): boolean;
export function normalizeCycloneDxSpecVersion(specVersion: any): number | undefined;
export function toCycloneDxSpecVersionString(specVersion: any): string | undefined;
export function isCycloneDxSpecVersionAtLeast(specVersion: any, minimumVersion: any): boolean;
export function isCycloneDx20SpecVersion(specVersion: any): boolean;
export function getCycloneDxRootFormatKey(specVersionOrBom: any): "specFormat" | "bomFormat";
export function getCycloneDxFormat(bomJson: any): any;
export function hasCycloneDxFormat(bomJson: any): boolean;
export function isCycloneDxBom(bomJson: any): boolean;
export function setCycloneDxFormat(bomJson: object, specVersion: string | number, { preserveLegacyBomFormat }?: object): object;
export function detectBomFormat(bomJson: any): "unknown" | "cyclonedx" | "spdx";
export function getNonCycloneDxErrorMessage(bomJson: any, commandName?: string): string;
//# sourceMappingURL=bomUtils.d.ts.map