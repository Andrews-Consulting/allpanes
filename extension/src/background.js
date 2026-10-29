import { agent } from "./agent.js";
import { putCapture, getCapture } from "./store.js";

// How the capture works: rather than scrolling each pane and stitching strips (which repeats sticky
// headers and rails in every strip), the debugger protocol tells the page its viewport is as tall as
// the tallest pane needs. Panes sized to the window (h-dvh flex shells, calc(100vh - …) rails) then
// show all their content with nothing scrolled, and one screenshot captures the lot. Panes with a
// fixed height (max-h-80 tables) do not grow with the window, so their height limit is lifted for
// the duration of the capture. Everything is put back afterwards.

const PROTOCOL_VERSION = "1.3";
const PROBE_PX = 200; // how far to grow the window to learn which panes follow its height
const MAX_ROUNDS = 10;
const MAX_DEVICE_PX = 32000; // canvas limit is 32767 per side
const TILE_DEVICE_PX = 8000; // GPU-composited screenshots much past 16k device px can come back garbled
const SETTLE_MS = 700; // charts re-render and lazy images load after the resize
const RETRY_WAIT_MS = 1500; // before the second pass, when the first left something overflowing
const RETRY_RESIZE_SETTLE_MS = 250; // pause after each resize on the second pass, for slow layouts

const busy = new Set();

chrome.action.onClicked.addListener((tab) => {
  captureTab(tab).catch((err) => console.error("Pane Capture failed:", err));
});

