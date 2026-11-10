/**
 * Lo que se ve en OBS. Todo sale del estado del servidor: las pociones (o el banner de corazones)
 * se llenan con las subs, al completar una meta la poción vuela al centro, sale la votación del
 * reto, el resultado y el temporizador. Los sprites (la poción de 16×16 y el corazón de 9×8) son
 * dibujos propios hechos con código.
 */
import { sfx, setSound } from './sfx'
import type { Snapshot } from './api'
import {
  DIFFICULTY_NAME, INTRO_MS, PLATFORMS, PLATFORM_NAME, phaseOf,
  type Platform, type RoundView,
} from '../../shared/logic'

const COLORS: Record<Platform, { c: string; l: string; d: string }> = {
  twitch: { c: '#a970ff', l: '#d9c2ff', d: '#5b23b8' },
  youtube: { c: '#ff4040', l: '#ffa3a3', d: '#a51515' },
  kick: { c: '#53fc18', l: '#c3ff9e', d: '#1f9a00' },
}
const UNIT: Record<Platform, string> = { twitch: 'subs', youtube: 'miembros', kick: 'subs' }
const NAME = (p: Platform) => PLATFORM_NAME[p].toUpperCase()
/** Pociones: tras este tiempo sin subs se esconden detrás de la cámara. */
const SLEEP_MS = 60_000

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const restart = (el: Element, cls: string) => { el.classList.remove(cls); void (el as HTMLElement).offsetWidth; el.classList.add(cls) }

/* ---------------------------------------------------------------- poción 16×16 */

// K/k corcho · O/o cristal (claro/sombra) · I interior · H brillo
const MAP = [
  '......KKKK......',
  '......KKKk......',
  '.....OOOOOo.....',
  '......OIIo......',
  '......OIIo......',
  '.....OIIIIo.....',
  '....OIIIIIIo....',
  '...OIIIIIIIIo...',
  '..OIHIIIIIIIIo..',
  '..OIHIIIIIIIIo..',
  '..OIIIIIIIIIIo..',
  '..OIIIIIIIIIIo..',
  '..OIIIIIIIIIIo..',
  '...oIIIIIIIIo...',
  '....oooooooo....',
  '................',
]
const GW = 16
const GH = 16
const at = (x: number, y: number) => MAP[y]?.[x] ?? '.'
const isIn = (x: number, y: number) => { const c = at(x | 0, y | 0); return c === 'I' || c === 'H' }
const INSIDE: [number, number][] = []
const BOTTOM: number[] = []
const rowCount = new Array<number>(GH).fill(0)
for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (isIn(x, y)) { INSIDE.push([x, y]); rowCount[y]!++; if (y >= 12) BOTTOM.push(x) }
const TOTAL = INSIDE.length

/** De fracción de volumen a altura de la superficie (el frasco es redondo). */
function surfaceFor(f: number) {
  if (f <= 0) return GH
  if (f >= 1) return 0
  const need = f * TOTAL
  let acc = 0
  for (let y = GH - 1; y >= 0; y--) {
    const n = rowCount[y]!
    if (!n) continue
    if (acc + n >= need) return y + 1 - (need - acc) / n
    acc += n
  }
  return 0
}

type RGB = [number, number, number]
const hex = (h: string): RGB => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as RGB
const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => Math.round(v + (b[i]! - v) * t)) as RGB
const rgb = (a: RGB, al = 1) => `rgba(${a[0]},${a[1]},${a[2]},${al})`

class Potion {
  readonly el: HTMLDivElement
  readonly cv: HTMLCanvasElement
  readonly row: HTMLDivElement
  readonly hrow: HTMLDivElement
  hearts: HTMLCanvasElement[] = []
  hstate: number[] = []
  private readonly ctx: CanvasRenderingContext2D
  private readonly C: RGB
  private readonly L: RGB
  private readonly D: RGB
  target = 0
  shown = 0
  full = false
  corkGone = false
  excite = 0
  /** Hasta esta hora (performance.now) el líquido no sube: se espera a que caiga la gota. */
  holdUntil = 0
  private slosh = 0
  private bubbles: { x: number; y: number; vy: number }[] = []
  private drops: { x: number; y: number; vy: number; dead?: boolean }[] = []
  private splash: { x: number; y: number; vx: number; vy: number; life: number }[] = []

  readonly p: Platform

