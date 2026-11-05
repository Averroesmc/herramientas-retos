/**
 * El overlay de OBS lee los chats y manda al servidor lo que importa:
 *   · subs, renovaciones y regalos (llenan las pociones)
 *   · los votos 1, 2, 3 mientras se elige el reto
 *   · !completado / !fallado de los moderadores y del streamer
 *
 * Si el overlay está en varias fuentes de OBS, solo una lee el chat (la que se queda el candado
 * del navegador). Twitch se lee como invitado, sin cuenta. YouTube, con la API oficial (la clave
 * del Worker) o, si no hay clave o se acaba la cuota, a través del servidor. Kick, por su chat
 * público (no oficial: si Kick lo cambia puede dejar de ir; quedan los +1 del panel).
 *
 * Basado en el lector del bingo (marta-sims-robar/src/lib/votacion/chat.ts).
 */
import { overlayApi, sendEvents, type Snapshot } from './api'
import { findLiveChat, streamChat, YouTubeApiError, type ChatResponse, type LiveChat } from './youtube-api'
import {
  GRACE_MS, parseCommand, parseVote, phaseOf,
  type BallotIn, type CommandIn, type FeedEvent, type Platform, type ReaderStatus,
} from '../../shared/logic'

/** Un mensaje normal de cualquier chat. */
type Line = { id: string; k: string; p: Platform; name: string; text: string; at: number; mod: boolean }
/** Una sub o un regalo leído del chat. */
type Sub = { id: string; p: Platform; name: string; n: number; at: number; gift: boolean; renewal: boolean }

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })

/* ---------------------------------------------------------------- Twitch */

function unescapeTag(value = '') {
  return value.replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\')
}

function parseIrc(line: string) {
  const tags: Record<string, string> = {}
  let rest = line
  if (rest.startsWith('@')) {
    const space = rest.indexOf(' ')
    for (const pair of rest.slice(1, space).split(';')) {
      const eq = pair.indexOf('=')
      tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1))
    }
    rest = rest.slice(space + 1)
  }
  let prefix = ''
  if (rest.startsWith(':')) {
    const space = rest.indexOf(' ')
    prefix = rest.slice(1, space)
    rest = rest.slice(space + 1)
  }
  const at = rest.indexOf(' :')
  const trailing = at >= 0 ? rest.slice(at + 2) : ''
  const command = (at >= 0 ? rest.slice(0, at) : rest).split(' ')[0] ?? ''
  return { tags, prefix, command, trailing }
}

/** Los avisos de Twitch que son subs. Las regaladas llegan una a una (subgift), también las de un regalo grande. */
const TWITCH_SUBS: Record<string, { gift: boolean; renewal: boolean } | undefined> = {
  sub: { gift: false, renewal: false },
  resub: { gift: false, renewal: true },
  subgift: { gift: true, renewal: false },
  anonsubgift: { gift: true, renewal: false },
  giftpaidupgrade: { gift: false, renewal: true },
  anongiftpaidupgrade: { gift: false, renewal: true },
  primepaidupgrade: { gift: false, renewal: true },
}

