// Site check: captures pages of any site you point it at, and checks that each came out fully
// expanded, left the page as it found it, and (for pages tall enough to be tiled) matches a single
// untiled screenshot pixel for pixel. PNGs land in test/out/.
//
//   node test/site.mjs [config.json] [path ...]
//
// The config defaults to .config/allpanes/site.json. Everything under .config/ is git-ignored,
// so a site's routes and its login live there, never in the repo. test/site.example.json documents
// the fields. Paths on the command line replace the config's page list (keeping any per-page
// settings the config has for them). DPR=1.25 runs at that display scale.
//
// Only pages are viewed; nothing is submitted beyond the login form, if the config has one.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ROOT, launch, capture, savePng, diffCaptures, checker } from "./harness.mjs";

const args = process.argv.slice(2);
const configPath = resolve(args[0]?.endsWith(".json") ? args.shift() : join(ROOT, ".config", "allpanes", "site.json"));
if (!existsSync(configPath)) {
  console.error(`No site config at ${configPath}. Copy test/site.example.json there and edit it.`);
  process.exit(2);
}
const config = JSON.parse(await readFile(configPath, "utf8"));
const base = config.baseUrl.replace(/\/$/, "");
const timeout = config.timeoutMs ?? 40000;

// Page entries are a path, or { path, clickAll } where clickAll is a selector clicked until nothing
// matches it any more (e.g. every collapsed section header, so the whole page is open).
const entries = (config.pages ?? ["/"]).map((p) => (typeof p === "string" ? { path: p } : p));
const pages = args.length ? args.map((path) => entries.find((e) => e.path === path) ?? { path }) : entries;