  constructor(p: Platform, slot: number) {
    this.p = p
    const col = COLORS[p]
    this.C = hex(col.c); this.L = hex(col.l); this.D = hex(col.d)
    this.el = document.createElement('div')
    this.el.className = 'potion'
    this.el.dataset.slot = String(slot)
    this.el.style.setProperty('--c', col.c)
    this.el.innerHTML = `<canvas width="${GW}" height="${GH}"></canvas>`
    this.cv = $(this.el, 'canvas')
    this.ctx = this.cv.getContext('2d')!
    this.row = document.createElement('div')
    this.row.className = 'brow outline'
    this.row.style.setProperty('--c', col.c)
    this.row.innerHTML = `<span class="bn">${NAME(p)}</span><span class="bb slot"><i></i></span><span class="bc"><span class="cn">0</span><small>/<span class="gl">0</span></small></span>`
    this.hrow = document.createElement('div')
    this.hrow.className = 'hrow outline'
    this.hrow.style.setProperty('--c', col.c)
    this.hrow.innerHTML = `<span class="hn">${NAME(p)}</span><div class="hearts"></div><span class="hc"><span class="cn">0</span><small>/<span class="gl">0</span></small></span>`
  }

  /** Una gota que cae dentro por cada sub (como mucho 10 seguidas). */
  drop(n: number) {
    for (let i = 0; i < Math.min(n, 10); i++) {
      setTimeout(() => {
        this.drops.push({ x: 7 + Math.floor(Math.random() * 2), y: 2.5, vy: 0 })
        restart(this.cv, 'bump')
      }, i * 170)
    }
  }

  popup(html: string, host: HTMLElement) {
    const d = document.createElement('div')
    d.className = 'pop outline'
    d.innerHTML = html
    host.appendChild(d)
    setTimeout(() => d.remove(), 1900)
  }

  step(t: number) {
    if (performance.now() >= this.holdUntil) this.shown += (this.target - this.shown) * 0.05
    if (Math.abs(this.target - this.shown) < 0.001) this.shown = this.target
    this.slosh *= 0.96
    this.excite *= 0.97
    const surf = surfaceFor(this.shown)
    const amp = 0.2 + this.slosh + (this.full ? 0.45 : 0) + this.excite * 0.8
    const wave = (x: number) => Math.sin(t * 4 + x * 0.9) * amp + Math.sin(t * 2.3 - x * 0.5) * amp * 0.5
    for (const d of this.drops) {
      d.vy += 0.03
      d.y += d.vy
      if (d.y >= surf + wave(d.x) - 0.5 || d.y > 12.5) {
        d.dead = true
        this.slosh = Math.min(1.4, this.slosh + 0.8)
        for (let i = 0; i < 3; i++) this.splash.push({ x: d.x, y: Math.min(d.y, 12), vx: (Math.random() - 0.5) * 0.35, vy: -0.25 - Math.random() * 0.2, life: 16 })
      }
    }
    this.drops = this.drops.filter(d => !d.dead)
    for (const s of this.splash) { s.x += s.vx; s.y += s.vy; s.vy += 0.03; s.life-- }
    this.splash = this.splash.filter(s => s.life > 0)
    const rate = (this.shown > 0.02 ? 0.05 + this.shown * 0.12 : 0) + (this.full ? 0.3 : 0) + this.excite * 0.5
    if (Math.random() < rate) this.bubbles.push({ x: BOTTOM[Math.floor(Math.random() * BOTTOM.length)]!, y: 13, vy: 0.05 + Math.random() * 0.08 })
    for (const b of this.bubbles) b.y -= b.vy
    this.bubbles = this.bubbles.filter(b => b.y > surf + wave(b.x) + 0.5 && isIn(b.x, b.y))
    this.draw(t, surf, wave)
  }

  private draw(t: number, surf: number, wave: (x: number) => number) {
    const c = this.ctx
    c.clearRect(0, 0, GW, GH)
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const ch = at(x, y)
      if (ch === '.') continue
      if (ch === 'K' || ch === 'k') {
        if (this.corkGone) continue
        c.fillStyle = y === 0 ? '#d98b55' : ch === 'k' ? '#7c4527' : '#b56d3e'
        c.fillRect(x, y, 1, 1)
        continue
      }
      if (ch === 'O') { c.fillStyle = '#e3f0ff'; c.fillRect(x, y, 1, 1); continue }
      if (ch === 'o') { c.fillStyle = '#8fb0dc'; c.fillRect(x, y, 1, 1); continue }
      const s = surf + wave(x)
      if (this.shown > 0.004 && y + 0.5 >= s) {
        let col = this.C
        if (y < s + 1) col = this.L
        else if (y >= 12) col = mix(this.C, this.D, 0.45)
        else if (x >= 11) col = mix(this.C, this.D, 0.25)
        if (this.full) col = mix(col, [255, 255, 255], 0.07 + 0.06 * Math.sin(t * 5 + y * 0.8))
        c.fillStyle = rgb(col)
      } else c.fillStyle = 'rgba(14,16,30,.6)'
      c.fillRect(x, y, 1, 1)
      if (ch === 'H') { c.fillStyle = 'rgba(255,255,255,.7)'; c.fillRect(x, y, 1, 1) }
    }
    for (const b of this.bubbles) { c.fillStyle = rgb(this.L, 0.95); c.fillRect(b.x | 0, b.y | 0, 1, 1) }
    for (const d of this.drops) { c.fillStyle = rgb(this.L); c.fillRect(d.x, d.y | 0, 1, 1) }
    for (const s of this.splash) if (isIn(s.x, s.y)) { c.fillStyle = rgb(this.L, s.life / 16); c.fillRect(s.x | 0, s.y | 0, 1, 1) }
  }
}

