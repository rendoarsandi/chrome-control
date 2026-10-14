import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { ControlError } from './errors.mjs';

// Only explicitly configured, assistant-authored files are loaded. No discovery
// of scripts from browser pages or the current directory.
export async function loadHelperFiles(paths) {
  const sources = [];
  let total = 0;
  for (const path of new Set(paths)) {
    if (!isAbsolute(path)) throw new ControlError('HELPER_PATH_INVALID', 'Helper paths must be absolute.', 'Use an absolute path to an assistant-authored JavaScript file.');
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 65536 || total + info.size > 131072) throw new ControlError('HELPER_FILE_LIMIT',
        'Helpers must be regular files of at most 64 KiB each and 128 KiB total.', 'Provide smaller helper files.');
      // Bound reads even if a file grows after stat; do not read FIFO/device data.
      const buffer = Buffer.alloc(65537);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!read.bytesRead) break;
        bytesRead += read.bytesRead;
      }
      total += bytesRead;
      if (bytesRead > 65536 || total > 131072) throw new ControlError('HELPER_FILE_LIMIT', 'Helper files exceed the size limit.', 'Provide smaller helper files.');
      const code = buffer.subarray(0, bytesRead).toString('utf8');
      sources.push({ path, code, hash: createHash('sha256').update(code).digest('hex') });
    } catch (error) {
      if (error instanceof ControlError) throw error;
      throw new ControlError('HELPER_FILE_UNAVAILABLE', 'Could not read helper file: ' + path, 'Check the file path and host filesystem permissions.');
    } finally { await handle?.close(); }
  }
  return sources;
}
