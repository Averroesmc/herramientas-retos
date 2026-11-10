import { useEffect, useRef, useState } from 'react'
import { Check, Copy, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import { newKey, overlayUrl, type PanelData } from '@/lib/api'
import { DIFFICULTY_NAME, PLATFORMS, PLATFORM_NAME, phaseOf, type PanelOp, type Platform, type ReaderStatus } from '../../shared/logic'

type Ops = (...ops: PanelOp[]) => Promise<void>

const STATUS_TEXT: Record<ReaderStatus, string> = { off: 'apagado', connecting: 'conectando…', ok: 'leyendo', error: 'con problemas' }
const dotClass = (s: ReaderStatus) => (s === 'ok' ? 'is-live' : s === 'connecting' ? 'is-connecting' : s === 'error' ? 'is-error' : '')

const ago = (ms: number) => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `hace ${s} s`
  if (s < 3600) return `hace ${Math.round(s / 60)} min`
  return `hace ${Math.round(s / 3600)} h`
}

/** El enlace para OBS, la vista previa y cómo va cada chat. */
export function ObsPanel({ data, accept, notify }: { data: PanelData; accept: (d: PanelData) => void; notify: (t: string, d?: string) => void }) {
  const [copied, setCopied] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const url = overlayUrl(data.key)
  const readers = data.state.readers
  const fresh = !!readers.at && data.now - readers.at < 90_000
  const frame = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.3)
  useEffect(() => {
    const el = frame.current
    if (!el) return
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 1920))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const copy = async () => {
    await navigator.clipboard.writeText(url).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  const regenerate = async () => {
    if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 4000); return }
    setConfirm(false)
    try { accept(await newKey()); notify('Enlace nuevo', 'Pega el enlace nuevo en OBS: el anterior ya no funciona') } catch { notify('No se pudo cambiar el enlace') }
  }

  return (
    <section className="panel">
      <h2 className="panel__title">Overlay para OBS</h2>
      <div className="preview" ref={frame}>
        <iframe title="Vista previa del overlay" src={`/o/${data.key}?preview=1`} style={{ transform: `scale(${scale})` }} />
      </div>
      <div className="link-row">
        <code className="link" title={url}>{url}</code>
        <Button variant="secondary" size="sm" onClick={copy}>{copied ? <><Check size={15} /> Copiado</> : <><Copy size={15} /> Copiar</>}</Button>
      </div>
      <p className="hint-text">En OBS: <b>Fuente de navegador</b> de 1920 × 1080 con este enlace. Activa «Controlar audio mediante OBS» para oír los sonidos. No lo compartas: con él se puede ver y tocar el overlay.</p>
      <div className="chats">
        {PLATFORMS.map(p => {
          const on = data.config.enabled[p] && !!data.config.channels[p].trim()
          const status: ReaderStatus = !on ? 'off' : fresh ? readers[p] : 'off'
          return (
            <span key={p} className={`chat-chip is-${p}`} title={on ? '' : 'Apagado o sin canal en la configuración'}>
              <span className={`status-dot ${dotClass(status)}`} />{PLATFORM_NAME[p]} <small>{on ? (fresh ? STATUS_TEXT[status] : 'overlay cerrado') : 'apagado'}</small>
            </span>
          )
        })}
      </div>
      {fresh && readers.note && <p className="hint-text">{readers.note}</p>}
      {!fresh && <p className="hint-text">Los chats los lee el overlay: abre el enlace en OBS para que empiece a contar. {readers.at ? `Última señal ${ago(data.now - readers.at)}.` : ''}</p>}
      {!data.youtubeKey && data.config.enabled.youtube && <p className="hint-text">YouTube se lee sin clave de la API (método de reserva).</p>}
      <div className="row-end">
        <Button variant="ghost" size="sm" onClick={regenerate}><RefreshCw size={15} /> {confirm ? 'Pulsa otra vez para cambiarlo' : 'Cambiar enlace'}</Button>
      </div>
    </section>
  )
}

