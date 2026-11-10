/**
 * La batalla de pociones: cada plataforma (Twitch, YouTube, Kick) llena su poción con subs o
 * miembros. La primera que llega a su meta gana un reto: el chat elige uno entre tres (o una
 * ruleta) y el streamer tiene unos minutos para conseguirlo.
 *
 * Aquí está toda la lógica, sin red ni base de datos. La usan el servidor (worker/retos.ts),
 * el panel y el overlay de OBS, así que vale en los dos lados.
 *
 * Las fases de cada reto salen de las horas guardadas (intro → votación → resultado → reto →
 * veredicto), así que el overlay las calcula igual que el servidor sin esperar a nadie.
 */

export type Platform = 'twitch' | 'youtube' | 'kick'
export const PLATFORMS: Platform[] = ['twitch', 'youtube', 'kick']
export const PLATFORM_NAME: Record<Platform, string> = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' }

export type Difficulty = 1 | 2 | 3
export const DIFFICULTY_NAME: Record<Difficulty, string> = { 1: 'Medio', 2: 'Difícil', 3: 'Muy difícil' }

export type Style = 'potions' | 'banner'
/** La tipografía pixelada del overlay. Pixelify era la de siempre, pero en pequeño el 2 parece un 8 y el 5 una S. */
export type Font = 'jersey' | 'pixelify' | 'vt323'
export const FONTS: Font[] = ['jersey', 'pixelify', 'vt323']
export const FONT_NAME: Record<Font, string> = { jersey: 'Jersey 10', pixelify: 'Pixelify Sans', vt323: 'VT323' }
export type Mode = 'winner' | 'all' | 'roulette'
export type ReaderStatus = 'off' | 'connecting' | 'ok' | 'error'

/**
 * `by`: quién lo pidió, si llegó por puntos del canal de Twitch. `done`: ya se consiguió y no vuelve a
 * salir nunca (desde el panel se puede devolver a la lista).
 */
export interface Challenge { id: string; text: string; diff: Difficulty; on: boolean; by?: string; done?: boolean }

export interface Config {
  style: Style
  font: Font
  /** Pociones: si pasa un minuto sin subs, se esconden por debajo del borde de la cámara. */
  autoHide: boolean
  /** Cada día, a la hora `resetHour` (hora de España), todas las pociones vuelven a cero. */
  dailyReset: boolean
  resetHour: number
  goals: Record<Platform, number>
  enabled: Record<Platform, boolean>
  /** Canal de Twitch, canal de YouTube (@canal, enlace o id) y canal de Kick. */
  channels: Record<Platform, string>
  /** Si se sabe, el número del chat de Kick (por si Kick no deja buscarlo solo). */
  kickChatroom: string
  /** Si cuentan las renovaciones (resubs de Twitch y Kick, aniversarios de YouTube). */
  countRenewals: boolean
  /** !completado y !fallado de los moderadores y del streamer, por plataforma. */
  modCommands: Record<Platform, boolean>
  challengeMin: number
  voteSec: number
  mode: Mode
  keepProgress: boolean
  sound: boolean
  volume: number
  subSound: boolean
  /**
   * La recompensa de puntos del canal de Twitch que añade retos a la lista (su id; vacío = apagado).
   * Tiene que pedir texto al espectador: ese texto es el reto. `diff`, la dificultad con la que entran.
   */
  reward: { id: string; diff: Difficulty }
  /** Dónde está la cámara en la escena de 1920×1080: las pociones asoman por encima. */
  camera: { x: number; y: number; w: number }
  challenges: Challenge[]
}

/** Una sub, un miembro o un regalo (n > 1). */
export interface FeedEvent { id: string; p: Platform; name: string; n: number; at: number; gift: boolean }

export interface RoundOption { id: string; text: string; diff: Difficulty }

export interface Round {
  id: string
  p: Platform
  mode: Mode
  startedAt: number
  options: RoundOption[]
  voteEndsAt: number
  ballots: Record<string, number>
  winner: number | null
  /** Las empatadas (o todas, con ruleta): el overlay hace una ruleta que acaba en `winner`. */
  tied: number[]
  decidedAt: number | null
  playStartsAt: number | null
  durationMs: number
  result: { ok: boolean; by: string | null; at: number } | null
  /** Un reto relanzado a mano desde el panel: sin celebración ni votación, y no gasta ninguna poción. */
  again?: boolean
}

