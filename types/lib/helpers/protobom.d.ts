export function isProtoBomFile(filePath: string): boolean;
export function writeBinary(bomJson: string | Object, binFile: string, specVersion?: string | number): void;
export function readBinary(binFile: string, asJson: boolean, specVersion?: string | number): import("@appthreat/cdx-proto").AnyBom | import("@appthreat/cdx-proto").AnyBomJson | undefined;
//# sourceMappingURL=protobom.d.ts.map