/* ---------------------------------------------------------------- corazón 9×8 */

// O contorno · F relleno · H brillo · S sombra
const HEART = ['.OOO.OOO.', 'OFHFOFFFO', 'OHFFFFFFO', 'OFFFFFFSO', '.OFFFFSO.', '..OFFSO..', '...OSO...', '....O....']
function drawHeart(cv: HTMLCanvasElement, state: number, p: Platform) {
  const c = cv.getContext('2d')!
  c.clearRect(0, 0, 9, 8)
  const on: Record<string, string> = { F: COLORS[p].c, H: COLORS[p].l, S: COLORS[p].d }
  const off: Record<string, string> = { F: '#3b3b45', H: '#55555f', S: '#2c2c34' }
  for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) {
    const ch = HEART[y]![x]!
    if (ch === '.') continue
    c.fillStyle = ch === 'O' ? '#140c10' : (state === 2 || (state === 1 && x <= 4) ? on : off)[ch]!
    c.fillRect(x, y, 1, 1)
  }
}

function burst(host: HTMLElement, cols: string[], n: number, spread = 2.6, dist = 170) {
  for (let i = 0; i < n; i++) {
    const s = document.createElement('div')
    s.className = 'spark'
    const a = -Math.PI / 2 + (Math.random() - 0.5) * spread
    const r = 60 + Math.random() * dist
    s.style.cssText += `;--s:${[8, 10, 14][i % 3]}px;--col:${cols[i % cols.length]};--dx:${Math.cos(a) * r}px;--dy:${Math.sin(a) * r}px;--d:${0.8 + Math.random()}s`
    host.appendChild(s)
    setTimeout(() => s.remove(), 2000)
  }
}

/* ---------------------------------------------------------------- escena */

const STAGE = `
  <div id="potionsWrap"><div id="potions"></div><div id="board"></div></div>
  <div id="rays"></div>
  <div id="hero"><canvas width="16" height="16"></canvas></div>
  <div id="heroFx"></div>
  <div id="heroTitle"><div class="big outline" id="htBig"></div><div class="small outline" id="htSmall"></div></div>
  <div id="banner" class="slab"><div id="bnTitle" class="sh"></div><div id="bnRows"></div><div id="bnFx"></div></div>
  <div id="card" class="slab">
    <div class="full-wrap">
      <div class="kicker sh" id="ck"></div>
      <h2 class="sh" id="ct"></h2>
      <p class="hint sh" id="ch"></p>
      <div id="opts"></div>
    </div>
    <div class="mini-wrap">
      <div class="mini-top"><span class="kicker sh" id="mk"></span><span class="timer sh" id="mt">15:00</span></div>
      <div class="mini-text sh" id="mx"></div>
      <div class="tbar slot"><i id="mb"></i></div>
    </div>
    <div class="verdict sh" id="verdict"></div>
  </div>
  <div id="toast"><div class="toast-icon"><canvas id="toastPic" width="24" height="24"></canvas></div>
    <div class="toast-body"><div class="toast-title">¡Nuevo reto!</div><div class="toast-text" id="toastText"></div><div class="toast-by" id="toastBy"></div></div><div id="toastFx"></div></div>
  <div id="flash"></div>`

type Flags = { late: boolean; intro: boolean; busy: boolean; card: boolean; reveal: boolean; mini: boolean; result: boolean; timeUp: boolean; lastSec: number; lastVoteSec: number }
const freshFlags = (late: boolean): Flags => ({ late, intro: false, busy: false, card: false, reveal: false, mini: false, result: false, timeUp: false, lastSec: -1, lastVoteSec: -1 })

export class View {
  private snap: Snapshot | null = null
  private skew = 0
  private readonly potions = {} as Record<Platform, Potion>
  private order: Platform[] = [...PLATFORMS]
  private readonly seenFeed = new Set<string>()
  private readonly seenAdded = new Set<string>()
  private readonly toasts: { text: string; by: string; avatar?: string }[] = []
  private toasting = false
  private first = true
  private roundId: string | null = null
  private flags = freshFlags(true)
  private heroP: Potion | null = null
  private bannerTimer: ReturnType<typeof setTimeout> | undefined
  /** La última vez (hora del servidor) que pasó algo con las pociones: una sub, una poción que sube o un reto. */
  private wakeAt = 0
  private lastCounts: Record<Platform, number> | null = null
  /** Hora local en la que las pociones empezaron a salir de detrás de la cámara. */
  private wokeAt = 0
  private readonly heroCtx: CanvasRenderingContext2D

