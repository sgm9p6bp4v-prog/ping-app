/**
 * Per-group settings modal: enable/disable + collapse + CIDR list editor.
 *
 * CIDR ranges are validated server-side. Empty CIDR list = group exists only
 * for hosts that were assigned manually (no auto-suggestion source).
 */
import { api } from "./api.js";
import { Store } from "./store.js";
import { t } from "./i18n.js";

let backdrop = null;
let modal = null;
let currentName = null;
let previouslyFocused = null;

export async function open(name) {
  currentName = name;
  previouslyFocused = document.activeElement;
  ensureMounted();
  modal.querySelector("h2").textContent = `${t("group.settings_title")}: ${name}`;
  const g = Store.groupState(name);
  modal.querySelector("#gs-enabled").checked = !!g.enabled;
  modal.querySelector("#gs-collapsed").checked = !!g.collapsed;
  await refreshCidrs();
  backdrop.style.display = "block";
  modal.style.display = "grid";
  modal.querySelector("#gs-cidr-input").focus();
}

function close() {
  if (modal) modal.style.display = "none";
  if (backdrop) backdrop.style.display = "none";
  currentName = null;
  if (previouslyFocused?.focus) previouslyFocused.focus();
}

function ensureMounted() {
  if (modal) return;
  backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.addEventListener("click", close);
  document.body.appendChild(backdrop);

  modal = document.createElement("section");
  modal.className = "modal modal--wide";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "gs-title");
  modal.innerHTML = `
    <h2 id="gs-title">—</h2>
    <div class="modal__field"><label><input type="checkbox" id="gs-enabled"> <span data-i18n="group.enabled">Enabled</span></label></div>
    <div class="modal__field"><label><input type="checkbox" id="gs-collapsed"> <span data-i18n="group.collapsed">Collapsed by default</span></label></div>

    <div class="modal__field">
      <label data-i18n="group.cidrs">Auto-assignment CIDR ranges</label>
      <div class="cidr-editor">
        <ul id="gs-cidr-list" class="cidr-list"></ul>
        <form class="cidr-add" id="gs-cidr-form">
          <input id="gs-cidr-input" placeholder="e.g. 192.168.0.0/24" maxlength="64" />
          <button type="submit" data-i18n="group.cidr_add">Add</button>
        </form>
        <div class="modal__error" id="gs-cidr-error" style="display:none"></div>
      </div>
    </div>

    <div class="modal__actions">
      <button type="button" id="gs-close" data-i18n="editor.cancel">Close</button>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector("#gs-close").addEventListener("click", close);
  modal.querySelector("#gs-enabled").addEventListener("change", onEnabled);
  modal.querySelector("#gs-collapsed").addEventListener("change", onCollapsed);
  modal.querySelector("#gs-cidr-form").addEventListener("submit", onAddCidr);
  document.addEventListener("keydown", (ev) => {
    if (modal.style.display === "grid" && ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  });
}

async function refreshCidrs() {
  const list = modal.querySelector("#gs-cidr-list");
  try {
    const cidrs = await api.listGroupCidrs(currentName);
    if (cidrs.length === 0) {
      list.innerHTML = `<li class="cidr-empty">${t("group.cidr_empty")}</li>`;
      return;
    }
    list.innerHTML = cidrs.map((c) => `
      <li>
        <code>${escapeHtml(c)}</code>
        <button data-cidr="${escapeAttr(c)}" data-action="delete">${t("group.cidr_remove")}</button>
      </li>
    `).join("");
    list.querySelectorAll('[data-action="delete"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api.deleteGroupCidr(currentName, btn.dataset.cidr);
          await refreshCidrs();
        } catch (e) {
          showError(e.message);
        }
      });
    });
  } catch (e) {
    showError(e.message);
  }
}

async function onAddCidr(ev) {
  ev.preventDefault();
  const input = modal.querySelector("#gs-cidr-input");
  const cidr = input.value.trim();
  if (!cidr) return;
  try {
    await api.addGroupCidr(currentName, cidr);
    input.value = "";
    hideError();
    await refreshCidrs();
  } catch (e) {
    showError(e.message);
  }
}

async function onEnabled(ev) {
  try { await api.updateGroup(currentName, { enabled: ev.target.checked }); }
  catch (e) { showError(e.message); }
}

async function onCollapsed(ev) {
  try { await api.updateGroup(currentName, { collapsed: ev.target.checked }); }
  catch (e) { showError(e.message); }
}

function showError(msg) {
  const el = modal.querySelector("#gs-cidr-error");
  el.textContent = msg;
  el.style.display = "block";
}
function hideError() {
  const el = modal.querySelector("#gs-cidr-error");
  el.style.display = "none";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
