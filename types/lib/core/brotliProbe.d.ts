/**
 * The most files of one kind (executables and libraries, or extension
 * modules) one scan opens in search of a Brotli decoder.
 *
 * @type {number}
 */
export declare const MAX_BROTLI_PROBES: number;
/**
 * The most bytes one scan reads in search of Brotli decoders.
 *
 * @type {number}
 */
export declare const MAX_BROTLI_PROBE_BYTES: number;
/**
 * Read which Brotli decoders a native file embeds and whether each carries
 * the CVE-2026-111497 fix.
 *
 * @param {string} absPath absolute path of the file
 * @param {string|undefined} rootDir extracted root the file must stay under
 * @returns {{c?: {blockSwitchFix: string, evidence: string}, go?: {blockSwitchFix: string}, skipped?: string, size: number}|undefined}
 *   undefined when the file cannot be read or holds no decoder. `c` is
 *   Google's C decoder, with blockSwitchFix `true`, `false` or `unknown` and
 *   the evidence it rests on (`error-names`, `constant-names` or `tables`);
 *   `go` is the Go port. `skipped` is `too-large` for a file over the read cap.
 */
export declare function readBrotliDecoder(absPath: string, rootDir: string | undefined): {
    c?: {
        blockSwitchFix: string;
        evidence: string;
    };
    go?: {
        blockSwitchFix: string;
    };
    skipped?: string;
    size: number;
} | undefined;
//# sourceMappingURL=brotliProbe.d.ts.map