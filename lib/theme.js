// Apply the user's display.theme preference ("system" | "light" | "dark")
// to the current page by toggling body.light / body.dark. The CSS pairs
// `body.dark` with `@media (prefers-color-scheme: dark) body:not(.light)`
// so "system" needs no class — the media query handles it without flash.

import { getSettings } from "./storage.js";

const SETTINGS_KEY = "tt_settings";

// Dark and system themes are a Lifetime perk; free users are forced to
// light regardless of their stored preference (so a lapsed lifetime
// reverts cleanly without losing the saved choice).
function effectiveTheme(settings) {
  const stored = settings.display?.theme ?? "system";
  if (settings.plan !== "lifetime") return "light";
  return stored;
}

export async function applyStoredTheme() {
  const settings = await getSettings();
  applyTheme(effectiveTheme(settings));
}

export function applyTheme(theme) {
  const body = document.body;
  body.classList.remove("light", "dark");
  if (theme === "light" || theme === "dark") body.classList.add(theme);
}

export function watchThemeChanges() {
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    const settings = await getSettings();
    applyTheme(effectiveTheme(settings));
  });
}
