# allPanes

A Chrome extension that captures the whole page as one image, including every pane that scrolls on
its own (sidebar, main column, side rails, fixed-height tables), not just the window's scroll.

Most full-page capture tools scroll the window and stitch the strips together. That works for a
document, but in a web app whose sidebar, main column and side panels each scroll separately,
scrolling the window moves nothing, so the panes come out cut off at the screen's edge.

## How it works

Instead of scrolling and stitching, which also repeats sticky headers and rails in every strip, it
tells the page, through Chrome's debugger protocol, that the window is as tall as the tallest pane
needs:

1. It finds every scroll area that is on screen and overflowing.
2. It briefly makes the window 200 px taller to learn which panes grow with the window (full-height
   flex layouts, `calc(100vh - …)` side panels) and which have a fixed height (`max-height` tables).
3. It lifts the height limit on the fixed-height panes and sizes the window exactly to fit
   everything, with no blank band at the bottom.
4. If anything still overflows, usually because the page was still loading, it waits 1.5 seconds
   and runs steps 1–3 once more.
5. It takes one screenshot, in tiles if it is very tall, then puts every style and scroll position
   back.

## Install

allPanes isn't on the Chrome Web Store; install it from this repository:

1. Clone or download the repository.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the repository's `extension` folder.
4. Pin allPanes so its toolbar button stays visible.

To update, pull the latest changes and click the reload icon on allPanes in
`chrome://extensions`.

If the repository lives in WSL and you use Chrome on Windows, load the folder through its
`\\wsl.localhost\<distro>\…` path. If Chrome won't accept that, copy the `extension` folder to a
Windows drive and load it from there.

## Use

Click the toolbar button, or press **Alt+Shift+S**. While it captures, the page briefly resizes and
Chrome shows a "allPanes started debugging this browser" bar; both go away when it finishes.

The capture opens in a new tab with:

- **Copy image**, which copies a PNG (the only image format the clipboard accepts).
- **Download PNG** and **Download JPEG**, each showing its file size. The main (blue) button is
  the format chosen in **Options**.
- **Actual size** / **Fit to window**, to toggle the preview's zoom.

Open **Options** from the result page, or by right-clicking the toolbar button. It sets the main
download format and the JPEG quality. PNG is lossless; JPEG at the default 70% is about half the
size of the PNG on typical app screenshots, with faint halos around text up close.

## Privacy and permissions

Nothing leaves your computer. allPanes makes no network requests and has no analytics. Each
capture is kept in the extension's own local storage so its result tab can reload; only the 10 most
recent are kept, and they are never uploaded.

It asks for two permissions:

- **`debugger`**, to resize the page's viewport and take the screenshot. This is how it captures
  panes that other tools can't. Chrome's install prompt describes it broadly ("read and change all
  your data on all websites"); allPanes uses it only on the tab you capture, only while
  capturing, and detaches as soon as it's done. Chrome shows the "started debugging" bar for every
  extension that uses this permission, and an extension can't turn it off.
- **`storage`**, for the two Options settings. They're kept in this browser only, never synced.

The full privacy policy is in [PRIVACY.md](PRIVACY.md).

## Limits

- Chrome doesn't let extensions capture its own pages (`chrome://…`), the Chrome Web Store, other
  extensions' pages or the built-in PDF viewer. The result page says so.
- Horizontal scroll areas (wide tables in a sideways-scrolling wrapper) are captured as shown, not
  expanded.
- Content inside iframes isn't expanded.
- Images are capped at 32,000 device pixels tall (the browser's canvas limit). The result page says
  so when it cuts something off.

## Development

```sh
npm install
npx playwright install chromium   # the full build; Playwright's headless shell can't load extensions
npm test                          # fixture suite
npm run test:site                 # your own site, from a config file (below)
npm run icons                     # re-render the PNG icons after editing extension/icons/icon.svg
npm run screenshots               # rebuild the Chrome Web Store screenshots in store/screenshots/
npm run package                   # build dist/allpanes-<version>.zip for the store, then test it
```

The store screenshots are made from `store/demo.html`, an unbranded project-tracker page whose
sidebar, task list and details panel each scroll on their own. The script captures it with the
real extension and lays out three 1280×800 images, so rerun it whenever the extension's UI changes.

Both test suites run headless and load the real extension. Output images go to `test/out/`.

**Fixture suite** (`npm test`) captures `test/fixture.html`, a typical web-app shell: a sidebar and
main column that each scroll, a sticky header, a window-sized side rail, a fixed-height table, a
floating button and a hidden drawer. It checks at 100%, 110% and 150% display scale that every pane
comes out fully expanded, the image is exactly as tall as the tallest pane, the page is restored
exactly, and tiled captures match a single screenshot pixel for pixel. It also covers content
arriving mid-capture, both download formats, the Options page, and restricted pages.

**Site test** (`npm run test:site`) runs the same checks against pages of a real site, optionally
behind a login. Copy `test/site.example.json` to `.config/allpanes/site.json` and edit it:

- **`baseUrl`**: the site's address.
- **`window`**: the browser window size to capture at.
- **`login`** (optional): the login page's `path`; the `credentials` file, relative to the config,
  as JSON such as `{"email": "…", "password": "…"}`; the `fields` to fill, mapping a selector to a
  credentials key; and the `submit` button's selector.
- **`ready`**: a selector to wait for on each page.
- **`busy`**: a loading indicator to wait to disappear.
- **`pages`**: the paths to capture. An entry can be `{ "path": …, "clickAll": selector }` to click
  every match first, for example to open every collapsed section.

Everything under `.config/` is git-ignored, so a site's routes and its login stay out of the
repository. To capture only some pages, name them: `node test/site.mjs /reports /settings`. To run
at a display scale, set `DPR`: `DPR=1.25 npm run test:site`.

## Publishing

`npm run package` builds the Chrome Web Store upload, `dist/allpanes-<version>.zip`, with the
version taken from `extension/manifest.json`. It contains only the `extension/` folder's files, minus
`icons/icon.svg` (the source the PNG icons are drawn from) and the test hook in `background.js`. The
build fails, and deletes its ZIP, if any file the extension refers to is missing.

It then tests that ZIP as a user would use it, through the toolbar button rather than the test hook:
a full capture, the page restored, both downloads, the Options page, and a restricted page. It also
checks the ZIP's files are identical to `extension/` apart from the removed hook, so the fixture
suite's results apply to it too.

Each upload to the store needs a higher `version` in `manifest.json` than the last. The screenshots
(`store/screenshots/`), the store icon (`extension/icons/icon-128.png`) and the listing text are
entered in the Chrome Web Store developer dashboard, not included in the ZIP.

## License

allPanes is free software, licensed under the
[GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html). See
[LICENSE](LICENSE) for the full text. You may use, change and share it; if you distribute a
modified version, it must be released under the same license, with its source.
