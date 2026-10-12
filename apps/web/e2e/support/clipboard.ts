/**
 * Clipboard access that works in every project.
 *
 * Chromium: grant the real clipboard permissions and read the system
 * clipboard back, so the real `navigator.clipboard.writeText` path is
 * exercised.
 *
 * WebKit / Firefox: Playwright cannot grant `clipboard-read` /
 * `clipboard-write` there (`grantPermissions` throws "Unknown permission"),
 * and reading the clipboard needs a user gesture / paste prompt. Instead an
 * init script replaces `navigator.clipboard` with a recorder before any
 * page script runs; the app's copy code (lib/export-formats.ts `copyText`)
 * is unchanged, and the test reads what it wrote.
 *
 * Call `prepareClipboard` BEFORE the first navigation, then
 * `readClipboard` after the copy action.
 */
import type { BrowserContext, Page } from "@playwright/test";

const KEY = "__e2eClipboard";

export async function prepareClipboard(
  context: BrowserContext,
  browserName: string,
  origin: string | undefined,
): Promise<void> {
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    return;
  }
  await context.addInitScript((key: string) => {
    const store = window as unknown as Record<string, string | undefined>;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          store[key] = String(text);
        },
        readText: async () => store[key] ?? "",
      },
    });
  }, KEY);
}

export async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}