  private readonly stage: HTMLElement
  private readonly preview: boolean

  constructor(stage: HTMLElement, preview: boolean) {
    this.stage = stage
    this.preview = preview
    stage.innerHTML = STAGE
    PLATFORMS.forEach((p, i) => {
      const potion = new Potion(p, i)
      this.potions[p] = potion
      $(stage, '#potions').appendChild(potion.el)
      $(stage, '#board').appendChild(potion.row)
      $(stage, '#bnRows').appendChild(potion.hrow)
    })
    this.heroCtx = $<HTMLCanvasElement>(stage, '#hero canvas').getContext('2d')!
    const loop = (ts: number) => {
      const t = ts / 1000
      for (const p of PLATFORMS) this.potions[p].step(t)
      if (this.heroP) { this.heroCtx.clearRect(0, 0, GW, GH); this.heroCtx.drawImage(this.heroP.cv, 0, 0) }
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    setInterval(() => this.tick(), 100)
  }

  private now() { return Date.now() + this.skew }
  private get banner() { return this.snap?.config.style === 'banner' }

  update(snap: Snapshot, skew: number) {
    this.snap = snap
    this.skew = skew
    const { config, state } = snap
    setSound(config.sound && !this.preview, config.volume)
    this.stage.style.setProperty('--cx', `${config.camera.x}px`)
    this.stage.style.setProperty('--cy', `${config.camera.y}px`)
    this.stage.style.setProperty('--cw', `${config.camera.w}px`)
    this.stage.dataset.font = config.font
    $(this.stage, '#potionsWrap').classList.toggle('hidden', this.banner)
    if (!this.banner) $(this.stage, '#banner').classList.remove('on')

    // La poción del reto en marcha se ve llena (menos si es un reto relanzado a mano: esa no se ha llenado).
    const active = state.round && !state.round.again && !(state.round.result && this.now() > state.round.result.at + 3000) ? state.round.p : null
    for (const p of PLATFORMS) {
      const potion = this.potions[p]
      const on = config.enabled[p]
      const goal = config.goals[p]
      const full = state.queue.includes(p) || active === p
      const count = Math.min(state.counts[p], goal)
      potion.el.classList.toggle('hidden', !on)
      potion.row.classList.toggle('hidden', !on)
      potion.hrow.classList.toggle('hidden', !on)
      potion.target = full ? 1 : count / goal
      if (potion.full && !full) potion.corkGone = false
      potion.full = full
      potion.el.classList.toggle('full', full)
      potion.el.classList.toggle('near', !full && count / goal >= 0.8)
      const waiting = state.queue.includes(p) && !!state.round
      potion.row.classList.toggle('waiting', waiting)
      potion.hrow.classList.toggle('waiting', waiting)
      for (const row of [potion.row, potion.hrow]) {
        $(row, '.cn').textContent = String(full ? goal : count)
        $(row, '.gl').textContent = String(goal)
      }
      $(potion.row, '.bb i').style.width = `${(full ? 1 : count / goal) * 100}%`
      this.renderHearts(potion, full ? 1 : count / goal, goal)
    }

    // Pociones: delante (hueco 0) la de la sub más reciente; detrás, las demás. Al abrir el overlay,
    // por la hora de su última sub. Cada sub nueva la trae al frente (más abajo).
    const visible = PLATFORMS.filter(p => config.enabled[p])
    this.order = [...this.order.filter(p => visible.includes(p)), ...visible.filter(p => !this.order.includes(p))]
    if (this.first) {
      const last = (p: Platform) => Math.max(0, ...state.feed.filter(e => e.p === p).map(e => e.at))
      this.order.sort((a, b) => last(b) - last(a))
    }
    // La tabla de al lado: arriba la que va más llena. En empate se queda como estaba.
    const board = [...this.order].sort((a, b) => this.potions[b].target - this.potions[a].target)
    board.forEach((p, i) => {
      this.potions[p].row.style.setProperty('--o', String(i))
      this.potions[p].row.classList.toggle('first', i === 0 && this.potions[p].target > 0)
    })

    // Si estaban escondidas detrás de la cámara, tardan un poco más en estar arriba.
    const wasAsleep = $(this.stage, '#potionsWrap').classList.contains('asleep')
    // Despiertan las pociones: la última sub (también las de antes de abrir el overlay), una poción
    // que sube (los botones del panel) o un reto nuevo.
    for (const ev of state.feed) if (config.enabled[ev.p]) this.wakeAt = Math.max(this.wakeAt, ev.at)
    if (this.lastCounts && PLATFORMS.some(p => config.enabled[p] && state.counts[p] > this.lastCounts![p])) this.wakeAt = this.now()
    this.lastCounts = { ...state.counts }
    if (state.round) this.wakeAt = Math.max(this.wakeAt, state.round.startedAt)

    // Las subs nuevas: gota, nombre y sonido (las que ya estaban al abrir el overlay, no).
    for (const ev of state.feed) {
      if (this.seenFeed.has(ev.id)) continue
      this.seenFeed.add(ev.id)
      if (this.first || this.now() - ev.at > 20_000 || !config.enabled[ev.p]) continue
      const potion = this.potions[ev.p]
      const html = ev.n > 1 || ev.gift ? `+${ev.n} <b>regalo</b> de ${esc(ev.name)}` : `+1 <b>${esc(ev.name)}</b>`
      if (this.banner) {
        potion.popup(html, potion.hrow)
        for (const p of PLATFORMS) this.potions[p].hrow.classList.toggle('hot', p === ev.p)
        this.showBanner(4500)
        if (config.subSound) sfx.drop()
      } else {
        // La poción de la sub se pone delante y, cuando ha llegado (y ha salido de detrás de la cámara), le cae la gota.
        const moving = this.order[0] !== ev.p
        this.order = [ev.p, ...this.order.filter(p => p !== ev.p)]
        const delay = (moving ? 450 : 0) + (wasAsleep ? 550 : 0)
        potion.holdUntil = performance.now() + delay + 350
        setTimeout(() => {
          potion.popup(html, potion.el)
          potion.drop(ev.n)
          if (config.subSound) sfx.drop()
        }, delay)
      }
    }
    this.order.forEach((p, i) => { this.potions[p].el.dataset.slot = String(i) })
    // Retos nuevos por puntos del canal: se anuncian uno detrás de otro.
    for (const a of state.added ?? []) {
      if (this.seenAdded.has(a.id)) continue
      this.seenAdded.add(a.id)
      if (this.first || this.now() - a.at > 30_000) continue
      this.toasts.push({ text: a.text, by: a.by, ...(a.avatar ? { avatar: a.avatar } : {}) })
    }
    void this.nextToast()

    this.first = false
    this.tick()
  }

  /** La foto de quien lo pide, pixelada a 24×24 (o su inicial si no hay foto). */
  private async drawAvatar(name: string, url?: string) {
    const cv = $<HTMLCanvasElement>(this.stage, '#toastPic')
    const c = cv.getContext('2d')!
    c.imageSmoothingEnabled = true
    c.clearRect(0, 0, 24, 24)
    const img = url ? await new Promise<HTMLImageElement | null>(resolve => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => resolve(null)
      setTimeout(() => resolve(null), 2500)
      i.src = url
    }) : null
    if (img) { c.drawImage(img, 0, 0, 24, 24); return }
    let hash = 0
    for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
    c.fillStyle = ['#7a5af8', '#e0761e', '#1f9d6b', '#d92b6b', '#2e7de0', '#c2410c'][hash % 6]!
    c.fillRect(0, 0, 24, 24)
    c.fillStyle = '#fff'
    c.font = `bold 16px ${getComputedStyle(this.stage).fontFamily}`
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillText((name[0] ?? '?').toUpperCase(), 12, 13)
  }

