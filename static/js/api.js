/** Thin fetch wrapper. Always sends X-Requested-With for the CSRF guard
 * (server-side CSRFGuardMiddleware rejects mutating /api/* requests without
 * it; a cross-origin <form> POST can't set custom headers). */
async function json(method, url, body) {
  const opts = { method, headers: { "X-Requested-With": "fetch" } };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch (_) {}
    const err = new Error(`${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  info:        () => json("GET", "/api/info"),
  listHosts:   () => json("GET", "/api/hosts"),
  createHost:  (data) => json("POST", "/api/hosts", data),
  updateHost:  (id, data) => json("PATCH", `/api/hosts/${id}`, data),
  deleteHost:  (id) => json("DELETE", `/api/hosts/${id}`),
  history:     (id, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return json("GET", `/api/hosts/${id}/history${q ? "?" + q : ""}`);
  },
  events:      (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return json("GET", `/api/events${q ? "?" + q : ""}`);
  },
  listGroups:       () => json("GET", "/api/groups"),
  updateGroup:      (name, data) => json("PATCH", `/api/groups/${encodeURIComponent(name)}`, data),
  deleteGroup:      (name) => json("DELETE", `/api/groups/${encodeURIComponent(name)}`),
  listGroupCidrs:   (name) => json("GET", `/api/groups/${encodeURIComponent(name)}/cidrs`),
  addGroupCidr:     (name, cidr) => json("POST", `/api/groups/${encodeURIComponent(name)}/cidrs`, { cidr }),
  deleteGroupCidr:  (name, cidr) =>
    json("DELETE", `/api/groups/${encodeURIComponent(name)}/cidrs?cidr=${encodeURIComponent(cidr)}`),
  listSuggestions:  () => json("GET", "/api/suggestions"),
  acceptSuggestion: (host_id, group_name) =>
    json("POST", "/api/suggestions/accept", { host_id, group_name }),
  dismissSuggestion: (host_id, group_name) =>
    json("POST", "/api/suggestions/dismiss", { host_id, group_name }),
  monitoring:       () => json("GET", "/api/monitoring"),
  monitoringStart:  () => json("POST", "/api/monitoring/start"),
  monitoringStop:   () => json("POST", "/api/monitoring/stop"),
};
