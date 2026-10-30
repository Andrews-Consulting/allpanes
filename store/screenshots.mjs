// Builds the Chrome Web Store screenshots from the demo app (store/demo.html), using the real
// extension, so they always match the current UI:
//   npm run screenshots
// Writes three 1280×800 images to store/screenshots/: the before and after, the result page, and
// the Options screen, each a caption over the real screenshot.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, launch, capture, captureBytes } from "../test/harness.mjs";

const STORE = join(ROOT, "store");
const OUT = join(STORE, "screenshots");
const SIZE = { width: 1280, height: 800 };
// The demo app is served at this address inside the browser (nothing is fetched from the network),
// so the result page shows a believable URL instead of a local test server's. example.com is
// reserved for documentation, so it belongs to no one.
const DEMO_URL = "https://app.example.com/projects/website-relaunch";
// Options page and download buttons are rendered this much larger, by zooming the page itself so
// the text stays sharp rather than being stretched.
const ZOOM = 1.25;

const dataUrl = (png) => `data:image/png;base64,${png.toString("base64")}`;

const CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    width: 1280px; height: 800px; overflow: hidden; position: relative;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f172a;
    background: linear-gradient(160deg, #eef2ff 0%, #f8fafc 55%, #ecfeff 100%);
  }
  header { padding: 44px 56px 0; }
  h1 { margin: 0; font-size: 34px; line-height: 1.15; font-weight: 750; color: #1e1b4b; }
  header p { margin: 10px 0 0; max-width: 920px; font-size: 18px; line-height: 1.4; color: #475569; }
  .stage { position: absolute; inset: 176px 56px 36px; display: flex; align-items: flex-start; justify-content: center; gap: 36px; }
  figure { margin: 0; display: flex; flex-direction: column; gap: 10px; }
  figcaption { font-size: 15px; font-weight: 650; color: #334155; }
  .note { font-size: 14px; line-height: 1.4; color: #64748b; }
  .window, .card { background: #fff; border-radius: 10px; overflow: clip; box-shadow: 0 14px 40px rgb(15 23 42 / .16), 0 0 0 1px rgb(15 23 42 / .08); }
  .chrome { height: 26px; display: flex; align-items: center; gap: 7px; padding: 0 12px; background: #e2e8f0; }
  .chrome i { width: 10px; height: 10px; border-radius: 50%; background: #94a3b8; }
  .window img, .card img { display: block; }
  .buttons { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; padding: 18px; border-radius: 10px; background: #fff; box-shadow: 0 14px 40px rgb(15 23 42 / .16), 0 0 0 1px rgb(15 23 42 / .08); }
  .buttons img { display: block; }
  .buttons + .note { max-width: 300px; }
  .arrow { align-self: center; font-size: 44px; color: #4f46e5; }
`;

const slide = (title, subtitle, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${CSS}</style></head>` +
  `<body><header><h1>${title}</h1><p>${subtitle}</p></header><div class="stage">${body}</div></body></html>`;

// A screenshot shown in a plain browser-window frame, `width` CSS px wide.
const inWindow = (png, width) =>
  `<div class="window"><div class="chrome"><i></i><i></i><i></i></div><img src="${dataUrl(png)}" style="width:${width}px" alt=""></div>`;

const browser = await launch(SIZE);
try {
  const { page, context, sw } = browser;
  const demo = await readFile(join(STORE, "demo.html"));
  await context.route(`${new URL(DEMO_URL).origin}/**`, (route) =>
    route.fulfill({ body: demo, contentType: "text/html; charset=utf-8" }),
  );

  // 1. The demo app as the browser shows it, then allPanes's image of the same page.
  await page.goto(DEMO_URL);
  await page.evaluate(() => document.fonts.ready);
  const before = await page.screenshot();
  const shot = await capture(browser, {}, { keepResult: true });
  const after = await captureBytes(sw, shot.id);
  console.log(`captured the demo app: ${shot.width}×${shot.height} px, ${shot.panes} scroll areas, ${shot.residual} left overflowing`);

  // 2. The result page, once both download sizes are showing.
  const { resultPage } = shot;
  await resultPage.waitForFunction(() => document.getElementById("download-alt").textContent.includes("·"));
  const result = await resultPage.screenshot();
  // The two download buttons on their own, enlarged, for slide 3.
  await resultPage.addStyleTag({ content: `html { zoom: ${ZOOM} }` });
  const jpegButton = await resultPage.locator("#download-alt").screenshot();
  const pngButton = await resultPage.locator("#download").screenshot();

  // 3. The Options page, at about the width of Chrome's options dialog, cropped to its content.
  const options = await context.newPage();
  const optionsWidth = Math.round(560 * ZOOM);
  await options.setViewportSize({ width: optionsWidth, height: 640 });
  await options.goto(`chrome-extension://${new URL(sw.url()).host}/src/options.html`);
  await options.addStyleTag({ content: `html { zoom: ${ZOOM} }` });
  await options.waitForFunction(() => document.getElementById("quality-value").textContent);
  const form = await options.locator("main").boundingBox();
  const optionsPng = await options.screenshot({
    clip: { x: 0, y: 0, width: optionsWidth, height: Math.ceil(form.y + form.height + 10) },
  });

  // The tall capture is scaled to fill the right-hand column's height.
  const afterHeight = 588 - 30 - 26;
  const afterWidth = Math.round((shot.width / shot.height) * afterHeight);

  const slides = {
    "1-every-pane.png": slide(
      "Capture every pane, top to bottom",
      "Web apps scroll their sidebar, content and side panels separately. allPanes expands each one and saves the whole page as one image.",
      `<figure>
         <figcaption>What the browser shows</figcaption>
         ${inWindow(before, 740)}
         <p class="note">The sidebar, the task list and the details panel each stop at the edge of the window.</p>
       </figure>
       <span class="arrow" aria-hidden="true">→</span>
       <figure>
         <figcaption>What allPanes saves</figcaption>
         ${inWindow(after, afterWidth)}
       </figure>`,
    ),
    "2-result-page.png": slide(
      "Copy it, or download it as PNG or JPEG",
      "Each capture opens in its own tab, with the file size of each format shown before you choose.",
      inWindow(result, 960),
    ),
    "3-options.png": slide(
      "Pick your default format and JPEG quality",
      "PNG keeps text sharp. JPEG at 70% is about half the size, for when you're sending a capture to someone.",
      `<figure>
         <figcaption>Options</figcaption>
         <div class="card"><img src="${dataUrl(optionsPng)}" style="width:${optionsWidth}px" alt=""></div>
       </figure>
       <figure>
         <figcaption>On the result page</figcaption>
         <div class="buttons">
           <img src="${dataUrl(pngButton)}" alt="">
           <img src="${dataUrl(jpegButton)}" alt="">
         </div>
         <p class="note">The same capture in both formats. Each button shows its file size, so you can pick before you download.</p>
       </figure>`,
    ),
  };

  await mkdir(OUT, { recursive: true });
  const render = await context.newPage();
  await render.setViewportSize(SIZE);
  for (const [name, html] of Object.entries(slides)) {
    await render.setContent(html);
    await render.waitForFunction(() => [...document.images].every((img) => img.complete));
    const png = await render.screenshot();
    await writeFile(join(OUT, name), png);
    console.log(`store/screenshots/${name}`);
  }
} finally {
  await browser.close();
}