  private async nextToast() {
    if (this.toasting) return
    const next = this.toasts.shift()
    if (!next) return
    this.toasting = true
    const toast = $(this.stage, '#toast')
    toast.style.setProperty('--c', COLORS.twitch.c)
    // El reto va en una línea del ancho de la tarjeta; si no cabe, se desplaza despacio para leerlo entero.
    const box = $(this.stage, '#toastText')
    box.classList.remove('scroll')
    box.innerHTML = ''
    const line = document.createElement('span')
    line.textContent = next.text
    box.appendChild(line)
    $(this.stage, '#toastBy').textContent = `de ${next.by}`
    const overflow = line.scrollWidth - box.clientWidth
    let showMs = 5600
    if (overflow > 0) {
      const scrollS = Math.max(2, overflow / 90)
      box.style.setProperty('--dist', `${overflow + 8}px`)
      box.style.setProperty('--dur', `${scrollS}s`)
      box.classList.add('scroll')
      showMs = Math.max(showMs, 1400 + scrollS * 1000 + 1800)
    }
    await this.drawAvatar(next.by, next.avatar)
    toast.classList.add('on')
    sfx.banner()
    setTimeout(() => sfx.chosen(), 250)
    await wait(450)
    burst($(this.stage, '#toastFx'), [COLORS.twitch.c, COLORS.twitch.l, '#ffffff', '#ffe27a'], 26, 6.2, 140)
    await wait(showMs)
    toast.classList.remove('on')
    await wait(650)
    this.toasting = false
    void this.nextToast()
  }