/** Cada poción: cuánto lleva, y botones para probar o corregir a mano. */
export function BattlePanel({ data, ops }: { data: PanelData; ops: Ops }) {
  const { config, state } = data
  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Batalla</h2>
        <Button variant="ghost" size="sm" onClick={() => ops({ type: 'resetCounts' })}>Poner a cero</Button>
      </div>
      <div className="battle">
        {PLATFORMS.filter(p => config.enabled[p]).map(p => {
          const goal = config.goals[p]
          const count = state.counts[p]
          const queued = state.queue.includes(p)
          const playing = state.round?.p === p
          return (
            <div key={p} className={`battle-row is-${p}`}>
              <div className="battle-row__top">
                <strong>{PLATFORM_NAME[p]}</strong>
                <span className="battle-row__count">{Math.min(count, goal)} / {goal}{count > goal ? <small> (+{count - goal})</small> : null}</span>
                {playing && <span className="tag">Con reto</span>}
                {queued && <span className="tag">En cola</span>}
              </div>
              <div className="meter"><i style={{ width: `${Math.min(1, count / goal) * 100}%` }} /></div>
              <div className="battle-row__actions">
                <Button variant="secondary" size="sm" onClick={() => ops({ type: 'set', p, count: Math.max(0, count - 1) })} aria-label={`Quitar una a ${PLATFORM_NAME[p]}`}>−1</Button>
                <Button variant="secondary" size="sm" onClick={() => ops({ type: 'add', p, n: 1, name: 'Prueba' })}>+1</Button>
                <Button variant="secondary" size="sm" onClick={() => ops({ type: 'add', p, n: 5, name: 'Prueba' })}>+5 regalo</Button>
                <Button variant="secondary" size="sm" onClick={() => ops({ type: 'test', p })} disabled={queued || playing}>Llenar (probar reto)</Button>
              </div>
            </div>
          )
        })}
        {!PLATFORMS.some(p => config.enabled[p]) && <p className="hint-text">Activa al menos una plataforma en la configuración.</p>}
      </div>
      <p className="hint-text">Los botones sirven para probar el overlay o para sumar a mano una sub que no se haya leído. Lo que se suma aquí sale en el overlay igual que una sub de verdad.</p>
    </section>
  )
}

const PHASE_TEXT = { intro: 'Celebrando la meta', vote: 'Votando el reto', reveal: 'Reto elegido', play: 'Reto en marcha', result: 'Reto terminado' }

/** El reto en marcha: votación, temporizador y los botones de conseguido o fallado. */
export function RoundPanel({ data, skew, ops }: { data: PanelData; skew: number; ops: Ops }) {
  const [, force] = useState(0)
  useEffect(() => { const t = setInterval(() => force(n => n + 1), 500); return () => clearInterval(t) }, [])
  const r = data.state.round
  const now = Date.now() + skew

  if (!r) {
    return (
      <section className="panel">
        <h2 className="panel__title">Reto en curso</h2>
        <p className="hint-text">Ningún reto en marcha. Cuando una poción llegue a su meta empezará solo: celebración, votación del chat y temporizador.</p>
        {data.state.queue.length > 0 && <p className="hint-text">En cola: {data.state.queue.map(p => PLATFORM_NAME[p]).join(', ')}</p>}
        <Relaunch data={data} ops={ops} />
      </section>
    )
  }
  const phase = phaseOf(r, now)
  const chosen = r.winner !== null ? r.options[r.winner] : null
  const end = (r.playStartsAt ?? now) + r.durationMs
  const left = Math.max(0, (r.result ? Math.min(r.result.at, end) : end) - now)
  const total = r.tally.reduce((a, b) => a + b, 0)

  return (
    <section className={`panel round is-${r.p}`}>
      <div className="panel__head">
        <h2 className="panel__title">Reto de {PLATFORM_NAME[r.p]}</h2>
        <span className="tag">{PHASE_TEXT[phase]}</span>
      </div>
      {!r.options.length && <p className="hint-text">No quedan retos activos sin completar en este directo. Añade más o pulsa «Nuevo directo».</p>}
      {(phase === 'intro' || phase === 'vote') && r.options.length > 0 && (
        <ol className="options">
          {r.options.map((o, i) => (
            <li key={o.id}>
              <span className="options__n">{i + 1}</span>
              <span className="options__text">{o.text} <small>{DIFFICULTY_NAME[o.diff]}</small></span>
              {r.mode !== 'roulette' && <span className="options__votes">{r.tally[i] ?? 0}{total ? ` · ${Math.round(((r.tally[i] ?? 0) / total) * 100)} %` : ''}</span>}
            </li>
          ))}
        </ol>
      )}
      {phase === 'vote' && r.mode !== 'roulette' && <p className="hint-text">Quedan {Math.max(0, Math.ceil((r.voteEndsAt - now) / 1000))} s de votación · {r.voters} votos {r.mode === 'winner' ? `(solo el chat de ${PLATFORM_NAME[r.p]})` : '(todos los chats)'}</p>}
      {chosen && phase !== 'vote' && (
        <div className="chosen">
          <span className="chosen__text">{chosen.text}</span>
          {r.playStartsAt !== null && <span className={`chosen__time${left < 60_000 && !r.result ? ' is-low' : ''}`}>{left <= 0 ? '¡Tiempo!' : `${String(Math.floor(left / 60_000)).padStart(2, '0')}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}`}</span>}
        </div>
      )}
      {r.result && <p className={`verdict-text ${r.result.ok ? 'is-ok' : 'is-bad'}`}>{r.result.ok ? '¡Conseguido!' : 'Fallado'}{r.result.by ? ` · marcado por ${r.result.by}` : ''}</p>}
      <div className="round__actions">
        {phase === 'vote' && <Button variant="secondary" size="sm" onClick={() => ops({ type: 'closeVote' })}>Cerrar votación ya</Button>}
        {!r.result && r.decidedAt !== null && (
          <>
            <Button size="sm" className="btn-ok" onClick={() => ops({ type: 'verdict', ok: true })}>✓ Conseguido</Button>
            <Button size="sm" variant="danger" onClick={() => ops({ type: 'verdict', ok: false })}>✗ Fallado</Button>
            <Button variant="secondary" size="sm" onClick={() => ops({ type: 'extend', ms: -60_000 })}>−1 min</Button>
            <Button variant="secondary" size="sm" onClick={() => ops({ type: 'extend', ms: 60_000 })}>+1 min</Button>
            <Button variant="secondary" size="sm" onClick={() => ops({ type: 'extend', ms: 5 * 60_000 })}>+5 min</Button>
          </>
        )}
        {!r.result && <Button variant="ghost" size="sm" onClick={() => ops({ type: 'cancel' })}>Cancelar reto</Button>}
      </div>
      {!r.result && r.decidedAt !== null && <p className="hint-text">También se puede marcar desde el chat: los moderadores (y tú) escribiendo <code>!completado</code> o <code>!fallado</code>.</p>}
    </section>
  )
}

