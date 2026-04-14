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
export function stripAbsolutePath(path: string): string;
export function getConnection(options: Object, forRegistry?: string): Promise<import("got").Got | undefined>;
export function makeRequest(path: string, method: string, forRegistry?: string): Promise<Object | Buffer | undefined>;
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
export function extractTar(fullImageName: string, dir: string, options: Object): Promise<boolean>;
export function exportArchive(fullImageName: any, options?: {}): Promise<Object | undefined>;
export function extractFromManifest(manifestFile: string, localData: Object, tempDir: string, allLayersExplodedDir: string, options: Object): Promise<Object>;
export function exportImage(fullImageName: any, options: any): Promise<any>;
export function getPkgPathList(exportData: any, lastWorkingDir: any): any[];
export function removeImage(fullImageName: string, force?: boolean): Promise<Buffer | undefined>;
export function getCredsFromHelper(exeSuffix: string, serverAddress: string): string | undefined;
export function addSkippedSrcFiles(skippedImageSrcs: Array<{
    image: string;
    src: string;
}>, components: Array<Object>): void;
//# sourceMappingURL=docker.d.ts.map