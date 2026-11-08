/**
 * retos.averroeshosting.com: la batalla de pociones.
 *
 *   /                          el panel (pide la sesión de herramientas, con acceso a «retos»)
 *   /o/<clave>                 el overlay de OBS (sin login: la clave larga hace de contraseña)
 *   /api/panel…                lo que usa el panel
 *   /api/overlay…?key=<clave>  lo que usa el overlay: el estado, las subs, votos y comandos
 *                              que lee del chat, y el chat de YouTube sin clave de reserva
 *
 * El estado de cada persona se guarda en la base de datos D1 de herramientas, en la tabla
 * retos (una fila por cuenta de Discord). La lógica está en shared/logic.ts.
 */
import { discordAvatar, readAccess, type Access } from './access.ts'
import { gate } from './gate.ts'
import { cachedLiveVideo, pollChat, startChat, type ChatSession } from './youtube.ts'
import {
  advance, applyBallots, applyCommand, applyEvent, applyPanelOp, applyReaders, defaultConfig, initialState,
  overlayConfig, parseConfig, parseState, sanitizeConfig, viewOf,
  applyRedemption, AVATAR_URL, type BallotIn, type CommandIn, type Config, type FeedEvent, type PanelOp, type RedemptionIn, type State,
} from '../shared/logic.ts'

interface Env {
  ASSETS: Fetcher
  DB: D1Database
  /** La clave de la API de YouTube (la misma del teatro y el bingo). Sin ella, YouTube se lee por el método de reserva. */
  YOUTUBE_API_KEY?: string
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const random = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32

/* ---------------------------------------------------------------- base de datos */

let schema: Promise<unknown> | null = null
function ensureSchema(db: D1Database) {
  schema ??= db.prepare(`CREATE TABLE IF NOT EXISTS retos (
      user_id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, config TEXT NOT NULL, state TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`)
    .run()
    .catch((error: unknown) => { schema = null; throw error })
  return schema
}

type Row = { user_id: string; key: string; config: string; state: string; version: number }
type Loaded = { userId: string; key: string; config: Config; state: State; version: number }

const load = (row: Row): Loaded => ({ userId: row.user_id, key: row.key, config: parseConfig(row.config), state: parseState(row.state), version: row.version })

async function rowFor(db: D1Database, where: { userId: string } | { key: string }) {
  return 'userId' in where
    ? db.prepare('SELECT * FROM retos WHERE user_id = ?').bind(where.userId).first<Row>()
    : db.prepare('SELECT * FROM retos WHERE key = ?').bind(where.key).first<Row>()
}

/** La fila de la persona; la primera vez se crea con la configuración por defecto. */
async function ensureRow(db: D1Database, userId: string) {
  const now = Date.now()
  await db.prepare('INSERT OR IGNORE INTO retos (user_id, key, config, state, version, updated_at) VALUES (?, ?, ?, ?, 0, ?)')
    .bind(userId, crypto.randomUUID(), JSON.stringify(defaultConfig()), JSON.stringify(initialState(now)), now).run()
}

/**
 * Lee, cambia y guarda con control de versión: si el overlay o el panel ha guardado entretanto,
 * se vuelve a intentar con lo nuevo. Siempre avanza lo que toca por tiempo (cerrar la votación,
 * empezar el siguiente reto…). `change` devuelve si ha cambiado algo.
 */
async function mutate(db: D1Database, where: { userId: string } | { key: string }, change: (l: Loaded, now: number) => boolean = () => false) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await rowFor(db, where)
    if (!row) return null
    const loaded = load(row)
    const now = Date.now()
    const timed = advance(loaded.state, loaded.config, now, random)
    const changed = change(loaded, now)
    if (!timed && !changed) return { ...loaded, now }
    const res = await db.prepare('UPDATE retos SET config = ?, state = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND version = ?')
      .bind(JSON.stringify(loaded.config), JSON.stringify(loaded.state), now, loaded.userId, loaded.version).run()
    if (res.meta.changes === 1) return { ...loaded, version: loaded.version + 1, now }
  }
  throw new Error('demasiados cambios a la vez')
}

/* ---------------------------------------------------------------- panel */

type Owner = { id: string; name: string; avatar: string }

