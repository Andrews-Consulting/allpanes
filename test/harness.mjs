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

export async function launch({ width = 1440, height = 900, dpr = 1 } = {}) {
  const profile = await mkdtemp(join(tmpdir(), "pane-capture-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", // the full build: the headless shell cannot load extensions
    headless: true,
    // A real window size and real display scale, NOT Playwright's viewport emulation. Playwright
    // emulates through the same Emulation domain the extension uses, so the extension's
    // clearDeviceMetricsOverride would wipe Playwright's override too and the page would come back
    // at a different size — a test artifact, since real Chrome has no competing override.
    viewport: null,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
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
      id = await globalThis.paneCapture.captureTab(tab, opts);
    } catch (err) {
      return { error: err.message };
    }
    const { blob, ...meta } = await globalThis.paneCapture.getCapture(id);
    return { id, ...meta };
  }, options);
  const resultPage = await opened;
  if (result.error) {
    // A failed capture still opens the result page, with the explanation in place of the image.
    await resultPage.waitForFunction(() => !document.getElementById("notes").hidden, null, { timeout: 15000 });
    result.shown = { title: await resultPage.textContent("#title"), notes: await resultPage.textContent("#notes") };
    await resultPage.close();
    return result;
  }
  await resultPage.waitForFunction(() => window.__capture, null, { timeout: 15000 });
  if (keepResult) return { ...result, resultPage };
  await resultPage.close();
  return result;
}

/** Write a capture's PNG to test/out/<name>.png and return the path. */
export async function savePng(sw, id, name) {
  const b64 = await sw.evaluate(async (captureId) => {
    const { blob } = await globalThis.paneCapture.getCapture(captureId);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, id);
  await mkdir(OUT, { recursive: true });
  const path = join(OUT, `${name}.png`);
  await writeFile(path, Buffer.from(b64, "base64"));
  return path;
}

/** Count pixels that differ between two stored captures (decoded in the service worker). */
export async function diffCaptures(sw, a, b) {
  return sw.evaluate(
    async ([idA, idB]) => {
      const decode = async (id) => {
        const { blob } = await globalThis.paneCapture.getCapture(id);
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
