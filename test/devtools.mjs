// DevTools suite: captures test/fixture.html with DevTools docked beside the page, which leaves
// the page only part of the window wide, and checks that the capture comes out at the window's
// full width, pixel for pixel the same as a capture with nothing docked. Also checks that a dock
// at the bottom, which only takes height, is left alone. Headless like the other suites: DevTools
// docks in a headless window too. Run with `npm run test:devtools`.

import { join } from "node:path";
import { ROOT, serveDir, launch, capture, savePng, captureBytes, checker } from "./harness.mjs";

const WIDTH = 1400;
const HEIGHT = 900;
const { check, failures } = checker();
const server = await serveDir(join(ROOT, "test"));

/**
 * Load the fixture, capture it, and return the record with the page's width before and after.
 * `docked` says how a docked DevTools shows in the page's size, so the capture waits for it:
 * DevTools opens a moment after the tab, and a capture taken before it docks proves nothing.
 */
async function run(name, options, docked = null) {
  console.log(`\n${name}`);
  const browser = await launch({ width: WIDTH, height: HEIGHT, ...options });
  try {
    const { page } = browser;
    await page.goto(`${server.url}/fixture.html`);
    await page.waitForFunction(() => document.fonts.status === "loaded");
    if (docked) await page.waitForFunction(docked, { WIDTH, HEIGHT }, { timeout: 15000 });
    await page.waitForTimeout(1500); // and let it finish laying itself out
    const before = await page.evaluate(() => ({ vw: innerWidth, vh: innerHeight, outer: outerWidth }));
    const shot = await capture(browser);
    const after = await page.evaluate(() => ({ vw: innerWidth, vh: innerHeight }));
    const png = await savePng(browser.sw, shot.id, name);
    console.log(`  page ${before.vw}×${before.vh} in a ${before.outer} px window → ${shot.cssWidth}×${shot.cssHeight} css px, ${png}`);
    if (process.env.TRACE) console.log(`  trace: ${JSON.stringify(shot.trace)}`);
    return { ...shot, before, after, browser };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

const open = [];
try {
  // The reference: DevTools open but in its own window, so the page has the whole browser window.
  const plain = await run("devtools-undocked", { devtools: "undocked" });
  open.push(plain.browser);
  check(plain.before.vw === WIDTH, "nothing docked: the page has the whole window", `${plain.before.vw} px`);
  check(plain.cssWidth === WIDTH && !plain.notes.length, "nothing docked: captured as is, no note");

  const right = await run("devtools-right", { devtools: "right" }, ({ WIDTH }) => innerWidth <= WIDTH - 200);
  open.push(right.browser);
  check(right.before.vw <= WIDTH - 200, "DevTools docked right narrows the page", `${right.before.vw} of ${WIDTH} px`);
  check(right.cssWidth === WIDTH && right.width === WIDTH, "captured at the window's full width", `${right.cssWidth} css px`);
  check(!right.notes.length, "no note about it on the result page", right.notes.join(" | "));
  check(
    right.trace.some((t) => t.viewport === right.before.vw && t.width === WIDTH),
    "the trace records both widths",
    JSON.stringify(right.trace[0]),
  );
  check(right.after.vw === right.before.vw, "the page is back at its docked width afterwards", `${right.after.vw} px`);
  check(right.cssHeight === plain.cssHeight, "same height as the undocked capture", `${right.cssHeight} vs ${plain.cssHeight}`);
  // The two captures live in different browsers, so compare their bytes through one of them.
  const rightDiff = await crossDiff(plain, right);
  check(!rightDiff.sizeMismatch && rightDiff.differing === 0, "identical to the undocked capture, pixel for pixel", `${rightDiff.differing} px differ`);

  const bottom = await run("devtools-bottom", { devtools: "bottom" }, ({ HEIGHT }) => innerHeight <= HEIGHT - 200);
  open.push(bottom.browser);
  check(bottom.before.vw === WIDTH && bottom.before.vh < HEIGHT - 200, "DevTools docked at the bottom takes only height");
  check(bottom.cssWidth === WIDTH && !bottom.notes.length, "bottom dock: captured as is, no note", bottom.notes.join(" | "));
  check(bottom.cssHeight === plain.cssHeight, "bottom dock: same height as the undocked capture", `${bottom.cssHeight} vs ${plain.cssHeight}`);
  const bottomDiff = await crossDiff(plain, bottom);
  check(!bottomDiff.sizeMismatch && bottomDiff.differing === 0, "bottom dock: identical to the undocked capture", `${bottomDiff.differing} px differ`);
} finally {
  for (const b of open) await b.close();
  server.close();
}

/** Pixel diff between captures held by two different browsers: the first's PNG is decoded in the second's worker. */
async function crossDiff(a, b) {
  const bytes = await captureBytes(a.browser.sw, a.id);
  return b.browser.sw.evaluate(
    async ([b64, id]) => {
      const decode = async (blob) => {
        const bmp = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height);
      };
      const other = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const [x, y] = [await decode(other), await decode((await globalThis.allPanes.getCapture(id)).blob)];
      if (x.width !== y.width || x.height !== y.height) return { sizeMismatch: true, differing: -1 };
      let differing = 0;
      for (let i = 0; i < x.data.length; i += 4) {
        if (x.data[i] !== y.data[i] || x.data[i + 1] !== y.data[i + 1] || x.data[i + 2] !== y.data[i + 2]) differing++;
      }
      return { sizeMismatch: false, differing };
    },
    [bytes.toString("base64"), b.id],
  );
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