/** Para admin: quién tiene acceso a retos, para saltar de unos retos a otros (como en el teatro). */
async function people(db: D1Database): Promise<Owner[]> {
  const { results } = await db.prepare(`
    SELECT DISTINCT u.id, u.username, u.name, u.avatar FROM users u
    LEFT JOIN permissions p ON p.user_id = u.id AND p.tool = 'retos'
    WHERE u.is_admin = 1 OR p.tool IS NOT NULL ORDER BY u.is_admin DESC, lower(coalesce(u.name, u.username))`)
    .all<{ id: string; username: string; name: string | null; avatar: string | null }>()
  return results.map(u => ({ id: u.id, name: u.name || u.username || 'Sin nombre', avatar: discordAvatar(u.id, u.avatar) }))
}

function panelView(l: Loaded & { now: number }, access: Access, owner: Owner, env: Env, everyone: Owner[] = []) {
  return {
    user: access.user,
    admin: access.admin,
    /** De quién es esta configuración: la propia, o la de otra persona si admin la está editando. */
    owner,
    other: owner.id !== access.user.id,
    /** Solo para admin: las personas cuyos retos puede abrir. */
    people: everyone,
    key: l.key,
    config: l.config,
    state: viewOf(l.state),
    version: l.version,
    now: l.now,
    youtubeKey: !!env.YOUTUBE_API_KEY,
  }
}

function sameOrigin(request: Request) {
  return request.headers.get('Origin') === new URL(request.url).origin
}

async function panel(request: Request, env: Env, pathname: string) {
  const access = await readAccess(request, env.DB)
  if (!access) return json({ error: 'sin sesión' }, 401)
  if (!access.tools.includes('retos')) return json({ error: 'sin acceso' }, 403)
  if (request.method !== 'GET' && !sameOrigin(request)) return json({ error: 'origen no permitido' }, 403)

  // Admin puede abrir la configuración de cualquier persona (?persona=<id de Discord>) para dejársela hecha.
  let owner: Owner = { id: access.user.id, name: access.user.name, avatar: access.user.avatar }
  const persona = new URL(request.url).searchParams.get('persona')
  if (persona && persona !== access.user.id) {
    if (!access.admin) return json({ error: 'solo admin' }, 403)
    const who = await env.DB.prepare('SELECT id, username, name, avatar FROM users WHERE id = ?').bind(persona)
      .first<{ id: string; username: string; name: string | null; avatar: string | null }>()
    if (!who) return json({ error: 'no existe esa persona' }, 404)
    owner = { id: who.id, name: who.name || who.username || 'Sin nombre', avatar: discordAvatar(who.id, who.avatar) }
  }
  await ensureRow(env.DB, owner.id)
  const where = { userId: owner.id }

  if (pathname === '/api/panel' && request.method === 'GET') {
    // La lista de personas solo la primera vez (?people=1), no en cada consulta de cada 2 s.
    const everyone = access.admin && new URL(request.url).searchParams.has('people') ? await people(env.DB) : []
    return json(panelView((await mutate(env.DB, where))!, access, owner, env, everyone))
  }
  if (pathname === '/api/panel/config' && request.method === 'PUT') {
    const body = await request.json<{ config?: unknown }>().catch(() => ({ config: undefined }))
    const l = await mutate(env.DB, where, l => { l.config = sanitizeConfig(body.config, l.config); return true })
    return json(panelView(l!, access, owner, env))
  }
  if (pathname === '/api/panel/ops' && request.method === 'POST') {
    const body = await request.json<{ ops?: unknown }>().catch(() => ({ ops: undefined }))
    const ops = Array.isArray(body.ops) ? (body.ops.slice(0, 20) as PanelOp[]) : []
    const l = await mutate(env.DB, where, (l, now) => {
      let changed = false
      for (const op of ops) changed = applyPanelOp(l.state, l.config, op, access.user.name, now, random) || changed
      // Lo que se suma a mano puede llenar una poción: que empiece su reto en el acto.
      return advance(l.state, l.config, now, random) || changed
    })
    return json(panelView(l!, access, owner, env))
  }
  if (pathname === '/api/panel/key' && request.method === 'POST') {
    await env.DB.prepare('UPDATE retos SET key = ?, version = version + 1 WHERE user_id = ?').bind(crypto.randomUUID(), owner.id).run()
    return json(panelView((await mutate(env.DB, where))!, access, owner, env))
  }
  return json({ error: 'no encontrado' }, 404)
}

/* ---------------------------------------------------------------- overlay */

const overlayView = (l: Loaded & { now: number }) => ({ config: overlayConfig(l.config), state: viewOf(l.state), version: l.version, now: l.now })

type EventsBody = { events?: FeedEvent[]; ballots?: BallotIn[]; commands?: CommandIn[]; redemptions?: RedemptionIn[]; readers?: unknown }

