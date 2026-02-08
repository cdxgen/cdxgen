/**
 * Detect colima
 */
export function detectColima(): any;
/**
 * Detect if Rancher desktop is running on a mac.
 */
export function detectRancherDesktop(): any;
export const isWin: boolean;
export const DOCKER_HUB_REGISTRY: "docker.io";
export function stripAbsolutePath(path: any): any;
export function getDirs(dirPath: string, dirName: string, hidden?: boolean, recurse?: boolean): string[];
export function getOnlyDirs(srcpath: any, dirName: any): any[];
export function getConnection(options: any, forRegistry: any): Promise<any>;
export function makeRequest(path: any, method: any, forRegistry: any): Promise<any>;
export function parseImageName(fullImageName: any): {
    registry: string;
    repo: string;
    tag: string;
    digest: string;
    platform: string;
    group: string;
    name: string;
};
export function getImage(fullImageName: any): Promise<any>;
export function extractTar(fullImageName: any, dir: any, options: any): Promise<boolean>;
export function exportArchive(fullImageName: any, options?: {}): Promise<{
    manifest: {};
    allLayersDir: any;
    allLayersExplodedDir: any;
    lastLayerConfig: {};
    lastWorkingDir: string;
} | {
    inspectData: any;
    manifest: any;
    allLayersDir: any;
    allLayersExplodedDir: any;
    lastLayerConfig: {};
    lastWorkingDir: string;
    binPaths: any;
}>;
export function extractFromManifest(manifestFile: any, localData: any, tempDir: any, allLayersExplodedDir: any, options: any): Promise<{
    inspectData: any;
    manifest: any;
    allLayersDir: any;
    allLayersExplodedDir: any;
    lastLayerConfig: {};
    lastWorkingDir: string;
    binPaths: any;
}>;
export function exportImage(fullImageName: any, options: any): Promise<any>;
export function getPkgPathList(exportData: any, lastWorkingDir: any): any;
export function removeImage(fullImageName: any, force?: boolean): Promise<any>;
export function getCredsFromHelper(exeSuffix: any, serverAddress: any): any;
export function addSkippedSrcFiles(skippedImageSrcs: any, components: any): void;
//# sourceMappingURL=docker.d.ts.map