// Strict JSON, or the relaxed `{email: x, password: y}` form with unquoted keys and/or values.
function parseCredentials(text, path) {
  try {
    return JSON.parse(text);
  } catch {}
  const creds = {};
  for (const m of text.matchAll(/["']?([\w-]+)["']?\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,}\r\n]+))/g)) {
    creds[m[1]] = (m[2] ?? m[3] ?? m[4]).trim();
  }
  if (!Object.keys(creds).length) throw new Error(`Could not read any key: value pairs from ${path}`);
  return creds;
}

async function logIn(page, login) {
  const credsPath = resolve(dirname(configPath), login.credentials);
  const creds = parseCredentials(await readFile(credsPath, "utf8"), credsPath);
  console.log(`Credentials loaded from ${credsPath}`);
  await page.goto(`${base}${login.path}`);
  for (const [selector, key] of Object.entries(login.fields)) {
    if (creds[key] === undefined) throw new Error(`${credsPath} has no "${key}" (needed for ${selector})`);
    await page.fill(selector, String(creds[key]));
  }
  await page.click(login.submit);
  const onLogin = (url) => url.pathname.startsWith(login.path);
  await page.waitForURL((url) => !onLogin(url), { timeout }).catch(() => {});
  if (onLogin(new URL(page.url()))) throw new Error(`Login did not leave ${login.path}; check the credentials.`);
}

async function clickAll(page, selector) {
  let clicked = 0;
  for (; clicked < 50; clicked++) {
    const found = await page.evaluate((s) => {
      const el = document.querySelector(s);
      el?.click();
      return !!el;
    }, selector);
    if (!found) break;
    await page.waitForTimeout(150);
  }
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  return clicked;
}

// Waits until the page's heights hold still for a second (up to 15 s), so a capture starts on a
// finished page. "Network idle" is not enough: some pages render more content seconds after it, from
// a worker or a timer, and a test that captured mid-change would be testing the retry, not the page.
// Returns how long it took.
async function waitForStableLayout(page) {
  const start = Date.now();
  const signature = () =>
    page.evaluate(() =>
      [document.scrollingElement, ...document.querySelectorAll("*")]
        .filter((el) => el === document.scrollingElement || /auto|scroll|overlay/.test(getComputedStyle(el).overflowY))
        .map((el) => el.scrollHeight)
        .join(","),
    );
  let last = await signature();
  let stableSince = Date.now();
  while (Date.now() - start < 15000) {
    await page.waitForTimeout(250);
    const now = await signature();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 1000) {
      break;
    }
  }
  return Date.now() - start;
}

// Every scroll area on the page, left part-way down as a user would leave them, so the restore
// check has real positions to compare. Kept on window so the same elements are read afterwards.
const SCROLL_ALL = `(() => {
  const els = [...document.querySelectorAll("*")].filter((el) =>
    el.scrollHeight - el.clientHeight > 1 &&
    (el === document.scrollingElement || /auto|scroll|overlay/.test(getComputedStyle(el).overflowY)));
  // "instant": on a page with scroll-behavior: smooth, a plain assignment is still animating when read.
  for (const el of els) el.scrollTo({ top: Math.min(200, Math.floor((el.scrollHeight - el.clientHeight) / 2)), behavior: "instant" });
  window.__siteTestScrollers = els;
  return els.length;
})()`;

const PAGE_STATE = `(() => ({
  vh: innerHeight,
  scrolls: (window.__siteTestScrollers || []).map((el) => el.scrollTop).join(","),
  marks: document.querySelectorAll("[data-allpanes],[data-allpanes-freed]").length,
  agent: typeof window.__allPanes,
}))()`;

async function loadPage(page, entry) {
  await page.goto(`${base}${entry.path}`);
  if (config.ready) await page.locator(config.ready).first().waitFor({ timeout });
  if (config.busy) await page.locator(config.busy).first().waitFor({ state: "detached", timeout }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(config.settleMs ?? 1500); // charts animate in
  const quiet = await waitForStableLayout(page);
  if (quiet > 1500) console.log(`  note: the page kept changing for ${(quiet / 1000).toFixed(1)} s after loading`);
  // After the page holds still, or the things to click may not have rendered yet.
  if (entry.clickAll) {
    console.log(`  clicked ${await clickAll(page, entry.clickAll)} × ${entry.clickAll}`);
    await waitForStableLayout(page);
  }
  const scrollers = await page.evaluate(SCROLL_ALL);
  const dialog = await page.evaluate(() => document.querySelector('[role="dialog"]')?.getAttribute("aria-label") ?? null);
  return { path: new URL(page.url()).pathname, scrollers, dialog };
}

const { check, failures } = checker();
const browser = await launch({ ...config.window, dpr: Number(process.env.DPR ?? 1) });
try {
  const { page } = browser;
  if (config.login) {
    await logIn(page, config.login);
    console.log(`Logged in; landed on ${new URL(page.url()).pathname}`);
  }

  for (const entry of pages) {
    console.log(`\n${entry.path}`);
    let info;
    try {
      info = await loadPage(page, entry);
    } catch (err) {
      check(false, "page loaded", err.message.split("\n")[0]);
      continue;
    }
    if (info.path !== entry.path) console.log(`  note: redirected to ${info.path}`);
    if (info.dialog) console.log(`  note: a dialog is open: ${JSON.stringify(info.dialog)}`);

    const before = await page.evaluate(PAGE_STATE);
    const shot = await capture(browser);
    const slug = `${new URL(base).hostname}${info.path}`.replace(/\W+/g, "-").replace(/-$/, "");
    const png = await savePng(browser.sw, shot.id, `site-${slug}`);
    console.log(`  ${shot.width}×${shot.height} px (${shot.panes} scroll areas found) → ${png}`);
    for (const n of shot.notes) console.log(`  note: ${n}`);
    if (shot.retried) console.log(`  note: needed the retry pass ${JSON.stringify(shot.trace.filter((t) => t.retry))}`);

    check(shot.residual === 0, "every scroll area fully expanded", `${shot.residual} left overflowing`);
    if (shot.residual) for (const step of shot.trace) console.log(`    ${JSON.stringify(step)}`);
    // Chrome's "started debugging" bar goes a moment after detach; the viewport is short until then.
    await page.waitForFunction((h) => innerHeight === h, before.vh, { timeout: 5000 }).catch(() => {});
    const after = await page.evaluate(PAGE_STATE);
    const restored = JSON.stringify(after) === JSON.stringify(before);
    check(
      restored,
      `page restored (viewport, ${info.scrollers} scroll positions, no leftovers)`,
      restored ? "" : JSON.stringify({ before, after }),
    );

    // A tall page went through the tiled path: it must match one untiled screenshot pixel for pixel.
    // (Headless renders in software, so the single shot has no GPU texture limit to hit.)
    if (shot.height > 8000) {
      const single = await capture(browser, { tileDevicePx: 1e9 });
      const diff = await diffCaptures(browser.sw, shot.id, single.id);
      check(!diff.sizeMismatch && diff.differing === 0, "tiled capture matches a single screenshot", JSON.stringify(diff));
    }
  }
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : "\nAll checks passed");
process.exit(failures.length ? 1 : 0);
