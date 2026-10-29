// User preferences, synced across the user's Chrome profiles. Read by the result page (which format
// the main Download button uses, and the JPEG quality) and edited on the options page.

export const DEFAULTS = {
  format: "png", // "png" | "jpeg"
  // About half the PNG's size on typical web-app screenshots, with faint halos around text up close.
  // 85% looks identical to PNG but saves just 17–32% there, since flat UI colour already suits PNG.
  jpegQuality: 0.7,
};

export async function loadSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

export function saveSettings(settings) {
  return chrome.storage.sync.set(settings);
}