export interface HistoryItem { id: string; text: string; p: Platform; ok: boolean; by: string | null; at: number }

export interface Readers { twitch: ReaderStatus; youtube: ReaderStatus; kick: ReaderStatus; note: string; at: number }

export interface State {
  counts: Record<Platform, number>
  /** Plataformas que ya han llenado su poción y esperan su reto. */
  queue: Platform[]
  round: Round | null
  /** Antes, los retos completados en este directo. Ahora se marcan en el propio reto (`done`) y esto se queda vacío. */
  done: string[]
  /** El día (AAAA-MM-DD) que va desde las `resetHour` de un día hasta las del siguiente: al cambiar, vuelta a cero. */
  day?: string
  history: HistoryItem[]
  feed: FeedEvent[]
  seen: string[]
  lastActivity: number
  readers: Readers
  /** Esperando a que alguien canjee la recompensa para enlazarla (botón «Detectar» del panel). */
  rewardLearn: boolean
  /** Los últimos retos añadidos con puntos del canal: el overlay los anuncia. */
  added: AddedChallenge[]
}

export interface AddedChallenge { id: string; text: string; by: string; at: number; avatar?: string }

/* ---------------------------------------------------------------- tiempos */

/** La celebración de la meta (la poción en el centro o el banner) antes de elegir reto. */
export const INTRO_MS = 5600
/** Se aceptan votos que lleguen un poco tarde (el chat va con retraso). */
export const GRACE_MS = 2500
/** El reto elegido se queda en grande antes de pasar al temporizador. */
export const REVEAL_MS = 3200
/** La ruleta, si hay empate o si se elige el reto con ruleta. */
export const ROULETTE_MS = 3800
/** «¡Conseguido!» o «Fallado» en pantalla. */
export const RESULT_MS = 4200
/** El día «de directo»: el día de España en que cae la hora `now` contando desde las `hour` (9 → de 9:00 a 9:00). */
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' })
export function streamDay(now: number, hour: number) {
  return dayFormat.format(new Date(now - hour * 3600_000))
}

const FEED_MAX = 40
const SEEN_MAX = 600
const HISTORY_MAX = 30
const BALLOTS_MAX = 20000

export type Phase = 'intro' | 'vote' | 'reveal' | 'play' | 'result'

export function phaseOf(round: Pick<Round, 'result' | 'startedAt' | 'decidedAt' | 'playStartsAt'>, now: number): Phase {
  if (round.result) return 'result'
  if (now < round.startedAt + INTRO_MS) return 'intro'
  if (round.decidedAt === null || round.playStartsAt === null) return 'vote'
  if (now < round.playStartsAt) return 'reveal'
  return 'play'
}

/* ---------------------------------------------------------------- por defecto */

const DEFAULT_CHALLENGES: [string, Difficulty][] = [
  ['Matar un ghast devolviéndole su propia bola de fuego', 3],
  ['MLG con cubo de agua desde más de 100 bloques', 3],
  ['Encender un portal al Nether sin pico de diamante', 2],
  ['Matar 3 creepers sin que explote ninguno', 2],
  ['Conseguir 4 perlas de ender', 2],
  ['Jugar todo el reto sin HUD (F1)', 3],
  ['Jugar todo el reto sin armadura', 2],
  ['Jugar todo el reto sin comer y sin escudo', 2],
  ['Matar un blaze solo con los puños', 3],
  ['Bajar a la capa −50 y volver con 3 diamantes', 3],
  ['Domesticar un caballo y saltar una valla de 2 bloques', 1],
  ['Dormir en una cama en el Nether… y sobrevivir', 3],
  ['Matar a un enderman sin recibir daño', 2],
  ['Conseguir un libro encantado con una mesa de encantamientos', 2],
  ['Hacer un MLG con un barco', 3],
  ['Construir una granja de hierro funcional', 3],
  ['Pescar un objeto encantado', 2],
  ['Matar una bruja sin usar escudo', 2],
  ['Conseguir 10 bloques de obsidiana', 2],
  ['Cruzar un lago de lava del Nether sin puente de piedra', 3],
  ['Matar un esqueleto con su propia flecha (con escudo y arco prohibidos)', 3],
  ['Llegar a una fortaleza del Nether y salir con una vara de blaze', 3],
  ['Criar 2 vacas, 2 ovejas y 2 cerdos', 1],
  ['Conseguir una cabeza de zombi o esqueleto', 3],
  ['Tirarse desde la altura máxima y sobrevivir sin agua', 3],
  ['Jugar todo el reto solo con herramientas de madera', 2],
  ['Hacer un MLG con escalera o enredadera', 3],
  ['Matar 10 mobs en 2 minutos', 1],
  ['Encontrar un templo o un barco hundido', 2],
  ['Hacer una poción de fuerza o de velocidad', 3],
]

