import { close as closeFd, open as openFd } from "node:fs";

import StreamZip from "node-stream-zip";

/**
 * The descriptor behind each archive opened with `openZip()`, so that
 * `closeZip()` can release it even when node-stream-zip will not.
 *
 * @type {WeakMap<StreamZip.StreamZipAsync, number>}
 */
const descriptors = new WeakMap();

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
export async function openZip(file) {
  const fd = await new Promise((resolve, reject) => {
    openFd(file, "r", (err, opened) => (err ? reject(err) : resolve(opened)));
  });
  const zip = new StreamZip.async({ fd });
  descriptors.set(zip, fd);
  return zip;
}

/**
 * Release an archive opened with `openZip()`. It never rejects, and does
 * nothing for `undefined` or an archive that is already released.
 *
 * @param {StreamZip.StreamZipAsync|undefined} zip The archive
 * @returns {Promise<void>}
 */
export async function closeZip(zip) {
  const fd = descriptors.get(zip);
  if (fd === undefined) {
    return;
  }
  descriptors.delete(zip);
  try {
    await zip.entriesCount;
  } catch (_err) {
    // The archive could not be read, and node-stream-zip will not close it.
    await new Promise((resolve) => closeFd(fd, () => resolve()));
    return;
  }
  try {
    await zip.close();
  } catch (_err) {
    // Best effort close
  }
}
