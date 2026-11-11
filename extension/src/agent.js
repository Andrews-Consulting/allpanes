// Runs INSIDE the captured page. The service worker sends `agent.toString()` over the debugger
// protocol, so this function must be self-contained: no imports, no references to outer scope.
//
// It installs `window.__allPanes`, which the service worker drives step by step:
//   measure()   – find every pane that scrolls on its own and report how much each overflows
//   free(id)    – lift a pane's height limit so it shows all its content (for fixed-height panes
//                 that do not grow with the window)
//   unbind(id)  – lift window-sized heights (min-height: 100vh, height: 100%) off a pane's
//                 descendants, or the whole page's for null, so its content stops growing with the
//                 window; see "bound" in background.js
//   settle(ms)  – wait for layout, resize observers, images and fonts to catch up
//   restore()   – put every style and scroll position back exactly as it was
export function agent() {
  if (window.__allPanes) return;

  const ID = "data-allpanes";
  const FREED = "data-allpanes-freed";
  const SCROLLS = /auto|scroll|overlay/;

  // Every non-zero scroll position, recorded before anything moves. Growing the viewport clamps
  // scrollTop to 0 on each pane that stops overflowing, so these can only be captured up front.
  const scrolls = [];
  for (const el of document.querySelectorAll("*")) {
    if (el.scrollTop || el.scrollLeft) scrolls.push([el, el.scrollTop, el.scrollLeft]);
  }
  const windowScroll = [scrollX, scrollY];

  const styles = []; // [element, original style attribute] for everything free() or unbind() touched
  const unbound = new Set(); // elements unbind() has already handled
  let pending = []; // ancestor chains to re-check after free(), see measure()
  let nextId = 1;
  let changed = false;

  const onScreen = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  };

  // Overflowing scroll containers that are actually on screen. Off-canvas drawers and closed panels
  // (translated out, display:none) are skipped, or a hidden chat history would size the image.
  function scan() {
    for (const el of document.body.querySelectorAll("*")) {
      if (el.hasAttribute(ID) || el.scrollHeight - el.clientHeight <= 1) continue;
      const cs = getComputedStyle(el);
      if (!SCROLLS.test(cs.overflowY) || cs.visibility === "hidden" || !onScreen(el)) continue;
      el.setAttribute(ID, String(nextId++));
    }
  }

  function free(el) {
    if (el.hasAttribute(FREED)) return;

    // Wrappers between this element and the nearest scroll container may have a fixed height of
    // their own; once this element grows they would clip it. Remember how much each one overflows
    // now, and measure() frees any whose overflow grew as a result.
    const chain = [];
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (SCROLLS.test(getComputedStyle(a).overflowY) && !a.hasAttribute(FREED)) break;
      chain.push(a);
    }
    pending.push({ chain, before: chain.map((a) => a.scrollHeight - a.clientHeight) });

    styles.push([el, el.getAttribute("style")]);
    el.setAttribute(FREED, "");
    const s = el.style;
    s.setProperty("height", "auto", "important");
    s.setProperty("max-height", "none", "important");
    const parent = el.parentElement && getComputedStyle(el.parentElement);
    if (parent?.display.includes("flex")) {
      if (parent.flexDirection.startsWith("column")) {
        s.setProperty("flex-basis", "auto", "important");
        s.setProperty("flex-shrink", "0", "important");
      } else {
        s.setProperty("align-self", "flex-start", "important");
      }
    } else if (parent?.display.includes("grid")) {
      s.setProperty("align-self", "start", "important");
    }
    changed = true;
  }

  // A pane whose content is sized to the window (a min-h-screen page wrapper inside a column that
  // sits below a header) overflows by the same amount however tall the window gets. Take the
  // window-sized heights off its descendants so the content takes its natural height and the pane
  // can be sized to it. `root` null does the same for the whole page, when the document itself is
  // the one overflowing by a constant.
  function unbind(root) {
    const vh = innerHeight;
    let count = 0;
    for (const el of (root ?? document.body).querySelectorAll("*")) {
      if (unbound.has(el) || el.hasAttribute(FREED)) continue;
      const cs = getComputedStyle(el);
      // Overlays and drawers are sized to the window on purpose and do not push anything.
      if (cs.position === "fixed" || cs.position === "absolute") continue;
      const minHeight = Math.abs(parseFloat(cs.minHeight) - vh) <= 2; // min-height: 100vh / 100dvh
      const height = Math.abs(parseFloat(cs.height) - vh) <= 2; // height: 100vh, or 100% of one
      if (!minHeight && !height) continue;
      unbound.add(el);
      styles.push([el, el.getAttribute("style")]);
      // "auto", not 0: as a flex item the element would otherwise shrink below its content.
      if (minHeight) el.style.setProperty("min-height", "auto", "important");
      if (height) el.style.setProperty("height", "auto", "important");
      count++;
    }
    if (count) changed = true;
    return count;
  }

  function measure() {
    changed = false;
    const checks = pending;
    pending = [];
    for (const { chain, before } of checks) {
      chain.forEach((a, i) => {
        if (a.scrollHeight - a.clientHeight > before[i] + 1) free(a);
      });
    }
    scan();
    const panes = [...document.querySelectorAll(`[${ID}]`)].map((el) => ({
      id: el.getAttribute(ID),
      client: el.clientHeight,
      overflow: el.scrollHeight - el.clientHeight,
      freed: el.hasAttribute(FREED),
    }));
    const doc = document.scrollingElement ?? document.documentElement;
    // The page's own backdrop, which the stitched canvas is painted with before the tiles go on.
    let background = "#ffffff";
    for (const el of [document.body, document.documentElement]) {
      const c = getComputedStyle(el).backgroundColor;
      if (c && c !== "transparent" && c !== "rgba(0, 0, 0, 0)") {
        background = c;
        break;
      }
    }
    return {
      vw: innerWidth,
      vh: innerHeight,
      // The browser window's width. Wider than the viewport when DevTools or Chrome's side panel is
      // docked beside the page; see "docked" in background.js.
      windowWidth: outerWidth,
      dpr: devicePixelRatio,
      docOverflow: doc.scrollHeight - innerHeight,
      panes,
      changed,
      background,
      url: location.href,
      title: document.title,
    };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Two animation frames lets layout and ResizeObserver callbacks run; the timeout covers a tab
  // whose frames are throttled so this can never hang the capture.
  const frames = () =>
    Promise.race([new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))), sleep(300)]);

  async function settle(ms = 0) {
    await frames();
    if (ms <= 0) return;
    await sleep(ms);
    // Lazy images that only entered the (now taller) viewport during the expansion.
    const loading = [...document.images].filter((img) => !img.complete && onScreen(img));
    const loaded = loading.map(
      (img) =>
        new Promise((resolve) => {
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
        }),
    );
    await Promise.race([Promise.all(loaded), sleep(3000)]);
    if (document.fonts) await Promise.race([document.fonts.ready, sleep(1000)]);
    await frames();
  }

  function restore() {
    for (const [el, style] of styles.reverse()) {
      el.style.cssText = style ?? "";
      if (style === null) {
        // Blink reflects CSSOM edits into the `style` attribute lazily. Removing the attribute while
        // that reflection is pending leaves the element reading back `style=""` afterwards instead
        // of having none, so read it first to flush the reflection, then remove it.
        el.getAttribute("style");
        el.removeAttribute("style");
      }
      el.removeAttribute(FREED);
    }
    for (const el of document.querySelectorAll(`[${ID}]`)) el.removeAttribute(ID);
    // "instant": on a page with `scroll-behavior: smooth`, a plain assignment animates, so every
    // pane would glide back into place after the capture has already reported itself done.
    for (const [el, top, left] of scrolls) el.scrollTo({ top, left, behavior: "instant" });
    scrollTo({ left: windowScroll[0], top: windowScroll[1], behavior: "instant" });
    delete window.__allPanes;
  }

  window.__allPanes = {
    measure,
    settle,
    restore,
    free: (id) => {
      const el = document.querySelector(`[${ID}="${id}"]`);
      if (el) free(el);
    },
    unbind: (id) => {
      if (id === null) return unbind(null);
      const el = document.querySelector(`[${ID}="${id}"]`);
      return el ? unbind(el) : 0;
    },
  };
}
