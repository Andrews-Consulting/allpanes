// Packaged-build check: unpacks dist/allpanes-<version>.zip and tests exactly what would be uploaded.
// The store build has no test hook, so it is driven the way a user drives it, through the toolbar
// click. Its files are also compared with extension/, so the full fixture suite (which runs on the
// source) vouches for everything the two have in common.
//
//   npm run test:package     (npm run package runs it after building)

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ROOT, EXTENSION, serveDir, launch, captureByClick, checker } from "./harness.mjs";

const { name, version } = JSON.parse(await readFile(join(EXTENSION, "manifest.json"), "utf8"));
const zip = join(ROOT, "dist", `allpanes-${version}.zip`);
const unpacked = await mkdtemp(join(tmpdir(), "allpanes-zip-"));
const { check, failures } = checker();

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"));
  }
  return out.sort();
}

const server = await serveDir(join(ROOT, "test"));
try {
  try {
    execFileSync("unzip", ["-q", zip, "-d", unpacked]);
  } catch {
    console.error(`No ${relative(ROOT, zip)}. Run npm run package first.`);
    process.exit(2);
  }
  console.log(`testing ${relative(ROOT, zip)}`);

  // Same files as the source, byte for byte, except the leftover icon source and the stripped hook.
  const built = await listFiles(unpacked);
  const source = (await listFiles(EXTENSION)).filter((f) => f !== "icons/icon.svg");
  check(JSON.stringify(built) === JSON.stringify(source), "ZIP holds the extension's files and nothing else", `${built.length} files`);
  const differing = [];
  for (const f of built) {
    const [a, b] = [await readFile(join(unpacked, f)), await readFile(join(EXTENSION, f))];
    if (!a.equals(b)) differing.push(f);
  }
  check(
    JSON.stringify(differing) === JSON.stringify(["src/background.js"]),
    "only background.js differs from the source",
    differing.join(", ") || "none",
  );
  const background = await readFile(join(unpacked, "src", "background.js"), "utf8");
  const expected = (await readFile(join(EXTENSION, "src", "background.js"), "utf8")).replace(
    /\n\/\/ test-hook:start[\s\S]*?\/\/ test-hook:end\n/,
    "\n",
  );
  check(background === expected && !background.includes("globalThis.allPanes"), "…and only by the removed test hook");

  const browser = await launch({ extension: unpacked });
  try {
    const { page, sw, context } = browser;

    const loaded = await sw.evaluate(() => ({ manifest: chrome.runtime.getManifest(), hook: typeof globalThis.allPanes }));
    check(loaded.manifest.name === name && loaded.manifest.version === version, "Chrome loads it", `${loaded.manifest.name} ${loaded.manifest.version}`);
    check(loaded.hook === "undefined", "no test hook at runtime", loaded.hook);

    // A full capture of the multi-pane fixture, started by the toolbar click.
    await page.goto(`${server.url}/fixture.html`);
    await page.evaluate(() => {
      document.querySelector("nav").scrollTo({ top: 300, behavior: "instant" });
      document.querySelector("#col").scrollTo({ top: 500, behavior: "instant" });
    });
    const state = () =>
      page.evaluate(() => ({
        vh: innerHeight,
        nav: document.querySelector("nav").scrollTop,
        col: document.querySelector("#col").scrollTop,
        marks: document.querySelectorAll("[data-allpanes],[data-allpanes-freed]").length,
        agent: typeof window.__allPanes,
      }));
    const before = await state();
    const result = await captureByClick(browser);
    const shot = await result.evaluate(() => window.__capture);
    check(shot?.residual === 0 && shot.height > 3 * before.vh, "toolbar click captures every pane", JSON.stringify(shot));
    await page.waitForFunction((h) => innerHeight === h, before.vh, { timeout: 5000 }).catch(() => {});
    const after = await state();
    check(JSON.stringify(after) === JSON.stringify(before), "page restored afterwards", JSON.stringify({ before, after }));

    // Both downloads produce real files of their format.
    const download = async (id) => {
      await result.waitForFunction((b) => document.getElementById(b).textContent.includes("·"), id);
      const [file] = await Promise.all([result.waitForEvent("download"), result.click(`#${id}`)]);
      return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
    };
    const png = await download("download");
    const jpeg = await download("download-alt");
    check(png.bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) && png.name.endsWith(".png"), "Download PNG works", png.name);
    check(jpeg.bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) && jpeg.name.endsWith(".jpg"), "Download JPEG works", jpeg.name);

    // The Options page loads its settings.
    const options = await context.newPage();
    await options.goto(`chrome-extension://${new URL(sw.url()).host}/src/options.html`);
    await options.waitForFunction(() => document.getElementById("quality-value").textContent);
    const opts = await options.evaluate(() => ({
      format: document.querySelector('input[name="format"]:checked')?.value,
      quality: document.getElementById("quality-value").textContent,
    }));
    check(opts.format === "png" && opts.quality === "70%", "Options page shows the defaults", JSON.stringify(opts));
    await options.close();

    // A page Chrome won't let extensions capture gets the plain explanation.
    await page.goto("chrome://version");
    const refused = await captureByClick(browser);
    const notes = await refused.textContent("#notes");
    check(notes.includes("doesn't let extensions capture this page"), "restricted page explains itself", notes.split("\n")[0]);
  } finally {
    await browser.close();
  }
} finally {
  server.close();
  await rm(unpacked, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : "\nAll checks passed");
process.exit(failures.length ? 1 : 0);
