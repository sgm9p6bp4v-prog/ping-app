/** Thin fetch wrapper. */
async function json(method, url, body) {
  const opts = { method, headers: {} };
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
};