  private renderHearts(potion: Potion, frac: number, goal: number) {
    const n = Math.min(goal, 10)
    const box = $(potion.hrow, '.hearts')
    if (potion.hearts.length !== n) {
      box.innerHTML = ''
      potion.hearts = []
      potion.hstate = []
      for (let i = 0; i < n; i++) {
        const cv = document.createElement('canvas')
        cv.width = 9
        cv.height = 8
        box.appendChild(cv)
        potion.hearts.push(cv)
        potion.hstate.push(-1)
      }
    }
    const units = Math.floor(frac * n * 2 + 1e-9)
    potion.hearts.forEach((cv, i) => {
      const st = units >= 2 * (i + 1) ? 2 : units >= 2 * i + 1 ? 1 : 0
      if (st === potion.hstate[i]) return
      if (potion.hstate[i]! >= 0 && st > potion.hstate[i]!) restart(cv, 'beat')
      drawHeart(cv, st, potion.p)
      potion.hstate[i] = st
    })
  }

  private showBanner(ms: number) {
    if (!this.banner) return
    const banner = $(this.stage, '#banner')
    banner.classList.toggle('low', $(this.stage, '#card').classList.contains('mini'))
    if (!banner.classList.contains('on')) sfx.banner()
    banner.classList.add('on')
    clearTimeout(this.bannerTimer)
    if (ms) this.bannerTimer = setTimeout(() => { if (!banner.classList.contains('cele')) banner.classList.remove('on') }, ms)
  }

  /* ------------------------------------------------------------ celebración de la meta */

