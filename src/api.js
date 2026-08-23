// Single source of truth for the backend origin — start.sh patches this line's
// URL on every run (cloudflare quick tunnels get a new random URL each time).
export const API = 'https://administered-mortgages-shades-amber.trycloudflare.com'

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
export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token')
  const actingAs = localStorage.getItem('actingAs')
  let url = `${API}${path}`
  if (actingAs) {
    url += `${path.includes('?') ? '&' : '?'}as_user=${encodeURIComponent(actingAs)}`
  }
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (res.status === 401) {
    localStorage.removeItem('token')
    window.location.reload()
  }
  return res
}