/** Capture `tab` and open the result in a new tab. Resolves to the capture id. */
async function captureTab(tab, options = {}) {
  if (busy.has(tab.id)) return null;
  busy.add(tab.id);
  const target = { tabId: tab.id };
  const send = (method, params = {}) => chrome.debugger.sendCommand(target, method, params);
  const call = (name, ...args) => evaluate(send, `window.__paneCapture.${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);

  await chrome.action.setBadgeText({ tabId: tab.id, text: "…" }).catch(() => {});
  let shot = null;
  let error = null;
  let attached = false;
  try {
    await chrome.debugger.attach(target, PROTOCOL_VERSION);
    attached = true;
    await evaluate(send, `(${agent.toString()})()`);
    shot = await expandAndCapture(send, call, options);
  } catch (err) {
    error = err;
  } finally {
    if (attached) {
      await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await call("restore").catch(() => {});
      await chrome.debugger.detach(target).catch(() => {});
    }
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {});
    busy.delete(tab.id);
  }

  let query;
  let id = null;
  if (shot) {
    id = await putCapture({ ...shot, takenAt: Date.now() });
    query = `id=${encodeURIComponent(id)}`;
  } else {
    query = `error=${encodeURIComponent(explain(error, attached))}`;
  }
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`src/result.html?${query}`),
    index: tab.index + 1,
    openerTabId: tab.id,
  });
  if (error) throw error;
  return id;
}

// What the result page tells the user when a capture fails: the likely reason in plain words, with
// Chrome's own message kept underneath as the detail.
function explain(error, attached) {
  const detail = error?.message ?? String(error);
  let message;
  if (/already attached/i.test(detail)) {
    message =
      "Another extension or tool is already using the debugger on this tab. Close it, or capture " +
      "from a different tab, and try again.";
  } else if (!attached || /cannot access|cannot be scripted|chrome:\/\/|chrome-extension:\/\//i.test(detail)) {
    // attach() is refused on Chrome's own pages, the Web Store, other extensions' pages and the PDF viewer.
    message =
      "Chrome doesn't let extensions capture this page. Chrome's own pages (chrome://…), the Chrome " +
      "Web Store, other extensions' pages and the built-in PDF viewer are all off limits.";
  } else {
    message = "The capture failed partway through. Try again; if it keeps failing, the detail below says why.";
  }
  return `${message}\n\nDetails: ${detail}`;
}

async function evaluate(send, expression) {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  }
  return result.value;
}

async function expandAndCapture(send, call, options) {
  const start = await call("measure");
  const { vw, dpr } = start;
  const maxHeight = Math.floor(MAX_DEVICE_PX / dpr);
  let height = start.vh;

  let resizeSettleMs = 0; // extra pause after each resize; raised for the retry pass
  const setHeight = async (h) => {
    height = Math.min(maxHeight, Math.ceil(h));
    await send("Emulation.setDeviceMetricsOverride", { width: vw, height, deviceScaleFactor: dpr, mobile: false });
    await call("settle", resizeSettleMs);
  };

  // Pin the current size so the override, not the window, owns layout from here on.
  await setHeight(height);

  // How much a pane's height changes per pixel of window height: ~1 for a flex pane in a
  // full-height shell, 0.55 for a 55vh modal body, 0 for a fixed max-h-80 table.
  const ratios = new Map();
  // What each round saw and did, kept on the capture record for diagnosing one that came out short.
  const trace = [];

  // Grow the window and free fixed-height panes until nothing overflows, or MAX_ROUNDS run out.
  const expand = async () => {
    let m = await call("measure");
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const todo = m.panes.filter((p) => p.overflow > 1 && !p.freed);
      const step = { height, docOverflow: m.docOverflow, todo: todo.map((p) => `${p.id}:${p.overflow}/${p.client}`) };
      trace.push(step);

      if (todo.some((p) => !ratios.has(p.id)) && height < maxHeight) {
        const base = height;
        await setHeight(base + PROBE_PX);
        const probe = await call("measure");
        const grown = height - base;
        for (const p of todo) {
          if (ratios.has(p.id)) continue;
          const after = probe.panes.find((q) => q.id === p.id);
          ratios.set(p.id, after ? (after.client - p.client) / grown : 0);
        }
        // Back to the measured height, so the growth below is exact and leaves no blank band.
        await setHeight(base);
      }

      let need = Math.max(0, m.docOverflow);
      let freed = 0;
      for (const p of todo) {
        const ratio = ratios.get(p.id) ?? 0;
        if (ratio < 0.02) {
          await call("free", p.id);
          freed++;
        } else {
          need = Math.max(need, p.overflow / Math.min(ratio, 1));
        }
      }
      Object.assign(step, { ratios: todo.map((p) => `${p.id}:${(ratios.get(p.id) ?? 0).toFixed(2)}`), need: Math.round(need), freed });
      if (need <= 1 && !freed && !m.changed) break;
      if (need > 1 && height < maxHeight) await setHeight(height + need);
      else await call("settle", resizeSettleMs);
      m = await call("measure");
    }
  };

  // Let charts re-render and lazy content load, then see whether anything still overflows.
  const finalMeasure = async () => {
    await call("settle", options.settleMs ?? SETTLE_MS);
    const m = await call("measure");
    return { m, residual: m.panes.filter((p) => p.overflow > 1).length + (m.docOverflow > 1 ? 1 : 0) };
  };

  await expand();
  let { m, residual } = await finalMeasure();

  // One retry when something still overflows. The usual cause is a page that was still loading or
  // re-rendering: rows arriving after the expansion finished, or a layout too slow to answer the
  // 200px probe, so a pane that does follow the window measured as fixed. Wait for the page to
  // quiet down, re-learn the panes still overflowing, pause longer after each resize, go again.
  let retried = false;
  if (residual && height < maxHeight) {
    retried = true;
    trace.push({ retry: `${residual} still overflowing; waiting ${RETRY_WAIT_MS} ms` });
    await call("settle", RETRY_WAIT_MS);
    for (const p of m.panes) if (p.overflow > 1) ratios.delete(p.id);
    resizeSettleMs = RETRY_RESIZE_SETTLE_MS;
    await expand();
    ({ m, residual } = await finalMeasure());
  }

  const notes = [];
  if (residual && height >= maxHeight) {
    notes.push(`The image stops at ${maxHeight} px tall (the browser's limit); content below that is cut off.`);
  } else if (residual) {
    notes.push(`${residual} scroll area(s) could not be fully expanded and may be cut off.`);
  }

  const image = await screenshot(send, vw, height, dpr, options.tileDevicePx ?? TILE_DEVICE_PX, m.background);
  return {
    ...image,
    dpr,
    cssWidth: vw,
    cssHeight: height,
    panes: m.panes.length,
    residual,
    retried,
    notes,
    trace,
    url: m.url,
    title: m.title,
  };
}

// The smallest CSS height whose device height is a whole number at this scale: 10 at 1.1 (110%
// zoom), 5 at 1.2, 4 at 1.25, 2 at 1.5. Tiles cut on multiples of it start and end on exact device
// pixels. Cut anywhere else and each tile's device height is fractional, Chrome rounds it, and the
// rounding drifts until one tile is drawn a row below where the last one ended. At 1.1 with
// 7272 px tiles that left row 23,997 of a capture undrawn: a black line across the page.
function alignedStep(dpr) {
  for (let m = 1; m <= 20; m++) {
    if (Math.abs(m * dpr - Math.round(m * dpr)) < 1e-6) return m;
  }
  return 1;
}

async function screenshot(send, vw, vh, dpr, tileDevicePx, background) {
  const width = Math.round(vw * dpr);
  const height = Math.round(vh * dpr);
  const shoot = async (clip) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      ...(clip && { clip: { ...clip, scale: 1 } }),
    });
    return (await fetch(`data:image/png;base64,${data}`)).blob();
  };

  if (height <= tileDevicePx) return { blob: await shoot(null), width, height };

  const step = alignedStep(dpr);
  const tile = Math.max(step, Math.floor(tileDevicePx / dpr / step) * step);
  // Each tile is shot from a little above where the previous one ended and drawn over it, so a tile
  // that comes back a row short is still covered. A multiple of `step`, so it stays aligned too.
  const overlap = step * Math.ceil(8 / step);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  // Anything still uncovered shows as page background rather than transparent black.
  ctx.fillStyle = background || "#ffffff";
  ctx.fillRect(0, 0, width, height);
  for (let y = 0; y < vh; y += tile) {
    const top = Math.max(0, y - overlap);
    const bitmap = await createImageBitmap(await shoot({ x: 0, y: top, width: vw, height: Math.min(vh, y + tile) - top }));
    ctx.drawImage(bitmap, 0, Math.round(top * dpr));
    bitmap.close();
  }
  return { blob: await canvas.convertToBlob({ type: "image/png" }), width, height };
}

// Test hook: the Playwright suite drives captures through this, since it cannot click the toolbar.
globalThis.paneCapture = { captureTab, getCapture };
