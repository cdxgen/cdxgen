export function isHbomLikeBom(bomJson: any): any;
export function getHbomHardwareClass(component: any): any;
export function getHbomHardwareClassCounts(components?: any[]): {
    hardwareClass: any;
    count: any;
}[];
export function formatHbomHardwareClassSummary(hardwareClassCounts?: any[]): string;
export function getHbomSummary(bomJson: any): {
    architecture: any;
    collectorProfile: any;
    componentCount: any;
    evidenceCommandCount: any;
    evidenceCommands: any;
    evidenceFileCount: any;
    evidenceFiles: any;
    hardwareClassCount: number;
    hardwareClassCounts: {
        hardwareClass: any;
        count: any;
    }[];
    identifierPolicy: any;
    manufacturer: any;
    metadataName: any;
    metadataType: any;
    platform: any;
    topHardwareClasses: {
        hardwareClass: any;
        count: any;
    }[];
};
//# sourceMappingURL=hbomAnalysis.d.ts.map