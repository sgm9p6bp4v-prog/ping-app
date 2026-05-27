/**
 * Add/Edit host modal.
 */
import { api } from "./api.js";
import { Store } from "./store.js";
import { t } from "./i18n.js";
import { getPingDefaults } from "./ping-settings.js";

let backdrop = null;
let modal = null;
let editing = null;
let previouslyFocused = null;

export function openAdd() { open(null); }
export function openEdit(hostId) { open(Store.hosts.get(hostId) ?? null); }

function open(host) {
  editing = host;
  previouslyFocused = document.activeElement;
  ensureMounted();
  modal.querySelector("h2").textContent = host ? t("editor.edit_title") : t("editor.add_title");
  modal.querySelector("#editor-name").value = host?.name ?? "";
  modal.querySelector("#editor-address").value = host?.address ?? "";
  modal.querySelector("#editor-group").value = host?.group_name ?? "default";
  modal.querySelector("#editor-interval").value = host?.interval_s ?? getPingDefaults().interval;
  modal.querySelector("#editor-enabled").checked = host?.enabled ?? true;
  modal.querySelector("#editor-delete").style.display = host ? "" : "none";
  modal.querySelector("#editor-error").textContent = "";
  backdrop.style.display = "block";
  modal.style.display = "grid";
  modal.querySelector("#editor-name").focus();
}

function close() {
  if (modal) modal.style.display = "none";
  if (backdrop) backdrop.style.display = "none";
  editing = null;
  if (previouslyFocused?.focus) previouslyFocused.focus();
  previouslyFocused = null;
}

function focusableInModal() {
  return [...modal.querySelectorAll(
    'input,button,select,textarea,[tabindex]:not([tabindex="-1"])'
  )].filter((el) => !el.disabled && el.offsetParent !== null);
}

function ensureMounted() {
  if (modal) return;
  backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.addEventListener("click", close);
  document.body.appendChild(backdrop);

  modal = document.createElement("form");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "editor-title");
  modal.innerHTML = `
    <h2 id="editor-title">—</h2>
    <div class="modal__field"><label data-i18n="editor.field.name">Name</label><input id="editor-name" required maxlength="120" /></div>
    <div class="modal__field"><label data-i18n="editor.field.address">IP or hostname</label><input id="editor-address" required maxlength="253" /></div>
    <div class="modal__field"><label data-i18n="editor.field.group">Group</label><input id="editor-group" value="default" maxlength="80" /></div>
    <div class="modal__field"><label data-i18n="editor.field.interval">Interval (s)</label><input id="editor-interval" type="number" min="0.2" max="60" step="0.1" value="1" /></div>
    <div class="modal__field"><label><input type="checkbox" id="editor-enabled" checked /> <span data-i18n="editor.field.enabled">Enabled</span></label></div>
    <div class="modal__error" id="editor-error" style="display:none"></div>
    <div class="modal__actions">
      <button type="button" id="editor-delete" class="danger" data-i18n="editor.delete">Delete</button>
      <button type="button" id="editor-cancel" data-i18n="editor.cancel">Cancel</button>
      <button type="submit" id="editor-save" data-i18n="editor.save">Save</button>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector("#editor-cancel").addEventListener("click", close);
  modal.addEventListener("submit", onSubmit);
  modal.querySelector("#editor-delete").addEventListener("click", onDelete);
  document.addEventListener("keydown", (ev) => {
    if (modal.style.display !== "grid") return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
      return;
    }
    if (ev.key === "Tab") {
      // Focus-trap: keep tabbing inside the modal.
      const items = focusableInModal();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  });
}

async function onSubmit(ev) {
  ev.preventDefault();
  const payload = {
    name: modal.querySelector("#editor-name").value.trim(),
    address: modal.querySelector("#editor-address").value.trim(),
    group_name: modal.querySelector("#editor-group").value.trim() || "default",
    interval_s: Number(modal.querySelector("#editor-interval").value),
    enabled: modal.querySelector("#editor-enabled").checked,
  };
  try {
    if (editing) {
      await api.updateHost(editing.id, payload);
    } else {
      await api.createHost(payload);
    }
    close();
  } catch (e) {
    const err = modal.querySelector("#editor-error");
    err.textContent = e.message;
    err.style.display = "block";
  }
}

async function onDelete() {
  if (!editing) return;
  if (!confirm(t("editor.delete_confirm"))) return;
  try {
    await api.deleteHost(editing.id);
    close();
  } catch (e) {
    const err = modal.querySelector("#editor-error");
    err.textContent = e.message;
    err.style.display = "block";
  }
}