function connectTwitch(channel: string, onLine: (l: Line) => void, onSub: (s: Sub) => void, onStatus: (s: ReaderStatus) => void) {
  let socket: WebSocket | null = null
  let stopped = false
  let attempt = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  const name = channel.trim().replace(/^#/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/[/?#].*$/, '').toLowerCase()

  const open = () => {
    onStatus('connecting')
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
    socket = ws
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands')
      ws.send('PASS SCHMOOPIIE')
      ws.send(`NICK justinfan${10000 + Math.floor(Math.random() * 80000)}`)
      ws.send(`JOIN #${name}`)
    }
    ws.onmessage = event => {
      for (const raw of String(event.data).split('\r\n')) {
        if (!raw) continue
        if (raw.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue }
        const msg = parseIrc(raw)
        if (msg.command === 'ROOMSTATE' || msg.command === '366') { attempt = 0; onStatus('ok') }
        const login = (msg.tags.login || msg.prefix.split('!')[0] || '').toLowerCase()
        const display = msg.tags['display-name'] || login
        const at = Number(msg.tags['tmi-sent-ts']) || Date.now()
        if (msg.command === 'USERNOTICE') {
          const kind = TWITCH_SUBS[msg.tags['msg-id'] ?? '']
          if (kind) {
            const anon = (msg.tags['msg-id'] ?? '').startsWith('anon')
            onSub({ id: `t-${msg.tags.id || `${login}-${at}`}`, p: 'twitch', name: anon ? 'Anónimo' : display, n: 1, at, ...kind })
          }
          continue
        }
        if (msg.command !== 'PRIVMSG') continue
        const badges = msg.tags.badges ?? ''
        onLine({
          id: `t-${msg.tags.id || `${login}-${at}`}`,
          k: `t:${msg.tags['user-id'] || login}`,
          p: 'twitch',
          name: display,
          text: msg.trailing.trim(),
          at,
          mod: msg.tags.mod === '1' || /(^|,)(broadcaster|moderator)\//.test(badges),
        })
      }
    }
    ws.onclose = () => {
      if (socket !== ws) return
      onStatus(stopped ? 'off' : 'error')
      if (stopped) return
      retry = setTimeout(open, Math.min(30_000, 1000 * 2 ** attempt++))
    }
  }

  open()
  return () => { stopped = true; clearTimeout(retry); const ws = socket; socket = null; ws?.close() }
}

/* ---------------------------------------------------------------- Kick */

/** El chat público de Kick (Pusher). No es oficial: si Kick lo cambia, puede dejar de ir. */
const KICK_WS = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false'

type KickMessage = { id?: string; content?: string; created_at?: string; sender?: { id?: number; username?: string; slug?: string; identity?: { badges?: { type?: string }[] } } }

