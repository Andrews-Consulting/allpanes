// User preferences, kept in this browser only. Read by the result page (which format the main
// Download button uses, and the JPEG quality) and edited on the options page.
//
// chrome.storage.local, not .sync: synced settings travel through Google's servers when Chrome sync
// is on, and allPanes promises that nothing leaves the computer. Two settings aren't worth breaking
// that promise for.

export const DEFAULTS = {
  format: "png", // "png" | "jpeg"
  // About half the PNG's size on typical web-app screenshots, with faint halos around text up close.
  // 85% looks identical to PNG but saves just 17–32% there, since flat UI colour already suits PNG.
  jpegQuality: 0.7,
};

export async function loadSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

export function saveSettings(settings) {
  return chrome.storage.local.set(settings);
}

/** Calls `listener` whenever the settings change, from the options page or anywhere else. */
export function onSettingsChanged(listener) {
  chrome.storage.local.onChanged.addListener(listener);
}
