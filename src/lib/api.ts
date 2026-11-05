/** Las llamadas del panel al servidor (worker/index.ts, /api/panel…). */
import type { Config, PanelOp, StateView } from '../../shared/logic'

export type User = { id: string; username: string; name: string; avatar: string }
export type PanelData = {
  user: User
  admin: boolean
  /** De quién es la configuración (la propia o, para admin, la de otra persona). */
  owner: { id: string; name: string; avatar: string }
  other: boolean
  key: string
  config: Config
  state: StateView
  version: number
  now: number
  youtubeKey: boolean
}

/** Con ?persona=<id> admin abre los retos de otra persona. */
const persona = new URLSearchParams(location.search).get('persona')
const withPersona = (path: string) => (persona ? `${path}?persona=${encodeURIComponent(persona)}` : path)

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

async function call(path: string, init?: RequestInit): Promise<PanelData> {
  const res = await fetch(withPersona(path), { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const data = (await res.json().catch(() => ({}))) as PanelData & { error?: string }
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status)
  return data
}

export const fetchPanel = () => call('/api/panel')
export const saveConfig = (config: Partial<Config>) => call('/api/panel/config', { method: 'PUT', body: JSON.stringify({ config }) })
export const sendOps = (...ops: PanelOp[]) => call('/api/panel/ops', { method: 'POST', body: JSON.stringify({ ops }) })
export const newKey = () => call('/api/panel/key', { method: 'POST' })

export const overlayUrl = (key: string) => `${location.origin}/o/${key}`
export const HOME = 'https://herramientas.averroeshosting.com'
