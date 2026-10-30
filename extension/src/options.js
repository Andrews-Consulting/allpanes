import { loadSettings, saveSettings } from "./settings.js";

const form = document.getElementById("form");
const quality = document.getElementById("quality");
const qualityValue = document.getElementById("quality-value");
const status = document.getElementById("status");

const showQuality = () => {
  const percent = `${Math.round(Number(quality.value) * 100)}%`;
  qualityValue.textContent = percent;
  // Otherwise screen readers read the raw value, "0.7".
  quality.setAttribute("aria-valuetext", percent);
};

let clearStatus;
// Saved on `change`, not `input`: dragging the slider fires dozens of inputs, and each save would
// re-encode the JPEG on any open result page.
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