export function defaultChallenges(): Challenge[] {
  return DEFAULT_CHALLENGES.map(([text, diff], i) => ({ id: `d${i + 1}`, text, diff, on: true }))
}

export function defaultConfig(): Config {
  return {
    style: 'potions',
    font: 'jersey',
    autoHide: true,
    dailyReset: true,
    resetHour: 9,
    goals: { twitch: 10, youtube: 5, kick: 5 },
    enabled: { twitch: true, youtube: true, kick: false },
    channels: { twitch: '', youtube: '', kick: '' },
    kickChatroom: '',
    countRenewals: true,
    modCommands: { twitch: true, youtube: true, kick: true },
    challengeMin: 15,
    voteSec: 30,
    mode: 'winner',
    keepProgress: true,
    sound: true,
    volume: 70,
    subSound: true,
    camera: { x: 25, y: 503, w: 424 },
    reward: { id: '', diff: 2 },
    challenges: defaultChallenges(),
  }
}

export function initialState(now = Date.now()): State {
  return {
    counts: { twitch: 0, youtube: 0, kick: 0 },
    queue: [],
    round: null,
    done: [],
    history: [],
    feed: [],
    seen: [],
    lastActivity: now,
    readers: { twitch: 'off', youtube: 'off', kick: 'off', note: '', at: 0 },
    rewardLearn: false,
    added: [],
  }
}

/* ---------------------------------------------------------------- limpiar lo que llega */

const clamp = (n: unknown, min: number, max: number, fallback: number) => {
  const v = Math.round(Number(n))
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
}
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
const isPlatform = (v: unknown): v is Platform => v === 'twitch' || v === 'youtube' || v === 'kick'
const perPlatform = <T>(raw: unknown, base: Record<Platform, T>, fix: (v: unknown, b: T) => T): Record<Platform, T> => {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return { twitch: fix(o.twitch, base.twitch), youtube: fix(o.youtube, base.youtube), kick: fix(o.kick, base.kick) }
}

export function sanitizeChallenges(raw: unknown, base: Challenge[]): Challenge[] {
  if (!Array.isArray(raw)) return base
  const seen = new Set<string>()
  const out: Challenge[] = []
  for (const item of raw.slice(0, 300)) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const text = str(c.text, 120)
    let id = str(c.id, 40).replace(/[^\w-]/g, '')
    if (!text) continue
    if (!id || seen.has(id)) id = `c${Math.random().toString(36).slice(2, 10)}`
    seen.add(id)
    const diff = clamp(c.diff, 1, 3, 2) as Difficulty
    const by = str(c.by, 40)
    out.push({ id, text, diff, on: bool(c.on, true), ...(by ? { by } : {}), ...(c.done === true ? { done: true } : {}) })
  }
  return out
}

