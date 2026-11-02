import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Writes a file atomically: the content goes to a temporary file in the same directory, which is then
 * renamed over the target. A crash leaves either the old or the new file, never a half-written one.
 */
export function writeAtomic(path: string, content: string | Buffer) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