/** Relanzar el último reto jugado, con los minutos que se quieran: sin celebración ni votación. */
function Relaunch({ data, ops }: { data: PanelData; ops: Ops }) {
  const last = data.state.history[0]
  const [minutes, setMinutes] = useState(String(data.config.challengeMin))
  if (!last) return null
  const n = Math.round(Number(minutes))
  const ok = Number.isFinite(n) && n >= 1 && n <= 120
  return (
    <div className={`relaunch is-${last.p}`}>
      <div className="relaunch__text">
        <span className="relaunch__label">Último reto · {PLATFORM_NAME[last.p]} · {last.ok ? 'conseguido' : 'fallado'}</span>
        <strong>{last.text}</strong>
      </div>
      <div className="relaunch__row">
        <label className="relaunch__minutes">
          <input type="number" inputMode="numeric" min={1} max={120} value={minutes} onChange={e => setMinutes(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && ok) void ops({ type: 'relaunch', minutes: n }) }} aria-label="Minutos" />
          <span>min</span>
        </label>
        <Button size="sm" disabled={!ok} onClick={() => ops({ type: 'relaunch', minutes: n })}><RotateCcw size={15} /> Relanzar</Button>
      </div>
      <p className="hint-text">Vuelve a salir en el overlay con el temporizador de los minutos que pongas, sin votación. No gasta ninguna poción.</p>
    </div>
  )
}

/** Lo que ha pasado en este directo, y el botón para empezar otro. */
export function HistoryPanel({ data, ops }: { data: PanelData; ops: Ops }) {
  const { history } = data.state
  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Este directo</h2>
        <Button variant="secondary" size="sm" onClick={() => ops({ type: 'newStream' })}>Nuevo directo</Button>
      </div>
      {history.length ? (
        <ul className="history">
          {history.map(h => (
            <li key={`${h.id}-${h.at}`} className={h.ok ? 'is-ok' : 'is-bad'}>
              <span className="history__mark">{h.ok ? '✓' : '✗'}</span>
              <span className="history__text">{h.text}<small>{PLATFORM_NAME[h.p as Platform]}{h.by ? ` · ${h.by}` : ''}</small></span>
            </li>
          ))}
        </ul>
      ) : <p className="hint-text">Todavía no se ha jugado ningún reto.</p>}
      <p className="hint-text">Los retos completados no vuelven a salir en el mismo directo. «Nuevo directo» los devuelve a la lista; también se hace solo tras 8 horas sin actividad.</p>
    </section>
  )
}