/**
 * La foto de perfil de alguien de Twitch, para el aviso de «¡Nuevo reto!». El chat no la trae y la API
 * de Twitch pide cuenta, así que se pregunta a decapi.me (y si falla, a unavatar.io). Se guarda una hora.
 */
const avatarCache = new Map<string, { url: string | null; at: number }>()
async function twitchAvatar(login: string): Promise<string | null> {
  const hit = avatarCache.get(login)
  if (hit && Date.now() - hit.at < 3600_000) return hit.url
  let url: string | null = null
  try {
    const res = await fetch(`https://decapi.me/twitch/avatar/${login}`, { signal: AbortSignal.timeout(4000) })
    const text = (await res.text()).trim()
    if (res.ok && AVATAR_URL.test(text)) url = text
  } catch { /* sin respuesta */ }
  if (!url) {
    try {
      const res = await fetch(`https://unavatar.io/twitch/${login}?json`, { signal: AbortSignal.timeout(4000) })
      const body = await res.json<{ url?: string }>()
      if (res.ok && body.url && AVATAR_URL.test(body.url)) url = body.url
    } catch { /* sin respuesta */ }
  }
  avatarCache.set(login, { url, at: Date.now() })
  if (avatarCache.size > 500) avatarCache.delete(avatarCache.keys().next().value!)
  return url
}

type KickIds = { chatroom: string | null; channel: string | null }
const kickCache = new Map<string, KickIds & { at: number }>()

/**
 * El número del chat de un canal de Kick y el del propio canal (por ahí llegan algunos avisos, como
 * los regalos de subs). Kick a veces no deja preguntarlo desde un servidor: entonces null.
 */
