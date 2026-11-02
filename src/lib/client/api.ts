'use client'

// Shared fetch helper for the operator console: cookie-authenticated, JSON
// envelope unwrapping, 401 → login redirect (except while already there or
// for public endpoints).

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function desk<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (res.status === 401 && !url.startsWith('/api/console/clock') && !url.startsWith('/api/console/login')) {
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login'
    }
    throw new ApiError(401, 'unauthorized', 'Operator session required')
  }
  let json: { data?: T; error?: { code: string; message: string } } = {}
  try {
    json = await res.json()
  } catch {
    throw new ApiError(res.status, 'bad_response', 'Malformed response from server')
  }
  if (!res.ok) {
    throw new ApiError(res.status, json.error?.code ?? 'error', json.error?.message ?? `HTTP ${res.status}`)
  }
  return json.data as T
}
