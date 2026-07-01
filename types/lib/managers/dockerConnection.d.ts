export namespace DAEMON_RETRY_OPTIONS {
    let maxRetries: number;
    let methods: string[];
    let statusCodes: number[];
}
export function parseDaemonPrefixUrl(prefixUrl: string): {
    socketPath: (string | undefined);
    baseUrl: string;
};
export function createDaemonConnection(prefixUrl: string, headers?: Object, https?: Object): Object;
//# sourceMappingURL=dockerConnection.d.ts.map