export function isSpdxJsonLd(bomJson: any): boolean;
export function isCycloneDxBom(bomJson: any): boolean;
export function detectBomFormat(bomJson: any): "unknown" | "cyclonedx" | "spdx";
export function getNonCycloneDxErrorMessage(bomJson: any, commandName?: string): string;
//# sourceMappingURL=bomUtils.d.ts.map