import { loadSettings, saveSettings } from "./settings.js";

const form = document.getElementById("form");
const quality = document.getElementById("quality");
const qualityValue = document.getElementById("quality-value");
const status = document.getElementById("status");

const showQuality = () => (qualityValue.textContent = `${Math.round(Number(quality.value) * 100)}%`);

let clearStatus;
// Saved on `change`, not `input`: dragging the slider fires dozens of inputs, and chrome.storage.sync
// allows only so many writes a minute.
form.addEventListener("change", async () => {
  await saveSettings({ format: form.elements.format.value, jpegQuality: Number(quality.value) });
  status.textContent = "Saved";
  clearTimeout(clearStatus);
  clearStatus = setTimeout(() => (status.textContent = ""), 1500);
});
quality.addEventListener("input", showQuality);

const settings = await loadSettings();
form.elements.format.value = settings.format;
quality.value = String(settings.jpegQuality);
showQuality();
