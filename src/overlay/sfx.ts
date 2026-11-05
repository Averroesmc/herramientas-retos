/**
 * Sonidos de 8 bits hechos al vuelo con el sintetizador del navegador: no hay archivos de audio.
 * En OBS suenan por la fuente del navegador («Controlar audio mediante OBS» para mezclarlos).
 */

let ac: AudioContext | null = null
let volume = 0.7
let enabled = true

export function setSound(on: boolean, vol: number) {
  enabled = on
  volume = Math.max(0, Math.min(1, vol / 100))
}

function ctx() {
  ac ??= new AudioContext()
  if (ac.state === 'suspended') void ac.resume()
  return ac
}

const level = () => (enabled ? volume : 0)

function tone(freq: number, at: number, dur: number, type: OscillatorType = 'square', gain = 0.14, to?: number) {
  const v = level()
  if (!v) return
  const a = ctx()
  const t = a.currentTime + at
  const osc = a.createOscillator()
  const g = a.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(gain * v + 0.0001, t + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  osc.connect(g).connect(a.destination)
  osc.start(t)
  osc.stop(t + dur + 0.03)
}

function noise(at: number, dur: number, gain: number, f1: number, f2: number) {
  const v = level()
  if (!v) return
  const a = ctx()
  const t = a.currentTime + at
  const n = Math.floor(a.sampleRate * dur)
  const buffer = a.createBuffer(1, n, a.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1
  const src = a.createBufferSource()
  const bp = a.createBiquadFilter()
  const g = a.createGain()
  src.buffer = buffer
  bp.type = 'bandpass'
  bp.Q.value = 1.2
  bp.frequency.setValueAtTime(f1, t)
  bp.frequency.exponentialRampToValueAtTime(f2, t + dur)
  g.gain.setValueAtTime(gain * v, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(bp).connect(g).connect(a.destination)
  src.start(t)
}

/** Una nota a `s` semitonos del Do central. */
const note = (s: number) => 440 * 2 ** ((s - 9) / 12)

export const sfx = {
  drop() { tone(500, 0, 0.13, 'sine', 0.3, 1150); tone(1500, 0.07, 0.06, 'triangle', 0.1) },
  banner() { tone(note(19), 0, 0.08, 'square', 0.06); tone(note(24), 0.07, 0.12, 'square', 0.06) },
  whoosh() { noise(0, 0.8, 0.35, 250, 3500) },
  rise() { for (let i = 0; i < 10; i++) tone(note(i * 2), i * 0.075, 0.09, 'square', 0.07) },
  pop() { noise(0, 0.12, 0.6, 4000, 500); tone(260, 0, 0.12, 'square', 0.18, 900) },
  fanfare() {
    ;[0, 4, 7, 12].forEach((s, i) => tone(note(12 + s), 0.05 + i * 0.11, 0.2, 'square', 0.13))
    ;[12, 16, 19, 24].forEach(s => tone(note(12 + s), 0.55, 0.9, 'square', 0.07))
    tone(note(0), 0.55, 0.9, 'triangle', 0.25)
  },
  vote() { tone(note(19), 0, 0.12, 'square', 0.1); tone(note(24), 0.12, 0.3, 'square', 0.1) },
  chosen() { ;[0, 4, 7].forEach((s, i) => tone(note(12 + s), i * 0.08, 0.5, 'triangle', 0.18)) },
  start() { tone(note(12), 0, 0.15, 'square', 0.12); tone(note(12), 0.2, 0.15, 'square', 0.12); tone(note(24), 0.4, 0.5, 'square', 0.14) },
  tick() { tone(1200, 0, 0.05, 'square', 0.08) },
  timeUp() { tone(200, 0, 0.35, 'sawtooth', 0.14, 150); tone(200, 0.45, 0.6, 'sawtooth', 0.14, 110) },
  win() { ;[0, 4, 7, 12, 7, 12, 16, 19, 24].forEach((s, i) => tone(note(12 + s), i * 0.09, 0.18, 'square', 0.12)); tone(note(0), 0.8, 1, 'triangle', 0.25) },
  fail() { ;[7, 3, 0, -5].forEach((s, i) => tone(note(s), i * 0.22, 0.3, 'triangle', 0.22)) },
}
