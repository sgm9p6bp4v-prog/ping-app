/**
 * Shared small helpers. Single source for HTML escaping so every module
 * applies the same discipline before innerHTML insertion.
 */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function escapeAttr(s) { return escapeHtml(s); }

export function clamp(min, value, max) {
  return Math.min(max, Math.max(min, value));
}