/** Mezcla lo que llega con la configuración actual: lo que no venga o no valga se queda como estaba. */
export function sanitizeConfig(raw: unknown, base: Config = defaultConfig()): Config {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const cam = o.camera && typeof o.camera === 'object' ? (o.camera as Record<string, unknown>) : {}
  const reward = o.reward && typeof o.reward === 'object' ? (o.reward as Record<string, unknown>) : {}
  return {
    style: o.style === 'potions' || o.style === 'banner' ? o.style : base.style,
    font: FONTS.includes(o.font as Font) ? (o.font as Font) : base.font,
    autoHide: bool(o.autoHide, base.autoHide),
    dailyReset: bool(o.dailyReset, base.dailyReset),
    resetHour: clamp(o.resetHour, 0, 23, base.resetHour),
    goals: perPlatform(o.goals, base.goals, (v, b) => clamp(v, 1, 9999, b)),
    enabled: perPlatform(o.enabled, base.enabled, (v, b) => bool(v, b)),
    channels: perPlatform(o.channels, base.channels, (v, b) => (typeof v === 'string' ? str(v, 200) : b)),
    kickChatroom: typeof o.kickChatroom === 'string' ? str(o.kickChatroom, 20).replace(/\D/g, '') : base.kickChatroom,
    countRenewals: bool(o.countRenewals, base.countRenewals),
    modCommands: perPlatform(o.modCommands, base.modCommands, (v, b) => bool(v, b)),
    challengeMin: clamp(o.challengeMin, 1, 120, base.challengeMin),
    voteSec: clamp(o.voteSec, 10, 300, base.voteSec),
    mode: o.mode === 'winner' || o.mode === 'all' || o.mode === 'roulette' ? o.mode : base.mode,
    keepProgress: bool(o.keepProgress, base.keepProgress),
    sound: bool(o.sound, base.sound),
    volume: clamp(o.volume, 0, 100, base.volume),
    subSound: bool(o.subSound, base.subSound),
    camera: {
      x: clamp(cam.x, -500, 1920, base.camera.x),
      y: clamp(cam.y, 0, 1080, base.camera.y),
      w: clamp(cam.w, 200, 1920, base.camera.w),
    },
    reward: {
      id: typeof reward.id === 'string' ? (REWARD_ID.test(reward.id.trim()) ? reward.id.trim().toLowerCase() : '') : base.reward.id,
      diff: clamp(reward.diff, 1, 3, base.reward.diff) as Difficulty,
    },
    challenges: o.challenges === undefined ? base.challenges : sanitizeChallenges(o.challenges, base.challenges),
  }
}

/** El id de una recompensa de Twitch (un UUID). */
export const REWARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseConfig(text: string | null | undefined): Config {
  try { return sanitizeConfig(JSON.parse(text ?? '{}')) } catch { return defaultConfig() }
}

export function parseState(text: string | null | undefined): State {
  const base = initialState()
  try {
    const o = JSON.parse(text ?? '{}') as Partial<State>
    return { ...base, ...o, counts: { ...base.counts, ...o.counts }, readers: { ...base.readers, ...o.readers } }
  } catch {
    return base
  }
}

/* ---------------------------------------------------------------- cambios */

type Random = () => number
const rid = (random: Random) => Math.floor(random() * 2 ** 40).toString(36)

