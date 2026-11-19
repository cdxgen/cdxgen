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
 * the CVE-2026-111497 fix, and say what the answer cost. A file without a
 * decoder is read to its end to learn that, so a caller with a byte budget
 * charges `bytesRead` for every file, not only for the ones with a decoder.
 *
 * @param {string} absPath absolute path of the file
 * @param {string|undefined} rootDir extracted root the file must stay under
 * @returns {{decoder: {c?: {blockSwitchFix: string, evidence: string}, go?: {blockSwitchFix: string}, skipped?: string, size: number}|undefined, bytesRead: number}}
 *   `decoder` is undefined when the file cannot be read or holds no decoder.
 *   `c` is Google's C decoder, with blockSwitchFix `true`, `false` or
 *   `unknown` and the evidence it rests on (`error-names`, `constant-names` or
 *   `tables`); `go` is the Go port. `skipped` is `too-large` for a file over
 *   the read cap. `bytesRead` is the size of a file that was read and 0 for
 *   one that was skipped or could not be opened.
 */
export declare function probeBrotliDecoder(absPath: string, rootDir: string | undefined): {
    decoder: {
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
    bytesRead: number;
};
/**
 * Read which Brotli decoders a native file embeds and whether each carries
 * the CVE-2026-111497 fix.
 *
 * @param {string} absPath absolute path of the file
 * @param {string|undefined} rootDir extracted root the file must stay under
 * @returns {{c?: {blockSwitchFix: string, evidence: string}, go?: {blockSwitchFix: string}, skipped?: string, size: number}|undefined}
 *   the `decoder` of probeBrotliDecoder: undefined when the file cannot be
 *   read or holds no decoder.
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