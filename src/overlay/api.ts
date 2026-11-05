/** Las llamadas del overlay de OBS al servidor (worker/index.ts, /api/overlay…). */
import type { BallotIn, CommandIn, FeedEvent, OverlayConfig, StateView } from '../../shared/logic'

export type Snapshot = { config: OverlayConfig; state: StateView; version: number; now: number }

async function call<T>(url: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  if (res.status === 204) return null
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status })
  return data
}

const q = (key: string, extra = '') => `?key=${encodeURIComponent(key)}${extra}`

/** El estado, o null si no ha cambiado desde `version`. */
export const overlayState = (key: string, version: number) => call<Snapshot>(`/api/overlay${q(key, `&v=${version}`)}`)

export const sendEvents = (key: string, body: { events: FeedEvent[]; ballots: BallotIn[]; commands: CommandIn[]; readers: unknown }) =>
  call<Snapshot>(`/api/overlay/events${q(key)}`, { method: 'POST', body: JSON.stringify(body) })

export const overlayApi = <T>(key: string, path: string, init?: RequestInit) => {
  const [route, extra] = path.split('?')
  return call<T>(`/api/overlay${route}${q(key, extra ? `&${extra}` : '')}`, init)
}
