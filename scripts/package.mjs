// Builds the Chrome Web Store upload, dist/allpanes-<version>.zip, from extension/:
//   - icons/icon.svg is left out: it's only the source the PNG icons are drawn from.
//   - The test hook is removed from background.js: only the test suites use it.
// Then checks the ZIP: manifest.json at its top level, and every file the manifest, the pages and
// the scripts refer to present in it. A build that fails any check deletes its ZIP, so dist/ never
// holds one that shouldn't be uploaded.
//
//   npm run package        (builds, then runs test/package.mjs against the ZIP)

import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "extension");
const DIST = join(ROOT, "dist");
const LEAVE_OUT = new Set(["icons/icon.svg"]);

const manifest = JSON.parse(await readFile(join(SRC, "manifest.json"), "utf8"));
const zipPath = join(DIST, `allpanes-${manifest.version}.zip`);

async function build() {
  const stage = await mkdtemp(join(tmpdir(), "allpanes-build-"));
  try {
    await cp(SRC, stage, {
      recursive: true,
      filter: (src) => !LEAVE_OUT.has(relative(SRC, src).split("\\").join("/")),
    });

    // Strip the test hook. Refuse to build if the markers have gone missing, rather than ship it.
    const backgroundPath = join(stage, "src", "background.js");
    const background = await readFile(backgroundPath, "utf8");
    const stripped = background.replace(/\n\/\/ test-hook:start[\s\S]*?\/\/ test-hook:end\n/, "\n");
    if (stripped === background) throw new Error("background.js has no test-hook:start / test-hook:end markers");
    if (stripped.includes("globalThis.allPanes")) throw new Error("the test hook is still in background.js after stripping");
    await writeFile(backgroundPath, stripped);

    await mkdir(DIST, { recursive: true });
    await rm(zipPath, { force: true }); // zip adds to an existing archive instead of replacing it
    execFileSync("zip", ["-r", "-X", "-q", zipPath, "."], { cwd: stage });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function verify() {
  // What's in the ZIP, as Chrome will see it.
  const files = execFileSync("zip", ["-sf", zipPath], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("  "))
    .map((line) => line.trim())
    .filter((name) => !name.endsWith("/"));
  const inZip = new Set(files);
  if (!inZip.has("manifest.json")) throw new Error("manifest.json is not at the top level of the ZIP");

  // Every file referred to must be in the ZIP: from the manifest, then from each page and script.
  const wanted = new Map(); // path -> who refers to it
  const want = (path, from) => wanted.has(path) || wanted.set(path, from);
  want(manifest.background.service_worker, "manifest background");
  want(manifest.options_ui.page, "manifest options_ui");
  for (const path of Object.values(manifest.icons ?? {})) want(path, "manifest icons");
  for (const path of Object.values(manifest.action?.default_icon ?? {})) want(path, "manifest action icon");
  const unzipFile = (name) => execFileSync("unzip", ["-p", zipPath, name], { encoding: "utf8" });
  for (const name of files) {
    const text = /\.(html|js)$/.test(name) ? unzipFile(name) : "";
    const refs = name.endsWith(".html")
      ? [...text.matchAll(/(?:src|href)="([^"#:]+)"/g)]
      : [...text.matchAll(/from\s+"(\.[^"]+)"/g)];
    for (const [, ref] of refs) want(posix.normalize(posix.join(posix.dirname(name), ref)), name);
    // Pages opened with chrome.runtime.getURL("…") are relative to the extension root, not the script.
    for (const [, ref] of text.matchAll(/getURL\(\s*["'`]([^"'`?$]+)/g)) want(ref, name);
  }
  const missing = [...wanted].filter(([path]) => !inZip.has(path));
  if (missing.length) {
    throw new Error(`missing from the ZIP: ${missing.map(([p, from]) => `${p} (from ${from})`).join(", ")}`);
  }
  for (const left of LEAVE_OUT) if (inZip.has(left)) throw new Error(`${left} should have been left out`);
  return { files: files.sort(), referenced: wanted.size };
}

try {
  await build();
  const { files, referenced } = verify();
  const { size } = await stat(zipPath);
  console.log(`dist/allpanes-${manifest.version}.zip: ${files.length} files, ${(size / 1024).toFixed(0)} KB`);
  for (const name of files) console.log(`  ${name}`);
  console.log(`all ${referenced} referenced files present; test hook removed; ${[...LEAVE_OUT].join(", ")} left out`);
} catch (err) {
  await rm(zipPath, { force: true });
  console.error(`package failed: ${err.message}`);
  process.exitCode = 1;
}
