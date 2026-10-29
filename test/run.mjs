// Fixture suite: captures test/fixture.html (a typical web-app shell layout) and checks that every
// pane came out fully expanded, the image is exactly as tall as the tallest pane needs, and the page
// is left exactly as it was found. Run with `npm test`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, serveDir, launch, capture, savePng, diffCaptures, checker } from "./harness.mjs";

const { check, failures } = checker();
const server = await serveDir(join(ROOT, "test"));

// What the image must contain, measured from the live page before capturing.
const expectedHeight = (page) =>
  page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const nav = q("nav"), col = q("#col"), clamped = q("#clamped"), rail = q("#rail");
    const sidebar = q(".brand").offsetHeight + nav.scrollHeight + q(".foot").offsetHeight;
    const main = col.scrollHeight + (clamped.scrollHeight - clamped.clientHeight);
    const railNeed = rail.scrollHeight + 6 + 80; // borders + the calc(100vh - 80px) offset
    return Math.max(sidebar, main, railNeed);
  });

const pageState = (page) =>
  page.evaluate(() => ({
    vh: innerHeight,
    nav: document.querySelector("nav").scrollTop,
    col: document.querySelector("#col").scrollTop,
    clamped: document.querySelector("#clamped").scrollTop,
    clampedStyle: document.querySelector("#clamped").getAttribute("style"),
    marks: document.querySelectorAll("[data-pane-capture],[data-pane-capture-freed]").length,
    agent: typeof window.__paneCapture,
  }));

const scenarios = [
  { name: "fixture-dpr1", dpr: 1, query: "" },
  { name: "fixture-dpr1.5", dpr: 1.5, query: "" },
  // Chrome at 110% zoom. Tiles sized in multiples of 4 CSS px land on fractional device pixels at
  // 1.1, which left an undrawn 1px row across a real 29,000 px capture.
  { name: "fixture-dpr1.1", dpr: 1.1, query: "" },
  { name: "fixture-tall-nav", dpr: 1, query: "?nav=200" }, // sidebar, not main, sets the height
  // Rows arrive mid-capture, after the first expansion pass and before its final check (the long
  // settle puts that check well after the 900 ms arrival), so only the retry can take them in.
  { name: "fixture-late-content", dpr: 1, query: "?late=40", options: { settleMs: 1500 }, expectRetry: true },
];

