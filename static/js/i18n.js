/**
 * Tiny i18n: load JSON dictionary, apply to elements with [data-i18n].
 * Persists choice in localStorage('netping.lang').
 */
const SUPPORTED = ["en", "it"];
const DEFAULT = "en";

let dict = {};
let currentLang = DEFAULT;

export async function loadLang(lang) {
  if (!SUPPORTED.includes(lang)) lang = DEFAULT;
  const res = await fetch(`/i18n/${lang}.json`, { cache: "no-cache" });
  dict = await res.json();
  currentLang = lang;
  document.documentElement.lang = lang;
  applyDict();
  localStorage.setItem("netping.lang", lang);
  return lang;
}

export function t(key, fallback) {
  return dict[key] ?? fallback ?? key;
}

export function getLang() {
  return currentLang;
}

function applyDict() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const value = dict[key];
    if (value !== undefined) el.textContent = value;
  });
}

export function initLangButtons(onChange) {
  for (const lang of SUPPORTED) {
    const btn = document.getElementById(`lang-${lang}`);
    if (!btn) continue;
    btn.addEventListener("click", async () => {
      await loadLang(lang);
      document.querySelectorAll("[id^=lang-]").forEach((b) =>
        b.setAttribute("aria-pressed", b.id === `lang-${lang}` ? "true" : "false")
      );
      if (onChange) onChange(lang);
    });
  }
}