async function kickIds(slug: string): Promise<KickIds> {
  const key = slug.toLowerCase()
  const hit = kickCache.get(key)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit
  const ids: KickIds = { chatroom: null, channel: null }
  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(key)}`, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const d = await res.json<{ id?: number; chatroom?: { id?: number } }>()
      ids.chatroom = String(d.chatroom?.id ?? '') || null
      ids.channel = String(d.id ?? '') || null
    }
  } catch { /* sin respuesta */ }
  kickCache.set(key, { ...ids, at: Date.now() })
  return ids
}

/**
 * La clave del chat de Kick (Pusher). Kick la cambia de vez en cuando (en octubre de 2026 dejó de valer
 * 32cbd69e…), así que se le pregunta la actual, como hace su propia web, y se guarda 10 minutos.
 * Si no contesta, la última conocida.
 */
const KICK_FALLBACK = { appKey: '34bf7a0ff419a2a775b9', cluster: 'us2' }
let kickKey: { appKey: string; cluster: string; at: number } | null = null

async function kickCredentials(fresh: boolean) {
  if (!fresh && kickKey && Date.now() - kickKey.at < 10 * 60_000) return kickKey
  try {
    const res = await fetch('https://web.kick.com/api/v1/realtime/connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client: { id: crypto.randomUUID(), type: 'web' }, capabilities: { accepted_providers: [{ provider: 'pusher' }] } }),
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const body = await res.json<{ data?: { connections?: { provider?: string; credentials?: { app_key?: string; cluster?: string } }[] } }>()
      const found = body.data?.connections?.find(c => c.provider === 'pusher' && c.credentials?.app_key && c.credentials.cluster)
      if (found && /^[\w-]{8,64}$/.test(found.credentials!.app_key!) && /^[a-z0-9-]{2,20}$/.test(found.credentials!.cluster!)) {
        kickKey = { appKey: found.credentials!.app_key!, cluster: found.credentials!.cluster!, at: Date.now() }
        return kickKey
      }
    }
  } catch { /* sin respuesta: la última conocida */ }
  return kickKey ?? { ...KICK_FALLBACK, at: 0 }
}

async function overlay(request: Request, env: Env, pathname: string) {
  const url = new URL(request.url)
  const key = url.searchParams.get('key') ?? ''
  if (!KEY.test(key)) return json({ error: 'enlace no válido' }, 404)
  const where = { key }

  if (pathname === '/api/overlay' && request.method === 'GET') {
    const l = await mutate(env.DB, where)
    if (!l) return json({ error: 'enlace no válido' }, 404)
    // Si no ha cambiado nada desde la última vez, no se manda otra vez todo.
    if (String(l.version) === url.searchParams.get('v')) return new Response(null, { status: 204, headers: { 'X-Now': String(l.now) } })
    return json(overlayView(l))
  }

  if (pathname === '/api/overlay/events' && request.method === 'POST') {
    const body = await request.json<EventsBody>().catch((): EventsBody => ({}))
    const events = Array.isArray(body.events) ? body.events.slice(0, 200) : []
    const ballots = Array.isArray(body.ballots) ? body.ballots.slice(0, 2000) : []
    const commands = Array.isArray(body.commands) ? body.commands.slice(0, 20) : []
    const redemptions = Array.isArray(body.redemptions) ? body.redemptions.slice(0, 20) : []
    // La foto de quien canjea, antes de guardar (fuera del bucle de reintentos).
    await Promise.all(redemptions.map(async r => {
      if (!r || typeof r !== 'object') return
      const login = typeof r.login === 'string' ? r.login.toLowerCase() : ''
      r.avatar = /^[a-z0-9_]{2,25}$/.test(login) ? (await twitchAvatar(login)) ?? undefined : undefined
    }))
    const l = await mutate(env.DB, where, (l, now) => {
      let changed = false
      for (const ev of events) {
        if (!ev || typeof ev.id !== 'string' || !l.config.enabled[ev.p]) continue
        changed = applyEvent(l.state, l.config, { ...ev, id: ev.id.slice(0, 80) }, now) || changed
      }
      changed = applyBallots(l.state, ballots, now) || changed
      for (const cmd of commands) changed = applyCommand(l.state, l.config, cmd, now) || changed
      for (const r of redemptions) changed = applyRedemption(l.state, l.config, r, now) || changed
      if (body.readers) changed = applyReaders(l.state, body.readers, now) || changed
      return advance(l.state, l.config, now, random) || changed
    })
    if (!l) return json({ error: 'enlace no válido' }, 404)
    return json(overlayView(l))
  }

  // Lo que necesita el overlay para leer YouTube y Kick.
  const row = await rowFor(env.DB, where)
  if (!row) return json({ error: 'enlace no válido' }, 404)
  const config = parseConfig(row.config)
  const channel = config.channels.youtube

  if (pathname === '/api/overlay/youtube' && request.method === 'GET') {
    const videoId = channel ? await cachedLiveVideo(channel).catch(() => null) : null
    return json({ key: env.YOUTUBE_API_KEY ?? null, channel, videoId })
  }
  if (pathname === '/api/overlay/youtube/start' && request.method === 'GET') {
    if (!channel) return json({ live: false })
    const session = await startChat(channel).catch(() => null)
    return json(session ? { live: true, session } : { live: false })
  }
  if (pathname === '/api/overlay/youtube/poll' && request.method === 'POST') {
    const body = await request.json<Partial<ChatSession> & { continuation?: string }>().catch((): Partial<ChatSession> & { continuation?: string } => ({}))
    if (typeof body.continuation !== 'string' || typeof body.clientVersion !== 'string') return json({ error: 'faltan datos' }, 400)
    const result = await pollChat({ clientVersion: body.clientVersion, visitorData: body.visitorData, apiKey: body.apiKey }, body.continuation)
    return json(result)
  }
  if (pathname === '/api/overlay/kick' && request.method === 'GET') {
    const slug = config.channels.kick.replace(/^https?:\/\/(www\.)?kick\.com\//i, '').replace(/[/?#].*$/, '').trim()
    if (!slug) return json({ slug: '', chatroomId: null, channelId: null })
    const [{ appKey, cluster }, ids] = await Promise.all([kickCredentials(url.searchParams.has('fresh')), kickIds(slug)])
    return json({ slug, chatroomId: config.kickChatroom || ids.chatroom, channelId: ids.channel, appKey, cluster })
  }
  return json({ error: 'no encontrado' }, 404)
}

/* ---------------------------------------------------------------- entrada */

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    const { pathname } = url
    try {
      // El overlay de OBS: la misma página para todas las claves; la clave la lee el propio overlay.
      if (pathname.startsWith('/o/')) {
        return env.ASSETS.fetch(new Request(new URL('/overlay', url), request))
      }
      if (pathname.startsWith('/api/')) {
        await ensureSchema(env.DB)
        if (pathname === '/api/overlay' || pathname.startsWith('/api/overlay/')) return await overlay(request, env, pathname)
        if (pathname === '/api/panel' || pathname.startsWith('/api/panel/')) return await panel(request, env, pathname)
        return json({ error: 'no encontrado' }, 404)
      }
      // El panel: solo con sesión y acceso a «retos».
      if (pathname === '/' || pathname === '/index.html') {
        const blocked = await gate(request, env.DB, 'retos', 'Retos')
        if (blocked) return blocked
      }
      return env.ASSETS.fetch(request)
    } catch (error) {
      console.error(error)
      return json({ error: 'error interno' }, 500)
    }
  },
} satisfies ExportedHandler<Env>
