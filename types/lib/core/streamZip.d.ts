import StreamZip from "node-stream-zip";
/**
 * Open a zip archive with the promise API of node-stream-zip. Release it with
 * `closeZip()` in a `finally` block, whatever happened to it.
 *
 * node-stream-zip keeps the descriptor of an archive it fails to read, such as
 * a file that is not a zip: its async `close()` waits for the archive to be
 * read and rejects instead of closing anything. The descriptor is therefore
 * opened here, so that `closeZip()` can release it in that case too.
 *
 * @param {string} file Path to the archive
 * @returns {Promise<StreamZip.StreamZipAsync>} The archive
 */
export declare function openZip(file: string): Promise<StreamZip.StreamZipAsync>;
/**
 * Release an archive opened with `openZip()`. It never rejects, and does
 * nothing for `undefined` or an archive that is already released.
 *
 * @param {StreamZip.StreamZipAsync|undefined} zip The archive
 * @returns {Promise<void>}
 */
export declare function closeZip(zip: StreamZip.StreamZipAsync | undefined): Promise<void>;
//# sourceMappingURL=streamZip.d.ts.map