export function getHbomCommandDiagnostics(bomJson: any): any;
export function getHbomCommandDiagnosticSummary(bomJson: any): {
    actionableDiagnosticCount: any;
    commandDiagnosticCount: any;
    commandDiagnostics: any;
    commandErrorCount: any;
    diagnosticIssues: string[];
    installHints: string[];
    missingCommandCount: any;
    missingCommands: string[];
    partialSupportCount: any;
    permissionDeniedCommands: string[];
    permissionDeniedCount: any;
    privilegeHints: string[];
    requiresPrivilegedEnrichment: boolean;
    timeoutCount: any;
};
export function isHbomLikeBom(bomJson: any): any;
export function getHbomHardwareClass(component: any): any;
export function getHbomHardwareClassCounts(components?: any[]): {
    hardwareClass: any;
    count: any;
}[];
export function formatHbomHardwareClassSummary(hardwareClassCounts?: any[]): string;
export function getHbomSummary(bomJson: any): {
    actionableDiagnosticCount: any;
    architecture: any;
    collectorProfile: any;
    commandDiagnosticCount: any;
    commandDiagnostics: any;
    commandErrorCount: any;
    componentCount: any;
    diagnosticIssues: string[];
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
    installHints: string[];
    manufacturer: any;
    metadataName: any;
    metadataType: any;
    missingCommandCount: any;
    missingCommands: string[];
    partialSupportCount: any;
    platform: any;
    permissionDeniedCommands: string[];
    permissionDeniedCount: any;
    privilegeHints: string[];
    requiresPrivilegedEnrichment: boolean;
    timeoutCount: any;
    topHardwareClasses: {
        hardwareClass: any;
        count: any;
    }[];
};
//# sourceMappingURL=hbomAnalysis.d.ts.map