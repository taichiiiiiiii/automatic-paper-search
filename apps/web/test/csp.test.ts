import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(TEST_DIR, "..", "out");

async function listHtmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listHtmlFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(full);
    }
  }
  return files;
}

function sha256Base64(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("base64");
}

const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;

/** Independent re-implementation of inline-script extraction, kept
 * deliberately separate from scripts/csp-hash.ts so this test can catch
 * bugs in that script rather than merely restating it. */
function collectInlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(SCRIPT_TAG_RE)) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    if (/\bsrc\s*=/.test(attrs)) continue;
    hashes.push(`'sha256-${sha256Base64(body)}'`);
  }
  return hashes;
}

function extractCspContent(html: string): string {
  const match = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i,
  );
  if (!match) {
    throw new Error("no Content-Security-Policy meta tag found");
  }
  return match[1] ?? "";
}

function stripScriptSrc(cspContent: string): string {
  return cspContent
    .split(";")
    .map((d) => d.trim())
    .filter((d) => !d.startsWith("script-src"))
    .join("; ");
}

let htmlFiles: string[] = [];

beforeAll(async () => {
  try {
    await stat(OUT_DIR);
  } catch {
    throw new Error(
      `${OUT_DIR} does not exist. Run "next build" (output: export) before "vitest run".`,
    );
  }
  htmlFiles = await listHtmlFiles(OUT_DIR);
  if (htmlFiles.length === 0) {
    throw new Error(`no .html files found under ${OUT_DIR}`);
  }
});

describe("CSP contract over built out/", () => {
  it("found at least one page to check", () => {
    expect(htmlFiles.length).toBeGreaterThan(0);
  });

  it("every inline script hash on a page is listed in that page's CSP script-src", async () => {
    for (const file of htmlFiles) {
      const html = await readFile(file, "utf8");
      const cspContent = extractCspContent(html);
      const scriptSrcDirective = cspContent
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith("script-src"));
      expect(scriptSrcDirective, `${file}: missing script-src directive`).toBeDefined();

      const actualHashes = collectInlineScriptHashes(html);
      for (const hash of actualHashes) {
        expect(
          scriptSrcDirective?.includes(hash),
          `${file}: inline script hash ${hash} missing from script-src: ${scriptSrcDirective}`,
        ).toBe(true);
      }
    }
  });

  it("no CSP uses 'unsafe-inline'", async () => {
    for (const file of htmlFiles) {
      const html = await readFile(file, "utf8");
      const cspContent = extractCspContent(html);
      expect(cspContent.includes("unsafe-inline"), file).toBe(false);
    }
  });

  it("non-script CSP directives are byte-identical across every page", async () => {
    let reference: { file: string; content: string } | null = null;
    for (const file of htmlFiles) {
      const html = await readFile(file, "utf8");
      const cspContent = extractCspContent(html);
      const nonScript = stripScriptSrc(cspContent);
      if (reference === null) {
        reference = { file, content: nonScript };
        continue;
      }
      expect(nonScript, `${file}: non-script CSP directives differ from ${reference.file}`).toBe(
        reference.content,
      );
    }
  });

  it('no style="" attributes anywhere in the built output', async () => {
    for (const file of htmlFiles) {
      const html = await readFile(file, "utf8");
      expect(/\sstyle\s*=\s*"/i.test(html), file).toBe(false);
    }
  });

  it("no on*= event-handler attributes anywhere in the built output", async () => {
    // Matches on<word>= as an attribute (preceded by whitespace, inside a tag),
    // e.g. onclick=, onerror=. Does not match ordinary text containing "on=".
    const ON_ATTR_RE = /<[a-z][^>]*\son[a-z]+\s*=/i;
    for (const file of htmlFiles) {
      const html = await readFile(file, "utf8");
      expect(ON_ATTR_RE.test(html), file).toBe(false);
    }
  });

  it("no javascript: URLs anywhere in the built output", async () => {
    for (const file of htmlFiles) {
      const html = await readFile(file, "utf8");
      expect(/javascript:/i.test(html), file).toBe(false);
    }
  });

  it("a top-level 404.html exists", async () => {
    const path = join(OUT_DIR, "404.html");
    await expect(stat(path)).resolves.toBeDefined();
  });
});