function connectKick(chatroom: string, onLine: (l: Line) => void, onSub: (s: Sub) => void, onStatus: (s: ReaderStatus) => void) {
  let socket: WebSocket | null = null
  let stopped = false
  let attempt = 0
  let retry: ReturnType<typeof setTimeout> | undefined

  const open = () => {
    onStatus('connecting')
    const ws = new WebSocket(KICK_WS)
    socket = ws
    ws.onmessage = event => {
      let msg: { event?: string; data?: string; channel?: string }
      try { msg = JSON.parse(String(event.data)) } catch { return }
      let data: Record<string, unknown> = {}
      try { data = typeof msg.data === 'string' ? JSON.parse(msg.data) : (msg.data ?? {}) } catch { /* sin datos */ }
      switch (msg.event) {
        case 'pusher:connection_established':
          ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${chatroom}.v2` } }))
          break
        case 'pusher:ping':
          ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }))
          break
        case 'pusher_internal:subscription_succeeded':
          attempt = 0
          onStatus('ok')
          break
        case 'App\\Events\\ChatMessageEvent': {
          const m = data as KickMessage
          const user = m.sender?.username ?? ''
          const badges = m.sender?.identity?.badges ?? []
          onLine({
            id: `k-${m.id ?? `${user}-${Date.now()}`}`,
            k: `k:${m.sender?.id ?? (m.sender?.slug || user)}`,
            p: 'kick',
            name: user || 'Kick',
            text: (m.content ?? '').trim(),
            at: Date.parse(m.created_at ?? '') || Date.now(),
            mod: badges.some(b => b.type === 'moderator' || b.type === 'broadcaster'),
          })
          break
        }
        case 'App\\Events\\SubscriptionEvent': {
          const user = String(data.username ?? 'Kick')
          const months = Number(data.months ?? 1)
          // Kick no da id: se usa el nombre y el minuto, para no contarla dos veces si se repite.
          onSub({ id: `k-sub-${user}-${months}-${Math.floor(Date.now() / 60_000)}`, p: 'kick', name: user, n: 1, at: Date.now(), gift: false, renewal: months > 1 })
          break
        }
        case 'App\\Events\\GiftedSubscriptionsEvent': {
          const gifted = Array.isArray(data.gifted_usernames) ? data.gifted_usernames.length : 1
          const gifter = String(data.gifter_username ?? 'Anónimo')
          onSub({ id: `k-gift-${gifter}-${data.gifter_total ?? ''}-${Math.floor(Date.now() / 10_000)}`, p: 'kick', name: gifter, n: Math.max(1, gifted), at: Date.now(), gift: true, renewal: false })
          break
        }
      }
    }
    ws.onclose = () => {
      if (socket !== ws) return
      onStatus(stopped ? 'off' : 'error')
      if (stopped) return
      retry = setTimeout(open, Math.min(30_000, 1000 * 2 ** attempt++))
    }
  }

  open()
  return () => { stopped = true; clearTimeout(retry); const ws = socket; socket = null; ws?.close() }
}

/* ---------------------------------------------------------------- YouTube */

type YouTubeSetup = { key: string | null; channel: string; videoId: string | null }
type ScrapedMessage = {
  id: string
  at: number
  author: string
  channelId: string | null
  roles: { mod: boolean; sub: boolean; broadcaster: boolean }
  parts: ({ text: string } | { emote: string; name: string })[]
  event?: { type: 'tip'; amount: string } | { type: 'sub' } | { type: 'resub'; months: number } | { type: 'giftbomb'; gifted: number }
}
type ScrapedSession = { videoId: string; clientVersion: string; visitorData?: string; apiKey?: string; reload: string }

const ytKey = (channelId: string | null, name: string) => `y:${channelId || name.replace(/[^\w.@-]/g, '').slice(0, 60) || 'anon'}`

/* ---------------------------------------------------------------- lector */

type Status = Record<Platform, ReaderStatus> & { note: string }

export class ChatReader {
  private snap: Snapshot | null = null
  private skew = 0
  private leader = false
  private readonly lock = new AbortController()
  private readonly started = Date.now()
  private twitch: { channel: string; stop: () => void } | null = null
  private kick: { room: string; stop: () => void } | null = null
  private kickLookup = { slug: '', at: 0, running: false }
  private youtube: { channel: string; abort: AbortController } | null = null
  private status: Status = { twitch: 'off', youtube: 'off', kick: 'off', note: '' }
  private notes: Record<Platform, string> = { twitch: '', youtube: '', kick: '' }
  private reported = ''
  private reportedAt = 0
  private events: FeedEvent[] = []
  /** Regalos de una misma persona que llegan seguidos: se juntan en uno («+5 regalo de…»). */
  private gifts = new Map<string, { ev: FeedEvent; timer: ReturnType<typeof setTimeout> }>()
  private ballots = new Map<string, BallotIn>()
  private ballotsRound = ''
  private commands: CommandIn[] = []
  private sending = false
  private readonly timers: ReturnType<typeof setInterval>[] = []

  private readonly key: string
  private readonly onSnapshot: (snap: Snapshot) => void

  constructor(key: string, onSnapshot: (snap: Snapshot) => void) {
    this.key = key
    this.onSnapshot = onSnapshot
  }

  start() {
    const lead = () => new Promise<void>(resolve => {
      this.leader = true
      this.lock.signal.addEventListener('abort', () => resolve(), { once: true })
      this.sync()
    })
    if (navigator.locks) navigator.locks.request(`retos-chat-${this.key}`, { signal: this.lock.signal }, lead).catch(() => {})
    else void lead()
    this.timers.push(setInterval(() => void this.flush(), 700))
    this.timers.push(setInterval(() => this.sync(), 5000))
  }

  update(snap: Snapshot, skew: number) {
    this.snap = snap
    this.skew = skew
    this.sync()
  }

  private now() { return Date.now() + this.skew }

  /** Conecta o desconecta cada chat según la configuración. */
  private sync() {
    const snap = this.snap
    if (!this.leader || !snap) return
    const { config } = snap

    const twitch = config.enabled.twitch ? config.channels.twitch.trim() : ''
    if (this.twitch && this.twitch.channel !== twitch) { this.twitch.stop(); this.twitch = null }
    if (!this.twitch && twitch) {
      this.twitch = { channel: twitch, stop: connectTwitch(twitch, l => this.take(l), s => this.take_sub(s), s => this.setStatus('twitch', s)) }
    }
    if (!twitch) this.setStatus('twitch', 'off')

    const youtube = config.enabled.youtube ? config.channels.youtube.trim() : ''
    if (this.youtube && this.youtube.channel !== youtube) { this.youtube.abort.abort(); this.youtube = null }
    if (!this.youtube && youtube) {
      const abort = new AbortController()
      this.youtube = { channel: youtube, abort }
      void this.readYouTube(abort.signal)
    }
    if (!youtube) this.setStatus('youtube', 'off', '')

    void this.syncKick()
    this.report()
  }

  private async syncKick() {
    const config = this.snap?.config
    const slug = config?.enabled.kick ? config.channels.kick.trim() : ''
    if (!slug) {
      if (this.kick) { this.kick.stop(); this.kick = null }
      this.setStatus('kick', 'off', '')
      return
    }
    if (this.kickLookup.running) return
    if (this.kick && this.kickLookup.slug === slug + (config?.kickChatroom ?? '')) return
    if (!this.kick && this.kickLookup.slug === slug + (config?.kickChatroom ?? '') && Date.now() - this.kickLookup.at < 60_000) return
    this.kickLookup = { slug: slug + (config?.kickChatroom ?? ''), at: Date.now(), running: true }
    try {
      const info = await overlayApi<{ slug: string; chatroomId: string | null }>(this.key, '/kick')
      let room = info?.chatroomId ?? null
      if (!room && info?.slug) {
        // Desde el ordenador del streamer Kick a veces sí contesta.
        room = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(info.slug)}`)
          .then(r => (r.ok ? r.json() : null))
          .then((d: { chatroom?: { id?: number } } | null) => (d?.chatroom?.id ? String(d.chatroom.id) : null))
          .catch(() => null)
      }
      if (this.kick && this.kick.room !== room) { this.kick.stop(); this.kick = null }
      if (!room) { this.setStatus('kick', 'error', 'Kick: no se encuentra el chat. Pon su número en el panel.'); return }
      if (!this.kick) this.kick = { room, stop: connectKick(room, l => this.take(l), s => this.take_sub(s), s => this.setStatus('kick', s, '')) }
    } finally {
      this.kickLookup.running = false
    }
  }

  private setStatus(p: Platform, status: ReaderStatus, note?: string) {
    this.status[p] = status
    if (note !== undefined) this.notes[p] = note
    this.status.note = Object.values(this.notes).filter(Boolean).join(' · ')
    this.report()
  }

  private pendingReport: Status | null = null
  /** Avisa al panel de cómo va cada chat: al cambiar algo y cada 30 s. */
  private report() {
    if (!this.leader) return
    const text = JSON.stringify(this.status)
    if (text === this.reported && Date.now() - this.reportedAt < 30_000) return
    this.reported = text
    this.reportedAt = Date.now()
    this.pendingReport = { ...this.status }
  }

  /** Una sub: se apunta (los regalos seguidos de una misma persona se juntan). */
  private take_sub(sub: Sub) {
    const config = this.snap?.config
    if (!config || !config.enabled[sub.p]) return
    if (sub.renewal && !config.countRenewals) return
    // Lo que había en el chat antes de abrir el overlay no cuenta.
    if (sub.at < this.started - 60_000) return
    const ev: FeedEvent = { id: sub.id, p: sub.p, name: sub.name, n: sub.n, at: sub.at, gift: sub.gift }
    if (!sub.gift || sub.n > 1) { this.events.push(ev); return }
    const key = `${sub.p}:${sub.name}`
    const group = this.gifts.get(key)
    if (group) {
      group.ev.n += 1
      clearTimeout(group.timer)
      group.timer = setTimeout(() => this.closeGift(key), 2500)
    } else {
      this.gifts.set(key, { ev, timer: setTimeout(() => this.closeGift(key), 2500) })
    }
  }

  private closeGift(key: string) {
    const group = this.gifts.get(key)
    if (!group) return
    this.gifts.delete(key)
    this.events.push(group.ev)
  }

  /** Un mensaje: puede ser un voto o un comando de moderador. */
  private take(line: Line) {
    const snap = this.snap
    const round = snap?.state.round
    if (!snap || !round || !line.text) return
    const now = this.now()
    const phase = phaseOf(round, now)

    if (line.mod && snap.config.modCommands[line.p] && phase === 'play') {
      const ok = parseCommand(line.text)
      if (ok !== null) { this.commands.push({ p: line.p, name: line.name, ok }); return }
    }

    if (round.mode === 'roulette' || round.decidedAt !== null) return
    if (round.mode === 'winner' && line.p !== round.p) return
    if (now < round.startedAt || now > round.voteEndsAt + GRACE_MS) return
    const vote = parseVote(line.text, round.options.length)
    if (!vote) return
    if (this.ballotsRound !== round.id) { this.ballots.clear(); this.ballotsRound = round.id }
    this.ballots.set(line.k, { k: line.k, p: line.p, o: vote, at: line.at })
  }

  private async flush() {
    if (this.sending) return
    const round = this.snap?.state.round
    if (this.ballotsRound && round?.id !== this.ballotsRound) { this.ballots.clear(); this.ballotsRound = '' }
    if (!this.events.length && !this.ballots.size && !this.commands.length && !this.pendingReport) return
    this.sending = true
    const events = this.events.slice()
    const ballots = [...this.ballots.values()]
    const commands = this.commands.slice()
    const readers = this.pendingReport
    try {
      const snap = await sendEvents(this.key, { events, ballots, commands, readers })
      this.events = this.events.filter(e => !events.includes(e))
      for (const b of ballots) if (this.ballots.get(b.k) === b) this.ballots.delete(b.k)
      this.commands = this.commands.filter(c => !commands.includes(c))
      if (this.pendingReport === readers) this.pendingReport = null
      if (snap) this.onSnapshot(snap)
    } catch {
      // Se reintenta en la siguiente vuelta.
    } finally {
      this.sending = false
    }
  }

  /* ------------------------------------------------------------ YouTube */

  private async readYouTube(signal: AbortSignal) {
    while (!signal.aborted) {
      this.setStatus('youtube', 'connecting')
      const setup = await overlayApi<YouTubeSetup>(this.key, '/youtube', { signal }).catch(() => null)
      if (signal.aborted) return
      if (!setup?.channel) { this.setStatus('youtube', 'error', 'YouTube: no se pudo preparar'); await sleep(30_000, signal); continue }
      if (setup.key) {
        const done = await this.officialYouTube(setup, signal)
        if (done === 'retry') continue
        if (done === 'offline') { await sleep(60_000, signal); continue }
      }
      if (!signal.aborted) await this.scrapedYouTube(signal)
    }
  }

  /** Mensajes, miembros nuevos, aniversarios y regalos de la API oficial. */
  private youtubeItem(item: NonNullable<ChatResponse['items']>[number]) {
    const who = item.authorDetails ?? {}
    const name = (who.displayName ?? '').replace(/^@/, '').trim() || 'YouTube'
    const at = Date.parse(item.snippet.publishedAt) || Date.now()
    const id = `y-${item.id}`
    switch (item.snippet.type) {
      case 'textMessageEvent':
        this.take({ id, k: ytKey(who.channelId ?? null, name), p: 'youtube', name, at, text: (item.snippet.textMessageDetails?.messageText ?? item.snippet.displayMessage ?? '').trim(), mod: !!(who.isChatModerator || who.isChatOwner) })
        break
      case 'newSponsorEvent':
        this.take_sub({ id, p: 'youtube', name, n: 1, at, gift: false, renewal: false })
        break
      case 'memberMilestoneChatEvent':
        this.take_sub({ id, p: 'youtube', name, n: 1, at, gift: false, renewal: true })
        break
      case 'membershipGiftingEvent':
        this.take_sub({ id, p: 'youtube', name, n: Math.max(1, item.snippet.membershipGiftingDetails?.giftMembershipsCount ?? 1), at, gift: true, renewal: false })
        break
    }
  }

  /** La API oficial. 'fallback' si la clave no vale o no queda cuota (se pasa al método del servidor). */
  private async officialYouTube(setup: YouTubeSetup, signal: AbortSignal): Promise<'offline' | 'fallback' | 'retry'> {
    const key = setup.key!
    const seen = new Set<string>()
    let chat: LiveChat | null = null
    let pageToken: string | undefined
    while (!signal.aborted) {
      try {
        if (!chat) {
          chat = await findLiveChat(setup.channel, key, setup.videoId, signal, !setup.videoId)
          if (!chat) { this.setStatus('youtube', 'ok', 'YouTube: sin directo ahora'); return 'offline' }
        }
        const began = Date.now()
        this.setStatus('youtube', 'ok', '')
        for await (const response of streamChat(chat.liveChatId, key, pageToken, signal) as AsyncGenerator<ChatResponse & { error?: { message?: string; code?: number; errors?: { reason?: string }[] } }>) {
          if (response.error) throw new YouTubeApiError(response.error.message ?? 'Error de YouTube', response.error.code ?? 500, response.error.errors?.[0]?.reason ?? '')
          pageToken = response.nextPageToken ?? pageToken
          for (const item of response.items ?? []) {
            if (seen.has(item.id)) continue
            seen.add(item.id)
            this.youtubeItem(item)
          }
          if (response.offlineAt) { this.setStatus('youtube', 'ok', 'YouTube: el directo ha terminado'); return 'offline' }
        }
        // YouTube cierra la conexión cada poco: se reabre desde el último mensaje.
        await sleep(Math.max(0, 3000 - (Date.now() - began)), signal)
      } catch (error) {
        if (signal.aborted) return 'retry'
        if (error instanceof YouTubeApiError && (error.quota || (error.key && !error.gone))) {
          this.setStatus('youtube', 'connecting', youtubeProblem(error))
          return 'fallback'
        }
        if (error instanceof YouTubeApiError && error.gone) return 'retry'
        this.setStatus('youtube', 'error', youtubeProblem(error))
        await sleep(5000, signal)
      }
    }
    return 'retry'
  }

  /** Sin clave: el servidor lee la web de YouTube y el overlay le va preguntando. */
  private async scrapedYouTube(signal: AbortSignal) {
    const seen = new Set<string>()
    while (!signal.aborted) {
      try {
        const start = await overlayApi<{ live: boolean; session?: ScrapedSession }>(this.key, '/youtube/start', { signal })
        if (!start?.live || !start.session) {
          this.setStatus('youtube', 'ok', 'YouTube: sin directo ahora')
          await sleep(30_000, signal)
          continue
        }
        const session = start.session
        this.setStatus('youtube', 'ok', 'YouTube: método de reserva (sin clave o sin cuota)')
        let continuation = session.reload
        while (!signal.aborted) {
          const result = await overlayApi<{ messages: ScrapedMessage[]; continuation: string | null; timeoutMs: number; ended: boolean }>(
            this.key, '/youtube/poll', { method: 'POST', body: JSON.stringify({ ...session, continuation }), signal })
          if (!result) break
          for (const m of result.messages) {
            if (seen.has(m.id)) continue
            seen.add(m.id)
            const name = m.author.replace(/^@/, '').trim() || 'YouTube'
            const id = `y-${m.id}`
            if (m.event?.type === 'sub') this.take_sub({ id, p: 'youtube', name, n: 1, at: m.at, gift: false, renewal: false })
            else if (m.event?.type === 'resub') this.take_sub({ id, p: 'youtube', name, n: 1, at: m.at, gift: false, renewal: true })
            else if (m.event?.type === 'giftbomb') this.take_sub({ id, p: 'youtube', name, n: Math.max(1, m.event.gifted), at: m.at, gift: true, renewal: false })
            else if (!m.event) {
              const text = m.parts.map(part => ('emote' in part ? ` ${part.name} ` : part.text)).join('').trim()
              this.take({ id, k: ytKey(m.channelId, name), p: 'youtube', name, text, at: m.at, mod: m.roles.mod || m.roles.broadcaster })
            }
          }
          if (result.ended || !result.continuation) break
          continuation = result.continuation
          await sleep(Math.min(3000, Math.max(1000, result.timeoutMs)), signal)
        }
      } catch (error) {
        if (signal.aborted) return
        this.setStatus('youtube', 'error', youtubeProblem(error))
        await sleep(5000, signal)
      }
    }
  }
}

function youtubeProblem(error: unknown): string {
  if (error instanceof YouTubeApiError) {
    if (error.quota) return 'YouTube: se ha gastado la cuota de hoy (se usa el método de reserva)'
    if (error.key) return 'YouTube: la clave no vale para esta página (se usa el método de reserva)'
    if (error.gone) return 'YouTube: el chat ya no está disponible'
    return `YouTube: ${error.message}`
  }
  return 'YouTube: no se pudo conectar'
}
