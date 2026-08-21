// Single source of truth for the backend origin — start.sh patches this line's
// URL on every run (cloudflare quick tunnels get a new random URL each time).
export const API = 'https://collecting-lending-illustration-secretariat.trycloudflare.com'

// Central fetch wrapper so every call carries the logged-in user's token
// without each component managing auth headers itself. A 401 means the
// session is gone (logged out / expired) — drop it and reload into the
// login screen rather than leaving the UI stuck on a failed request.
export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token')
  const res = await fetch(`${API}${path}`, {
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
