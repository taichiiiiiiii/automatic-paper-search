import { promises as fs } from "node:fs";
import path from "node:path";

/** Lists every regular file under `root`, as posix-style paths relative to `root`, sorted. */
export async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const stat = await fs.stat(abs).catch(() => null);
        if (stat?.isFile()) {
          result.push(toPosix(path.relative(root, abs)));
        }
      }
    }
  }

  await walk(root);
  return result.sort();
}

export function readFileBytes(absPath: string): Promise<Buffer> {
  return fs.readFile(absPath);
}

export function readFileText(absPath: string): Promise<string> {
  return fs.readFile(absPath, "utf8");
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