function shuffle<T>(list: T[], random: Random) {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

function startRound(state: State, config: Config, p: Platform, now: number, random: Random) {
  const pool = config.challenges.filter(c => c.on && !c.done && !state.done.includes(c.id))
  const options = shuffle(pool, random).slice(0, 3).map(({ id, text, diff }) => ({ id, text, diff }))
  const vote = config.mode === 'roulette' ? 0 : config.voteSec * 1000
  const round: Round = {
    id: rid(random),
    p,
    mode: config.mode,
    startedAt: now,
    options,
    voteEndsAt: now + INTRO_MS + vote,
    ballots: {},
    winner: null,
    tied: [],
    decidedAt: null,
    playStartsAt: null,
    durationMs: config.challengeMin * 60_000,
    result: null,
  }
  // Sin retos que sacar: se avisa en pantalla y la poción se vacía.
  if (!options.length) round.result = { ok: false, by: null, at: now + INTRO_MS }
  state.round = round
}

/** Cuenta los votos y elige. Con ruleta, o si nadie vota, entre todos; con empate, entre los empatados. */
function decide(round: Round, now: number, random: Random) {
  const n = round.options.length
  const tally = new Array<number>(n).fill(0)
  for (const o of Object.values(round.ballots)) if (o >= 0 && o < n) tally[o]!++
  const max = Math.max(...tally)
  const candidates = round.mode === 'roulette' || max === 0 ? tally.map((_, i) => i) : tally.flatMap((v, i) => (v === max ? [i] : []))
  round.winner = candidates[Math.floor(random() * candidates.length)]!
  round.tied = candidates.length > 1 ? candidates : []
  round.decidedAt = now
  round.playStartsAt = now + REVEAL_MS + (round.tied.length ? ROULETTE_MS : 0)
}

export function tallyOf(round: Round): number[] {
  const tally = new Array<number>(round.options.length).fill(0)
  for (const o of Object.values(round.ballots)) if (o >= 0 && o < tally.length) tally[o]!++
  return tally
}

function finishRound(state: State, config: Config, round: Round) {
  const chosen = round.winner !== null ? round.options[round.winner] : null
  if (chosen && round.result) {
    // Conseguido: queda marcado en la lista y ya no vuelve a salir.
    if (round.result.ok) { const c = config.challenges.find(x => x.id === chosen.id); if (c) c.done = true }
    state.history.unshift({ id: chosen.id, text: chosen.text, p: round.p, ok: round.result.ok, by: round.result.by, at: round.result.at })
    state.history = state.history.slice(0, HISTORY_MAX)
  }
  // La ganadora se vacía (lo que pasó de la meta se queda); las demás, según la configuración.
  // Un reto relanzado a mano no ha llenado ninguna poción: no se toca nada.
  if (!round.again) {
    state.counts[round.p] = Math.max(0, state.counts[round.p] - config.goals[round.p])
    if (!config.keepProgress) for (const p of PLATFORMS) if (p !== round.p && !state.queue.includes(p)) state.counts[p] = 0
  }
  state.round = null
}

function queueIfFull(state: State, config: Config, p: Platform) {
  if (state.counts[p] >= config.goals[p] && !state.queue.includes(p) && state.round?.p !== p) state.queue.push(p)
}

/**
 * Lo que pasa solo con el tiempo: cerrar la votación, acabar el veredicto, empezar el siguiente
 * reto de la cola, o empezar un día nuevo (pociones a cero). Devuelve si ha cambiado algo.
 */
export function advance(state: State, config: Config, now: number, random: Random = Math.random): boolean {
  let changed = false
  // Los completados de antes (lista del directo) pasan a quedar marcados en el propio reto.
  if (state.done.length) {
    for (const c of config.challenges) if (state.done.includes(c.id)) c.done = true
    state.done = []
    changed = true
  }
  // Día nuevo (a las resetHour de España): las pociones vuelven a cero y empieza la lista de «este directo».
  // Si hay un reto en marcha se espera a que acabe. La primera vez solo se apunta el día, sin borrar nada.
  const day = streamDay(now, config.resetHour)
  if (state.day !== day && !state.round) {
    if (state.day) {
      if (config.dailyReset) { state.counts = { twitch: 0, youtube: 0, kick: 0 }; state.queue = [] }
      state.history = []
    }
    state.day = day
    changed = true
  }
  for (let guard = 0; guard < 4; guard++) {
    const round = state.round
    if (round) {
      if (!round.result && round.decidedAt === null && now >= round.voteEndsAt + (round.mode === 'roulette' ? 0 : GRACE_MS)) {
        decide(round, now, random)
        changed = true
      }
      if (round.result && now >= round.result.at + RESULT_MS) {
        finishRound(state, config, round)
        for (const p of PLATFORMS) queueIfFull(state, config, p)
        changed = true
        continue
      }
      break
    }
    const next = state.queue.shift()
    if (!next) break
    startRound(state, config, next, now, random)
    changed = true
  }
  return changed
}

/** Una sub, un miembro o un regalo que ha leído el overlay (o que se ha sumado a mano). */
export function applyEvent(state: State, config: Config, ev: FeedEvent, now: number): boolean {
  if (!isPlatform(ev.p) || state.seen.includes(ev.id)) return false
  state.seen.push(ev.id)
  if (state.seen.length > SEEN_MAX) state.seen = state.seen.slice(-SEEN_MAX)
  const n = clamp(ev.n, 1, 1000, 1)
  state.counts[ev.p] += n
  state.feed.push({ id: ev.id, p: ev.p, name: str(ev.name, 40) || PLATFORM_NAME[ev.p], n, at: now, gift: !!ev.gift })
  if (state.feed.length > FEED_MAX) state.feed = state.feed.slice(-FEED_MAX)
  state.lastActivity = now
  queueIfFull(state, config, ev.p)
  return true
}

export interface BallotIn { k: string; p: Platform; o: number; at: number }

export function applyBallots(state: State, ballots: BallotIn[], now: number): boolean {
  const round = state.round
  if (!round || round.result || round.decidedAt !== null || round.mode === 'roulette') return false
  if (now < round.startedAt || now > round.voteEndsAt + GRACE_MS) return false
  let changed = false
  for (const b of ballots.slice(0, 2000)) {
    if (!isPlatform(b?.p) || typeof b.k !== 'string' || !/^[tyk]:[\w.@-]{1,64}$/.test(b.k)) continue
    if (round.mode === 'winner' && b.p !== round.p) continue
    const o = Math.round(Number(b.o))
    if (!(o >= 1 && o <= round.options.length)) continue
    if (!(b.k in round.ballots) && Object.keys(round.ballots).length >= BALLOTS_MAX) continue
    if (round.ballots[b.k] !== o - 1) { round.ballots[b.k] = o - 1; changed = true }
  }
  return changed
}

export interface CommandIn { p: Platform; name: string; ok: boolean }

/** `login` (usuario de Twitch) y `avatar` (su foto, la busca el servidor) son para el aviso del overlay. */
export interface RedemptionIn { id: string; reward: string; name: string; text: string; login?: string; avatar?: string }

/** Solo fotos del CDN de Twitch. */
export const AVATAR_URL = /^https:\/\/static-cdn\.jtvnw\.net\/[\w./%-]{1,300}$/

const ADDED_MAX = 10
const CHALLENGES_MAX = 300

/**
 * Un canje de puntos del canal de Twitch con texto. Si se está detectando la recompensa, se enlaza
 * esta. Si es la recompensa enlazada, su texto entra en la lista de retos (y el overlay lo anuncia).
 */
export function applyRedemption(state: State, config: Config, r: RedemptionIn, now: number): boolean {
  const reward = str(r?.reward, 40).toLowerCase()
  if (!REWARD_ID.test(reward) || typeof r.id !== 'string') return false
  let changed = false
  if (state.rewardLearn) {
    config.reward = { ...config.reward, id: reward }
    state.rewardLearn = false
    changed = true
  }
  if (reward !== config.reward.id) return changed
  const id = `r-${r.id.slice(0, 60)}`
  if (state.seen.includes(id)) return changed
  state.seen.push(id)
  if (state.seen.length > SEEN_MAX) state.seen = state.seen.slice(-SEEN_MAX)
  const text = str(r.text, 120).replace(/\s+/g, ' ')
  const by = str(r.name, 40) || 'Twitch'
  if (!text || config.challenges.length >= CHALLENGES_MAX) return true
  // Si ya está en la lista (mismo texto), no se repite: solo se vuelve a encender. Si ya se consiguió, no vuelve.
  const same = config.challenges.find(c => c.text.toLowerCase() === text.toLowerCase())
  if (same?.done) return true
  if (same) same.on = true
  else config.challenges.push({ id: `c${Math.floor(now).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, text, diff: config.reward.diff, on: true, by })
  const avatar = typeof r.avatar === 'string' && AVATAR_URL.test(r.avatar) ? r.avatar : undefined
  state.added.push({ id, text, by, at: now, ...(avatar ? { avatar } : {}) })
  state.added = state.added.slice(-ADDED_MAX)
  state.lastActivity = now
  return true
}

/** !completado o !fallado de un moderador: solo cuenta el primero y solo con el reto en marcha. */
export function applyCommand(state: State, config: Config, cmd: CommandIn, now: number): boolean {
  const round = state.round
  if (!round || !isPlatform(cmd.p) || !config.modCommands[cmd.p]) return false
  if (phaseOf(round, now) !== 'play') return false
  round.result = { ok: !!cmd.ok, by: `${str(cmd.name, 40)} (${PLATFORM_NAME[cmd.p]})`, at: now }
  state.lastActivity = now
  return true
}

/**
 * Los comandos de los moderadores, sin mirar mayúsculas ni tildes: !completado, !conseguido o !superado,
 * y !fallado, !fallido, !fallida o !fallo. (!hecho no: se usa en el chat para otras cosas.)
 */
export function parseCommand(text: string): boolean | null {
  const t = text.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  if (/^!(completado|conseguido|superado)\b/.test(t)) return true
  if (/^!(fallado|fallo|fallida|fallido)\b/.test(t)) return false
  return null
}

/** Un voto: solo el número (1, 2, 3), como en el bingo. */
export function parseVote(text: string, options: number): number | null {
  const match = /^\s*([1-9])(?:️?⃣)?\s*$/.exec(text)
  if (!match) return null
  const vote = Number(match[1])
  return vote <= options ? vote : null
}

export type PanelOp =
  | { type: 'add'; p: Platform; n: number; name?: string }
  | { type: 'set'; p: Platform; count: number }
  | { type: 'verdict'; ok: boolean }
  | { type: 'closeVote' }
  | { type: 'extend'; ms: number }
  | { type: 'cancel' }
  | { type: 'test'; p: Platform }
  | { type: 'newStream' }
  | { type: 'resetCounts' }
  | { type: 'learnReward'; on: boolean }
  | { type: 'relaunch'; minutes: number }

export function applyPanelOp(state: State, config: Config, op: PanelOp, name: string, now: number, random: Random = Math.random): boolean {
  const round = state.round
  switch (op?.type) {
    case 'add': {
      if (!isPlatform(op.p)) return false
      return applyEvent(state, config, { id: `m-${rid(random)}`, p: op.p, name: str(op.name, 40) || 'Panel', n: clamp(op.n, 1, 100, 1), at: now, gift: clamp(op.n, 1, 100, 1) > 1 }, now)
    }
    case 'set': {
      if (!isPlatform(op.p)) return false
      state.counts[op.p] = clamp(op.count, 0, 99999, 0)
      queueIfFull(state, config, op.p)
      return true
    }
    case 'test': {
      if (!isPlatform(op.p)) return false
      state.counts[op.p] = Math.max(state.counts[op.p], config.goals[op.p])
      queueIfFull(state, config, op.p)
      return true
    }
    case 'verdict': {
      if (!round || round.result || round.decidedAt === null) return false
      round.result = { ok: !!op.ok, by: name, at: now }
      state.lastActivity = now
      return true
    }
    case 'closeVote': {
      if (!round || round.result || round.decidedAt !== null) return false
      round.voteEndsAt = Math.min(round.voteEndsAt, now - (round.mode === 'roulette' ? 0 : GRACE_MS))
      return true
    }
    case 'extend': {
      if (!round || round.result) return false
      round.durationMs = Math.max(60_000, round.durationMs + clamp(op.ms, -3600_000, 3600_000, 0))
      return true
    }
    case 'cancel': {
      if (!round) return false
      if (!round.again) state.counts[round.p] = Math.max(0, state.counts[round.p] - config.goals[round.p])
      state.round = null
      return true
    }
    case 'relaunch': {
      // El último reto jugado, otra vez y con los minutos que se digan: se salta la celebración y la votación.
      const last = state.history[0]
      if (round || !last) return false
      const diff = config.challenges.find(c => c.id === last.id)?.diff ?? 2
      state.round = {
        id: rid(random),
        p: last.p,
        mode: 'roulette',
        startedAt: now - INTRO_MS,
        options: [{ id: last.id, text: last.text, diff }],
        voteEndsAt: now,
        ballots: {},
        winner: 0,
        tied: [],
        decidedAt: now,
        playStartsAt: now + REVEAL_MS,
        durationMs: clamp(op.minutes, 1, 120, config.challengeMin) * 60_000,
        result: null,
        again: true,
      }
      state.lastActivity = now
      return true
    }
    case 'newStream': {
      state.history = []
      state.lastActivity = now
      return true
    }
    case 'learnReward': {
      state.rewardLearn = !!op.on
      return true
    }
    case 'resetCounts': {
      state.counts = { twitch: 0, youtube: 0, kick: 0 }
      state.queue = []
      return true
    }
    default:
      return false
  }
}

export function applyReaders(state: State, raw: unknown, now: number): boolean {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const st = (v: unknown): ReaderStatus => (v === 'connecting' || v === 'ok' || v === 'error' ? v : 'off')
  state.readers = { twitch: st(o.twitch), youtube: st(o.youtube), kick: st(o.kick), note: str(o.note, 200), at: now }
  return true
}

/* ---------------------------------------------------------------- lo que se envía */

/** El reto sin los votos de cada persona: solo cuántos tiene cada opción. */
export type RoundView = Omit<Round, 'ballots'> & { tally: number[]; voters: number }
export type StateView = Omit<State, 'round' | 'seen'> & { round: RoundView | null }

export function viewOf(state: State): StateView {
  const { seen: _seen, round, ...rest } = state
  if (!round) return { ...rest, round: null }
  const { ballots, ...r } = round
  return { ...rest, round: { ...r, tally: tallyOf(round), voters: Object.keys(ballots).length } }
}

/** La parte de la configuración que necesita el overlay (sin la lista entera de retos). */
export type OverlayConfig = Omit<Config, 'challenges'>
export function overlayConfig(config: Config): OverlayConfig {
  const { challenges: _c, ...rest } = config
  return rest
}
