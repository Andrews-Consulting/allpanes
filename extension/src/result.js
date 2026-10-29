import { getCapture } from "./store.js";
import { loadSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const FORMATS = {
  png: { label: "PNG", ext: "png" },
  jpeg: { label: "JPEG", ext: "jpg" },
};

const formatBytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

// The capture is stored as PNG, the lossless original. JPEG is encoded from it on demand and kept
// per quality, so switching formats or going back to an earlier quality costs nothing the second time.
const jpegs = new Map();
function jpegOf(png, quality) {
  if (!jpegs.has(quality)) jpegs.set(quality, encodeJpeg(png, quality));
  return jpegs.get(quality);
}

async function encodeJpeg(png, quality) {
  const bitmap = await createImageBitmap(png);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // JPEG has no transparency
  ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/jpeg", quality });
}

function showNote(text, isError = false) {
  const notes = $("notes");
  notes.textContent = text;
  notes.classList.toggle("error", isError);
  notes.hidden = false;
}

function fileName(record, ext) {
  let host = "page";
  try {
    host = new URL(record.url).host.replace(/[^\w.-]+/g, "_");
  } catch {}
  const t = new Date(record.takenAt);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
  return `capture-${host}-${stamp}.${ext}`;
}

async function main() {
  if (params.has("error")) {
    $("title").textContent = "Capture failed";
    showNote(params.get("error"), true);
    return;
  }

  const record = await getCapture(params.get("id") ?? "");
  if (!record) {
    $("title").textContent = "Capture not found";
    showNote("This capture is no longer stored. Only the 10 most recent are kept.");
    return;
  }

  const url = URL.createObjectURL(record.blob);
  const img = $("shot");
  img.src = url;
  img.hidden = false;
  await img.decode().catch(() => {});

  document.title = `Capture – ${record.title || record.url}`;
  $("title").textContent = record.title || record.url;
  $("dims").textContent = `${record.width} × ${record.height} px · ${record.url}`;
  if (record.notes?.length) showNote(record.notes.join(" "));
  $("actions").hidden = false;

  const stage = $("stage");
  $("size").addEventListener("click", () => {
    const fit = stage.classList.toggle("fit");
    // "Actual size" shows the page at the size it had on screen, one CSS pixel per CSS pixel.
    img.style.width = fit ? "" : `${record.cssWidth}px`;
    $("size").textContent = fit ? "Actual size" : "Fit to window";
  });

  $("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

  // Main button = the format chosen in Options; the other button = the other format. Each label
  // gains the file size once it is known (immediately for PNG, after encoding for JPEG).
  let settings = await loadSettings();
  const blobFor = (format) => (format === "jpeg" ? jpegOf(record.blob, settings.jpegQuality) : Promise.resolve(record.blob));
  const primary = $("download");
  const secondary = $("download-alt");
  let renders = 0;
  const renderDownloads = () => {
    const render = ++renders;
    const main = settings.format === "jpeg" ? "jpeg" : "png";
    const other = main === "png" ? "jpeg" : "png";
    for (const [button, format] of [[primary, main], [secondary, other]]) {
      button.dataset.format = format;
      button.textContent = `Download ${FORMATS[format].label}`;
      blobFor(format).then((blob) => {
        // A later render (settings changed meanwhile) owns the label now.
        if (render === renders) button.textContent = `Download ${FORMATS[format].label} · ${formatBytes(blob.size)}`;
      });
    }
  };
  renderDownloads();
  chrome.storage.onChanged.addListener(async (_changes, area) => {
    if (area !== "sync") return;
    settings = await loadSettings();
    renderDownloads();
  });

  for (const button of [primary, secondary]) {
    button.addEventListener("click", async () => {
      const format = button.dataset.format;
      const fileUrl = URL.createObjectURL(await blobFor(format));
      const a = document.createElement("a");
      a.href = fileUrl;
      a.download = fileName(record, FORMATS[format].ext);
      a.click();
      setTimeout(() => URL.revokeObjectURL(fileUrl), 60_000);
    });
  }

  const copy = $("copy");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": record.blob })]);
      copy.textContent = "Copied";
    } catch (err) {
      copy.textContent = "Copy failed";
      showNote(`Could not copy to the clipboard: ${err.message}`);
    }
    setTimeout(() => (copy.textContent = "Copy image"), 1500);
  });

  // Exposed for the test suite.
  window.__capture = { width: record.width, height: record.height, residual: record.residual };
}

main().catch((err) => {
  $("title").textContent = "Could not show the capture";
  showNote(String(err?.stack ?? err), true);
});
