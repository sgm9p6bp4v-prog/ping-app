/**
 * Suggestion inbox: hosts whose IP matches another group's CIDR range and
 * which the operator hasn't dismissed yet. Each item has ACCEPT (moves host
 * to that group) and DISMISS (suppresses forever) buttons.
 *
 * Recomputed from /api/suggestions on demand + after CRUD events (host
 * created/updated/deleted, group_cidrs_changed).
 */
import { api } from "./api.js";
import { Store } from "./store.js";
import { t } from "./i18n.js";

const sectionEl = document.getElementById("suggestions");
let items = [];

export async function refresh() {
  try {
    items = await api.listSuggestions();
    render();
  } catch (e) {
    console.warn("suggestions refresh failed", e);
  }
}

function render() {
  if (!sectionEl) return;
  if (items.length === 0) {
    sectionEl.innerHTML = "";
    return;
  }
  const rows = items.map((s) => `
    <div class="suggestion" data-host-id="${s.host.id}" data-group="${escapeAttr(s.suggested_group)}">
      <div class="suggestion__text">
        <strong>${escapeHtml(s.host.name)}</strong>
        <span class="suggestion__addr">${escapeHtml(s.host.address)}</span>
        <span class="suggestion__arrow">→</span>
        <span class="suggestion__group">${escapeHtml(s.suggested_group)}</span>
        <span class="suggestion__current">(${t("suggestion.currently_in")} ${escapeHtml(s.host.group_name)})</span>
      </div>
      <div class="suggestion__actions">
        <button data-action="accept">${t("suggestion.accept")}</button>
        <button data-action="dismiss" class="muted">${t("suggestion.dismiss")}</button>
      </div>
    </div>
  `).join("");
  sectionEl.innerHTML = `
    <header class="suggestions__head">
      <h2>${t("suggestions.title")}</h2>
      <div class="suggestions__meta">${items.length}</div>
    </header>
    <div class="suggestions__list">${rows}</div>
  `;
  sectionEl.querySelectorAll(".suggestion").forEach((el) => {
    const hostId = Number(el.dataset.hostId);
    const groupName = el.dataset.group;
    el.querySelector('[data-action="accept"]').addEventListener("click", async () => {
      try {
        await api.acceptSuggestion(hostId, groupName);
        await refresh();
      } catch (e) {
        console.warn("accept failed", e);
      }
    });
    el.querySelector('[data-action="dismiss"]').addEventListener("click", async () => {
      try {
        await api.dismissSuggestion(hostId, groupName);
        await refresh();
      } catch (e) {
        console.warn("dismiss failed", e);
      }
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