try {
  for (const s of scenarios) {
    console.log(`\n${s.name}`);
    const browser = await launch({ dpr: s.dpr });
    try {
      const { page } = browser;
      await page.goto(`${server.url}/fixture.html${s.query}`);
      // Leave the panes scrolled part-way, as a user would, so restore is actually exercised.
      await page.evaluate((trace) => {
        // "instant", because the nav is smooth-scrolling and would otherwise still be moving.
        document.querySelector("nav").scrollTo({ top: 300, behavior: "instant" });
        document.querySelector("#col").scrollTo({ top: 500, behavior: "instant" });
        document.querySelector("#clamped").scrollTo({ top: 100, behavior: "instant" });
        // TRACE_STYLE=1 logs the fixed-height pane's style-attribute history. Off by default: an
        // observer forces Blink to reflect inline-style edits eagerly, which hides the very
        // lazy-reflection bug that restore() has to cope with.
        window.__styleLog = [];
        if (!trace) return;
        const clamped = document.querySelector("#clamped");
        new MutationObserver((ms) => {
          for (const m of ms) window.__styleLog.push(`${JSON.stringify(m.oldValue)} -> ${JSON.stringify(clamped.getAttribute("style"))}`);
        }).observe(clamped, { attributeFilter: ["style"], attributeOldValue: true });
      }, !!process.env.TRACE_STYLE);
      const before = await pageState(page);

      const shot = await capture(browser, s.options);
      const png = await savePng(browser.sw, shot.id, s.name);
      console.log(`  ${shot.width}×${shot.height} device px, ${shot.cssHeight} CSS px tall → ${png}`);
      // Measured after the capture, so it includes any rows that arrived during it.
      const expected = await expectedHeight(page);

      check(shot.residual === 0, "every pane fully expanded", `${shot.residual} left overflowing`);
      check(
        shot.retried === !!s.expectRetry,
        s.expectRetry ? "late content was taken in by the retry" : "no retry needed",
        JSON.stringify(shot.trace.filter((t) => t.retry)),
      );
      check(
        shot.cssHeight >= expected && shot.cssHeight <= expected + 2,
        "image height matches the tallest pane (no clipping, no blank band)",
        `expected ${expected}, got ${shot.cssHeight}`,
      );
      check(shot.width === Math.round(1440 * s.dpr), "image width is the viewport width", `${shot.width}`);
      check(shot.height === Math.round(shot.cssHeight * s.dpr), "image is at device resolution", `${shot.height}`);

      // Chrome removes its "started debugging this browser" bar a moment after the extension
      // detaches, and the viewport is 56px short until it does.
      await page.waitForFunction((h) => innerHeight === h, before.vh, { timeout: 5000 }).catch(() => {});
      const after = await pageState(page);
      const restored = JSON.stringify(after) === JSON.stringify(before);
      check(restored, "page restored exactly", restored ? "" : JSON.stringify({ before, after }));
      if (!restored) console.log(`    style history:\n      ${(await page.evaluate(() => window.__styleLog)).join("\n      ")}`);

      // The tiled path (used above 8000 device px) must produce the same pixels as one screenshot.
      // Several tile sizes, because whether a seam appears depends on the fractional part of the
      // tile's device height, which Chrome rounds: at 1.1, 1000 px tiles land on .8 and never gap,
      // while 1004 lands on .2, the same phase as the real 7999.2 px tiles that left a black row.
      for (const tileDevicePx of [1000, 1004, 1013]) {
        const tiled = await capture(browser, { tileDevicePx });
        const diff = await diffCaptures(browser.sw, shot.id, tiled.id);
        check(!diff.sizeMismatch && diff.differing === 0, `tiled capture is pixel-identical (${tileDevicePx} px tiles)`, JSON.stringify(diff));
      }
    } finally {
      await browser.close();
    }
  }
  // Download formats: both buttons, the Options page switching which one is main, and JPEG quality.
  console.log("\ndownload formats");
  const browser = await launch();
  try {
    await browser.page.goto(`${server.url}/fixture.html`);
    const { resultPage } = await capture(browser, {}, { keepResult: true });
    const extensionId = new URL(browser.sw.url()).host;
    const sized = (id) => resultPage.waitForFunction((b) => document.getElementById(b).textContent.includes("·"), id);
    const download = async (id) => {
      await sized(id);
      const [file] = await Promise.all([resultPage.waitForEvent("download"), resultPage.click(`#${id}`)]);
      const bytes = await readFile(await file.path());
      const label = await resultPage.textContent(`#${id}`);
      return { name: file.suggestedFilename(), bytes, label };
    };
    const isPng = (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const isJpeg = (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));

    const png = await download("download");
    const jpeg = await download("download-alt");
    check(isPng(png.bytes) && png.name.endsWith(".png"), "main button downloads PNG by default", `${png.label} → ${png.name}`);
    check(isJpeg(jpeg.bytes) && jpeg.name.endsWith(".jpg"), "second button downloads JPEG", `${jpeg.label} → ${jpeg.name}`);
    // Deliberately no "JPEG is smaller than PNG" check: on flat colour and text, like this fixture,
    // PNG can win outright. On real web-app screenshots JPEG 70% came out about half the PNG.

    // Switch the default in Options; the open result page picks it up without a reload.
    const options = await browser.context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options.html`);
    await options.check('input[name="format"][value="jpeg"]');
    await options.waitForFunction(() => document.getElementById("status").textContent === "Saved");
    await resultPage.waitForFunction(() => document.getElementById("download").dataset.format === "jpeg");
    const main = await download("download");
    check(isJpeg(main.bytes), "after choosing JPEG in Options, the main button downloads JPEG", main.label);

    // Lower quality, smaller file.
    await options.evaluate(() => {
      const q = document.getElementById("quality");
      q.value = "0.5";
      q.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await resultPage.waitForFunction((label) => {
      const t = document.getElementById("download").textContent;
      return t.includes("·") && t !== label;
    }, main.label);
    const low = await download("download");
    check(low.bytes.length < main.bytes.length, "JPEG quality 50% is smaller than the default 70%", `${low.bytes.length} vs ${main.bytes.length} bytes`);

    // A page Chrome refuses to let extensions debug gets a plain explanation, not a raw error.
    console.log("\nrestricted page");
    await browser.page.goto("chrome://version");
    const refused = await capture(browser);
    check(
      refused.shown?.title === "Capture failed" && refused.shown.notes.includes("doesn't let extensions capture this page"),
      "chrome:// page explains why it can't be captured",
      JSON.stringify(refused.shown ?? refused),
    );
  } finally {
    await browser.close();
  }
} finally {
  server.close();
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : "\nAll checks passed");
process.exit(failures.length ? 1 : 0);