  private async playHero(p: Platform) {
    const potion = this.potions[p]
    const stage = this.stage
    const hero = $(stage, '#hero')
    // Si estaban escondidas, primero se deja que asomen y luego vuela la poción.
    const rising = 700 - (Date.now() - this.wokeAt)
    if (rising > 0) await wait(rising)
    const k = stage.getBoundingClientRect().width / 1920
    const sr = stage.getBoundingClientRect()
    const r = potion.cv.getBoundingClientRect()
    const S = 1.15
    const x = (r.left - sr.left) / k
    const y = (r.top - sr.top) / k
    const s0 = r.width / k / 320 || 0.35
    for (const id of ['#hero', '#rays', '#heroTitle']) $(stage, id).style.setProperty('--c', COLORS[p].c)
    hero.className = ''
    hero.style.transition = 'none'
    hero.style.opacity = '1'
    hero.style.transform = `translate(${x}px,${y}px) scale(${s0})`
    hero.classList.add('on')
    this.heroP = potion
    potion.el.classList.add('away')
    sfx.whoosh()
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))
    hero.style.transition = 'transform .85s cubic-bezier(.5,0,.15,1)'
    hero.style.transform = `translate(${960 - 160 * S}px,${470 - 160 * S}px) scale(${S})`
    await wait(850)
    $(stage, '#rays').classList.add('on')
    $(stage, '#hero canvas').classList.add('shake')
    potion.excite = 1
    sfx.rise()
    await wait(850)
    $(stage, '#hero canvas').classList.remove('shake')
    potion.corkGone = true
    restart($(stage, '#flash'), 'on')
    const cork = document.createElement('div')
    cork.className = 'corkfly'
    $(stage, '#heroFx').appendChild(cork)
    setTimeout(() => cork.remove(), 1500)
    burst($(stage, '#heroFx'), [COLORS[p].c, COLORS[p].l, '#ffffff', '#ffe27a'], 90, 3.2, 420)
    sfx.pop()
    sfx.fanfare()
    $(stage, '#htBig').textContent = `¡META DE ${NAME(p)}!`
    $(stage, '#htSmall').textContent = `${this.snap?.config.goals[p] ?? ''} ${UNIT[p]} · ¡toca reto!`
    $(stage, '#heroTitle').classList.add('on')
    await wait(2600)
    $(stage, '#heroTitle').classList.remove('on')
    $(stage, '#rays').classList.remove('on')
    hero.classList.add('out')
    hero.style.transform = `translate(${960 - 160 * 0.6}px,${470 - 160 * 0.6}px) scale(.6)`
    await wait(500)
    hero.className = ''
    this.heroP = null
    potion.el.classList.remove('away')
  }

  private async playBannerWin(p: Platform) {
    const potion = this.potions[p]
    const banner = $(this.stage, '#banner')
    banner.style.setProperty('--c', COLORS[p].c)
    $(this.stage, '#bnTitle').textContent = `¡META DE ${NAME(p)} COMPLETADA!`
    for (const q of PLATFORMS) this.potions[q].hrow.classList.remove('hot')
    this.showBanner(0)
    banner.classList.add('cele')
    potion.hrow.classList.add('win')
    sfx.rise()
    await wait(800)
    potion.hearts.forEach((cv, i) => setTimeout(() => { restart(cv, 'beat'); sfx.tick() }, i * 70))
    await wait(potion.hearts.length * 70 + 150)
    restart($(this.stage, '#flash'), 'on')
    burst($(this.stage, '#bnFx'), [COLORS[p].c, COLORS[p].l, '#ffffff', '#ffe27a'], 80, 6.2, 380)
    sfx.pop()
    sfx.fanfare()
    await wait(2600)
    banner.classList.remove('on')
    await wait(550)
    banner.classList.remove('cele')
    potion.hrow.classList.remove('win')
  }

  /* ------------------------------------------------------------ el reto */

  private hideCard() {
    const card = $(this.stage, '#card')
    card.className = 'slab'
    $(this.stage, '#verdict').className = 'verdict sh'
  }

  private showCard(r: RoundView) {
    const stage = this.stage
    const card = $(stage, '#card')
    const col = COLORS[r.p].c
    card.style.setProperty('--c', col)
    $(stage, '#ck').textContent = r.again ? `RETO · ${NAME(r.p)}` : `¡GANA ${NAME(r.p)}!`
    const mins = Math.round(r.durationMs / 60_000)
    if (r.again) {
      $(stage, '#ct').textContent = '¡Otra vez este reto!'
      $(stage, '#ch').textContent = `${mins} ${mins === 1 ? 'minuto' : 'minutos'} para conseguirlo`
      $(stage, '#opts').innerHTML = r.options.map(o => `<div class="opt slot"><div class="bar"></div><span class="n">!</span>
        <span class="t sh">${esc(o.text)}</span><span class="diff d${o.diff}">${DIFFICULTY_NAME[o.diff]}</span><span class="c sh"></span></div>`).join('')
    } else if (!r.options.length) {
      $(stage, '#ct').textContent = '¡No quedan retos!'
      $(stage, '#ch').textContent = 'Añade más retos en el panel'
      $(stage, '#opts').innerHTML = ''
    } else {
      $(stage, '#ct').textContent = r.mode === 'roulette' ? 'La ruleta elige el reto…' : r.mode === 'all' ? 'Todos los chats eligen el reto' : `El chat de ${PLATFORM_NAME[r.p]} elige el reto`
      $(stage, '#ch').innerHTML = r.mode === 'roulette' ? `${mins} minutos para conseguirlo` : `Escribe <b>1</b> <b>2</b> o <b>3</b> en el chat · <span id="vt"></span>`
      $(stage, '#opts').innerHTML = r.options.map((o, i) => `<div class="opt slot"><div class="bar"></div><span class="n">${i + 1}</span>
        <span class="t sh">${esc(o.text)}</span><span class="diff d${o.diff}">${DIFFICULTY_NAME[o.diff]}</span><span class="c sh">${r.mode === 'roulette' ? '' : '0'}</span></div>`).join('')
    }
    card.className = 'slab'
    $(stage, '#verdict').className = 'verdict sh'
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('show')))
  }

  private updateVote(r: RoundView, now: number) {
    const rows = [...this.stage.querySelectorAll<HTMLElement>('.opt')]
    const total = r.tally.reduce((a, b) => a + b, 0)
    rows.forEach((el, i) => {
      if (r.mode === 'roulette') return
      $(el, '.c').textContent = String(r.tally[i] ?? 0)
      $(el, '.bar').style.width = total ? `calc(${((r.tally[i] ?? 0) / total) * 100}% - 8px)` : '0'
    })
    const left = Math.max(0, Math.ceil((r.voteEndsAt - now) / 1000))
    const vt = this.stage.querySelector('#vt')
    if (vt) vt.textContent = `${left} s`
    if (left !== this.flags.lastVoteSec) {
      if (left > 0 && left <= 3 && this.flags.lastVoteSec !== -1) sfx.tick()
      this.flags.lastVoteSec = left
    }
  }

  private async reveal(r: RoundView, animate: boolean) {
    const rows = [...this.stage.querySelectorAll<HTMLElement>('.opt')]
    const win = r.winner ?? 0
    if (animate && r.tied.length > 1) {
      $(this.stage, '#ch').textContent = r.mode === 'roulette' ? '¡Gira la ruleta!' : '¡Empate! Decide la ruleta…'
      const idx = r.tied
      let steps = idx.length * 5 + idx.indexOf(win)
      let i = 0
      let delay = 70
      while (steps-- > 0) {
        rows.forEach(row => row.classList.remove('spin'))
        rows[idx[i % idx.length]!]?.classList.add('spin')
        sfx.tick()
        await wait(delay)
        i++
        delay *= 1.09
      }
      rows.forEach(row => row.classList.remove('spin'))
    }
    rows.forEach((el, j) => el.classList.add(j === win ? 'win' : 'lose'))
    if (!r.again) $(this.stage, '#ch').textContent = '¡Reto elegido!'
    if (animate) sfx.chosen()
  }

  private goMini(r: RoundView) {
    const chosen = r.options[r.winner ?? 0]
    $(this.stage, '#mk').textContent = `RETO · ${NAME(r.p)}`
    $(this.stage, '#mx').textContent = chosen?.text ?? ''
    $(this.stage, '#card').classList.add('mini')
    $(this.stage, '#banner').classList.add('low')
  }

  private updateTimer(r: RoundView, now: number) {
    const end = (r.playStartsAt ?? now) + r.durationMs
    const ref = r.result ? Math.min(r.result.at, end) : now
    const ms = Math.max(0, end - ref)
    const secs = Math.ceil(ms / 1000)
    const mt = $(this.stage, '#mt')
    mt.textContent = ms <= 0 ? '¡TIEMPO!' : `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`
    mt.classList.toggle('low', secs <= 60 && !r.result)
    $(this.stage, '#mb').style.width = `${(ms / r.durationMs) * 100}%`
    if (r.result) return
    if (secs <= 10 && secs > 0 && secs !== this.flags.lastSec) sfx.tick()
    this.flags.lastSec = secs
    if (ms <= 0 && !this.flags.timeUp) { this.flags.timeUp = true; sfx.timeUp() }
  }

  private showVerdict(r: RoundView, animate: boolean) {
    const ok = !!r.result?.ok
    const v = $(this.stage, '#verdict')
    v.innerHTML = `${ok ? '¡CONSEGUIDO!' : 'FALLADO'}${r.result?.by ? `<small>Marcado por ${esc(r.result.by)}</small>` : ''}`
    v.className = `verdict sh on ${ok ? 'ok' : 'bad'}`
    if (!animate) return
    if (ok) { burst($(this.stage, '#card'), ['#5ee37a', '#bbf7d0', '#fff', '#ffe27a'], 70, 3, 260); sfx.win() } else sfx.fail()
  }

  /** Pociones: un minuto sin subs y se meten detrás de la cámara (en la vista previa del panel, no). */
  private sleepCheck(now: number) {
    const config = this.snap?.config
    const asleep = !!config?.autoHide && !this.preview && !this.heroP && now - this.wakeAt > SLEEP_MS
    const wrap = $(this.stage, '#potionsWrap')
    if (!asleep && wrap.classList.contains('asleep')) this.wokeAt = Date.now()
    wrap.classList.toggle('asleep', asleep)
  }

  /** Cada 100 ms: lleva la tarjeta del reto a la fase que toca según la hora. */
  private tick() {
    const r = this.snap?.state.round ?? null
    const now = this.now()
    this.sleepCheck(now)
    if (!r) {
      if (this.roundId) { this.hideCard(); $(this.stage, '#banner').classList.remove('low'); this.roundId = null }
      return
    }
    if (r.id !== this.roundId) {
      this.hideCard()
      this.roundId = r.id
      // Si el overlay se abre con el reto ya empezado, se salta la celebración.
      this.flags = freshFlags(now - r.startedAt > INTRO_MS - 1500)
    }
    const f = this.flags
    if (f.busy) return
    const phase = phaseOf(r, now)

    if (!f.intro) {
      f.intro = true
      if (!f.late) {
        f.busy = true
        void (this.banner ? this.playBannerWin(r.p) : this.playHero(r.p)).finally(() => { f.busy = false })
        return
      }
    }
    if (phase === 'intro') return

    if (!f.card) {
      f.card = true
      this.showCard(r)
      if (now - (r.startedAt + INTRO_MS) < 3000) sfx.vote()
    }
    if (!r.options.length) return
    if (phase === 'vote') { this.updateVote(r, now); return }
    this.updateVote(r, now)

    if (!f.reveal) {
      f.reveal = true
      const fresh = phase === 'reveal' && now - (r.decidedAt ?? now) < 1500
      f.busy = true
      void this.reveal(r, fresh).finally(() => { f.busy = false })
      return
    }
    if (phase === 'reveal') return

    if (r.playStartsAt !== null) {
      if (!f.mini) {
        f.mini = true
        this.goMini(r)
        if (phase === 'play' && now - r.playStartsAt < 3000) sfx.start()
      }
      this.updateTimer(r, now)
    }
    if (phase === 'result' && !f.result) {
      f.result = true
      this.showVerdict(r, !!r.result && now - r.result.at < 3000)
    }
  }
}
