// Single source of truth for the backend origin (named cloudflare tunnel, stable).
export const API = 'https://backend.tradesmartai.in'

// Central fetch wrapper so every call carries the logged-in user's token
// without each component managing auth headers itself. A 401 means the
// session is gone (logged out / expired) — drop it and reload into the
// login screen rather than leaving the UI stuck on a failed request.
//
// When an admin is "acting as" another user (see Admin.jsx), every request
// carries that user's name too — the backend's get_effective_user() then
// routes trading calls to that user's account instead of the admin's own.
// This is the single place that injects it, so no component needs to know
// impersonation exists.
//
// options.asUser overrides it for one request (Alerts' Exit button acts on the
// alert's user without switching the whole app): a username, or '' for "myself".
export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token')
  const { asUser, ...fetchOptions } = options
  const actingAs = asUser !== undefined ? asUser : localStorage.getItem('actingAs')
  let url = `${API}${path}`
  if (actingAs) {
    url += `${path.includes('?') ? '&' : '?'}as_user=${encodeURIComponent(actingAs)}`
  }
  const res = await fetch(url, {
    ...fetchOptions,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...fetchOptions.headers,
    },
  })
  if (res.status === 401) {
    localStorage.removeItem('token')
    window.location.reload()
  }
  return res
}
