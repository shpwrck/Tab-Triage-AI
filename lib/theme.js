// Apply the user's display.theme preference ("system" | "light" | "dark")
// to the current page by toggling body.light / body.dark. The CSS pairs
// `body.dark` with `@media (prefers-color-scheme: dark) body:not(.light)`
// so "system" needs no class — the media query handles it without flash.

import { getSettings } from "./storage.js";

const SETTINGS_KEY = "tt_settings";

export async function applyStoredTheme() {
  const settings = await getSettings();
  applyTheme(settings.display?.theme ?? "system");
}

export function applyTheme(theme) {
  const body = document.body;
  body.classList.remove("light", "dark");
  if (theme === "light" || theme === "dark") body.classList.add(theme);
}

export function watchThemeChanges() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    const theme = changes[SETTINGS_KEY].newValue?.display?.theme ?? "system";
    applyTheme(theme);
  });
}
