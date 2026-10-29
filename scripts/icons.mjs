// Renders extension/icons/icon.svg to the PNG sizes Chrome uses: 16 and 32 for the toolbar, 48 for
// the extensions page, 128 for installation and the Web Store. Run after editing the SVG:
//   npm run icons

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "extension", "icons");
const svg = await readFile(join(dir, "icon.svg"), "utf8");

const browser = await chromium.launch();
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`,
    );
    await page.screenshot({ path: join(dir, `icon-${size}.png`), omitBackground: true });
    await page.close();
    console.log(`icon-${size}.png`);
  }
} finally {
  await browser.close();
}
