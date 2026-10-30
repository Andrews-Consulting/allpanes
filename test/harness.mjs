// Shared Playwright plumbing: launch Chromium with the unpacked extension, trigger captures through
// the service worker's test hook (a headless browser has no toolbar to click), and pull the PNG out.
//
// No fixed ports anywhere: Playwright drives the browser over a pipe, and the fixture server binds
// port 0. So it can run alongside other test suites without port clashes.

import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const EXTENSION = join(ROOT, "extension");
export const OUT = join(ROOT, "test", "out");

export async function serveDir(dir) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
  const server = createServer(async (req, res) => {
    try {
      const path = join(dir, new URL(req.url, "http://x").pathname);
      if (!path.startsWith(dir)) throw new Error("outside root");
      const body = await readFile(path);
      res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** `extension` is the folder to load: the source by default, or an unpacked store build. */
export async function launch({ width = 1440, height = 900, dpr = 1, extension = EXTENSION } = {}) {
  const profile = await mkdtemp(join(tmpdir(), "allpanes-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", // the full build: the headless shell cannot load extensions
    headless: true,
    // A real window size and real display scale, NOT Playwright's viewport emulation. Playwright
    // emulates through the same Emulation domain the extension uses, so the extension's
    // clearDeviceMetricsOverride would wipe Playwright's override too and the page would come back
    // at a different size — a test artifact, since real Chrome has no competing override.
    viewport: null,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--window-size=${width},${height}`,
      `--force-device-scale-factor=${dpr}`,
    ],
  });
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent("serviceworker");
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    context,
    sw,
    page,
    close: async () => {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    },
  };
}

/**
 * Capture the tab showing `page`. Returns the stored record's metadata plus its id, and with
 * `keepResult` the still-open result page as `resultPage`.
 */
export async function capture({ context, sw, page }, options = {}, { keepResult = false } = {}) {
  await page.bringToFront();
  const opened = context.waitForEvent("page");
  const result = await sw.evaluate(async (opts) => {
    const [tab] = await chrome.tabs.query({ active: true });
    let id;
    try {
      id = await globalThis.allPanes.captureTab(tab, opts);
    } catch (err) {
      return { error: err.message };
    }
    const { blob, ...meta } = await globalThis.allPanes.getCapture(id);
    return { id, ...meta };
  }, options);
  const resultPage = await opened;
  if (result.error) {
    // A failed capture still opens the result page, with the explanation in place of the image.
    await resultPage.waitForFunction(() => !document.getElementById("notes").hidden, null, { timeout: 15000 });
    // The announcement lands a moment after the note, so screen readers catch it while the tab opens.
    await resultPage.waitForFunction(() => document.getElementById("announce-alert").textContent, null, { timeout: 5000 }).catch(() => {});
    result.shown = {
      title: await resultPage.textContent("#title"),
      heading: await resultPage.evaluate(() => document.getElementById("title").tagName),
      notes: await resultPage.textContent("#notes"),
      alert: await resultPage.textContent("#announce-alert"),
    };
    await resultPage.close();
    return result;
  }
  await resultPage.waitForFunction(() => window.__capture, null, { timeout: 15000 });
  if (keepResult) return { ...result, resultPage };
  await resultPage.close();
  return result;
}

/**
 * Capture the tab showing `page` the way a user does: by firing the toolbar button's click handler.
 * Needs no test hook, so it works on the store build. Returns the result page once it has shown the
 * capture (`window.__capture` set) or the reason it failed.
 */
export async function captureByClick({ context, sw, page }) {
  await page.bringToFront();
  const opened = context.waitForEvent("page");
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true });
    chrome.action.onClicked.dispatch(tab);
  });
  const resultPage = await opened;
  await resultPage.waitForFunction(
    () => window.__capture || document.getElementById("title").textContent === "Capture failed",
    null,
    { timeout: 30000 },
  );
  return resultPage;
}

/** A stored capture's PNG, as bytes. */
export async function captureBytes(sw, id) {
  const b64 = await sw.evaluate(async (captureId) => {
    const { blob } = await globalThis.allPanes.getCapture(captureId);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, id);
  return Buffer.from(b64, "base64");
}

/** Write a capture's PNG to test/out/<name>.png and return the path. */
export async function savePng(sw, id, name) {
  await mkdir(OUT, { recursive: true });
  const path = join(OUT, `${name}.png`);
  await writeFile(path, await captureBytes(sw, id));
  return path;
}

/** Count pixels that differ between two stored captures (decoded in the service worker). */
export async function diffCaptures(sw, a, b) {
  return sw.evaluate(
    async ([idA, idB]) => {
      const decode = async (id) => {
        const { blob } = await globalThis.allPanes.getCapture(id);
        const bmp = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height);
      };
      const [x, y] = [await decode(idA), await decode(idB)];
      if (x.width !== y.width || x.height !== y.height) return { sizeMismatch: true, differing: -1 };
      let differing = 0;
      for (let i = 0; i < x.data.length; i += 4) {
        if (x.data[i] !== y.data[i] || x.data[i + 1] !== y.data[i + 1] || x.data[i + 2] !== y.data[i + 2]) differing++;
      }
      return { sizeMismatch: false, differing };
    },
    [a, b],
  );
}

export function checker() {
  const failures = [];
  const check = (ok, label, detail = "") => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
    if (!ok) failures.push(label);
  };
  return { check, failures };
}
