import { useState } from 'react'
import { Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import { Input } from '@/components/arc/input/input'
import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
import type { PanelData } from '@/lib/api'
import {
  defaultChallenges, DIFFICULTY_NAME, FONTS, FONT_NAME, PLATFORMS, PLATFORM_NAME, REWARD_ID,
  type Challenge, type Config, type Difficulty, type Font, type Mode, type PanelOp, type Platform, type Style,
} from '../../shared/logic'

type Patch = (change: Partial<Config>) => void

function Switch({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  return (
    <label className="switch-row">
      <span className="switch-row__text"><span>{label}</span>{description && <small>{description}</small>}</span>
      <button type="button" role="switch" aria-checked={checked} className="switch" onClick={() => onChange(!checked)}><span /></button>
    </label>
  )
}

/** Un número que se guarda al dejar de escribir (no a cada tecla, para no guardar «1» mientras se escribe «15»). */
function NumberField({ label, value, min, max, onCommit, description }: { label: string; value: number; min: number; max: number; onCommit: (v: number) => void; description?: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const n = Math.round(Number(draft))
    if (Number.isFinite(n) && draft.trim() !== '') onCommit(Math.min(max, Math.max(min, n)))
    setDraft(null)
  }
  return (
    <Input label={label} type="number" inputMode="numeric" min={min} max={max} description={description}
      value={draft ?? String(value)} onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
  )
}

function TextField({ label, value, onCommit, placeholder, description }: { label: string; value: string; onCommit: (v: string) => void; placeholder?: string; description?: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => { if (draft !== null && draft !== value) onCommit(draft.trim()); setDraft(null) }
  return (
    <Input label={label} value={draft ?? value} placeholder={placeholder} description={description}
      onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
  )
}

const CHANNEL_HINT: Record<Platform, { label: string; placeholder: string }> = {
  twitch: { label: 'Canal de Twitch', placeholder: 'nombre del canal' },
  youtube: { label: 'Canal de YouTube', placeholder: '@canal, enlace del canal o del directo' },
  kick: { label: 'Canal de Kick', placeholder: 'nombre del canal' },
}

export function SettingsPanel({ data, patch, ops }: { data: PanelData; patch: Patch; ops: (...o: PanelOp[]) => Promise<void> }) {
  const c = data.config
  const per = <K extends 'goals' | 'enabled' | 'channels' | 'modCommands'>(key: K, p: Platform, value: Config[K][Platform]) =>
    patch({ [key]: { ...c[key], [p]: value } } as Partial<Config>)

  return (
    <section className="panel">
      <h2 className="panel__title">Configuración</h2>

      <div className="group">
        <h3 className="group__title">Estilo del overlay</h3>
        <SegmentedControl label="Estilo del overlay" value={c.style} onValueChange={v => patch({ style: v as Style })} options={[
          { value: 'potions', label: 'Pociones' },
          { value: 'banner', label: 'Banner con corazones' },
        ]} />
        <p className="hint-text">{c.style === 'potions'
          ? 'Las tres pociones asoman por encima de la cámara, delante la de la sub más reciente. Al llenarse, la poción vuela al centro.'
          : 'El overlay queda limpio: con cada sub baja un banner arriba con corazones y vuelve a subir. Al completar una meta, el banner lo celebra.'}</p>
        {c.style === 'potions' && <Switch label="Esconder las pociones sin subs" description="Si pasa un minuto sin ninguna sub, bajan y se meten detrás de la cámara. Con la siguiente sub vuelven a salir." checked={c.autoHide} onChange={v => patch({ autoHide: v })} />}
        <h3 className="group__title">Tipografía</h3>
        <SegmentedControl label="Tipografía del overlay" value={c.font} onValueChange={v => patch({ font: v as Font })}
          options={FONTS.map(f => ({ value: f, label: FONT_NAME[f] }))} />
        <p className="hint-text">Todas pixeladas. Jersey 10 y VT323 se leen mejor en pequeño (con Pixelify Sans el 2 se confunde con el 8 y el 5 con la S).</p>
      </div>

      <div className="group">
        <h3 className="group__title">Plataformas y metas</h3>
        {PLATFORMS.map(p => (
          <div key={p} className={`platform is-${p}${c.enabled[p] ? '' : ' is-off'}`}>
            <Switch label={PLATFORM_NAME[p]} checked={c.enabled[p]} onChange={v => per('enabled', p, v)}
              description={p === 'kick' ? 'Se lee el chat público de Kick (no oficial): si Kick lo cambia puede fallar.' : undefined} />
            {c.enabled[p] && (
              <div className="fields">
                <TextField label={CHANNEL_HINT[p].label} placeholder={CHANNEL_HINT[p].placeholder} value={c.channels[p]} onCommit={v => per('channels', p, v)} />
                <NumberField label={p === 'youtube' ? 'Meta de miembros' : 'Meta de subs'} value={c.goals[p]} min={1} max={9999} onCommit={v => per('goals', p, v)} />
                {p === 'kick' && <TextField label="Número del chat de Kick (si no lo encuentra solo)" placeholder="opcional" value={c.kickChatroom} onCommit={v => patch({ kickChatroom: v.replace(/\D/g, '') })} />}
              </div>
            )}
          </div>
        ))}
        <Switch label="Contar renovaciones" description="Resubs de Twitch y Kick y aniversarios de miembro de YouTube también llenan la poción." checked={c.countRenewals} onChange={v => patch({ countRenewals: v })} />
        <Switch label="Las perdedoras conservan su progreso" description="Si no, al acabar cada reto todas las pociones vuelven a cero." checked={c.keepProgress} onChange={v => patch({ keepProgress: v })} />
        <Switch label="Pociones a cero cada día" description={`Todos los días a las ${c.resetHour}:00 (hora de España) todas las pociones vuelven a cero y empieza la lista de «Este directo». Si hay un reto en marcha, al acabarlo.`} checked={c.dailyReset} onChange={v => patch({ dailyReset: v })} />
        {c.dailyReset && (
          <div className="fields">
            <NumberField label="Hora de la vuelta a cero" description="De 0 a 23, hora de España" value={c.resetHour} min={0} max={23} onCommit={v => patch({ resetHour: v })} />
          </div>
        )}
      </div>

      <div className="group">
        <h3 className="group__title">El reto</h3>
        <SegmentedControl label="Cómo se elige el reto" value={c.mode} onValueChange={v => patch({ mode: v as Mode })} options={[
          { value: 'winner', label: 'Vota el chat ganador' },
          { value: 'all', label: 'Votan todos' },
          { value: 'roulette', label: 'Ruleta' },
        ]} />
        <div className="fields">
          <NumberField label="Minutos para el reto" value={c.challengeMin} min={1} max={120} onCommit={v => patch({ challengeMin: v })} />
          {c.mode !== 'roulette' && <NumberField label="Segundos de votación" value={c.voteSec} min={10} max={300} onCommit={v => patch({ voteSec: v })} />}
        </div>
        <p className="hint-text">Salen 3 retos al azar y el chat vota escribiendo 1, 2 o 3. Si hay empate, decide una ruleta.</p>
        <h3 className="group__title">!completado y !fallado</h3>
        <p className="hint-text">Mientras hay un reto, los moderadores y tú podéis marcarlo desde el chat. Solo cuenta el primero.</p>
        <div className="switch-grid">
          {PLATFORMS.map(p => <Switch key={p} label={`En ${PLATFORM_NAME[p]}`} checked={c.modCommands[p]} onChange={v => per('modCommands', p, v)} />)}
        </div>
      </div>

      <div className="group">
        <h3 className="group__title">Retos con puntos del canal (Twitch)</h3>
        <p className="hint-text">Quien canjee esta recompensa añade un reto a la lista, y en el overlay sale «¡Nuevo reto!». En Twitch la recompensa tiene que tener activado <b>«El espectador debe escribir texto»</b>: ese texto es el reto.</p>
        <div className="reward-row">
          <span className={`tag${c.reward.id ? ' tag--ok' : ''}`}>{c.reward.id ? 'Recompensa enlazada' : 'Sin recompensa'}</span>
          {data.state.rewardLearn
            ? <Button variant="secondary" size="sm" onClick={() => ops({ type: 'learnReward', on: false })}>Cancelar</Button>
            : <Button variant="secondary" size="sm" onClick={() => ops({ type: 'learnReward', on: true })}>{c.reward.id ? 'Cambiar recompensa' : 'Detectar recompensa'}</Button>}
          {c.reward.id && !data.state.rewardLearn && <Button variant="ghost" size="sm" onClick={() => patch({ reward: { ...c.reward, id: '' } })}>Quitar</Button>}
        </div>
        {data.state.rewardLearn && <p className="hint-text"><b>Esperando un canje…</b> Canjea la recompensa una vez en tu canal (con el overlay abierto en OBS) y quedará enlazada. Ese canje ya cuenta como reto.</p>}
        <div className="fields">
          <TextField label="ID de la recompensa (opcional)" placeholder="se rellena solo al detectarla" value={c.reward.id}
            onCommit={v => { if (!v || REWARD_ID.test(v)) patch({ reward: { ...c.reward, id: v.toLowerCase() } }) }} />
          <label className="select-field">
            <span>Dificultad de los retos que lleguen</span>
            <select className={`diff-select d${c.reward.diff}`} value={c.reward.diff} onChange={e => patch({ reward: { ...c.reward, diff: Number(e.target.value) as Difficulty } })}>
              {([1, 2, 3] as Difficulty[]).map(d => <option key={d} value={d}>{DIFFICULTY_NAME[d]}</option>)}
            </select>
          </label>
        </div>
        {!c.enabled.twitch && <p className="hint-text">Twitch está apagado arriba: actívalo y pon el canal para leer los canjes.</p>}
      </div>

      <div className="group">
        <h3 className="group__title">Sonido</h3>
        <Switch label="Sonidos" checked={c.sound} onChange={v => patch({ sound: v })} />
        {c.sound && (
          <>
            <label className="range">
              <span>Volumen <b>{c.volume}%</b></span>
              <input type="range" min={0} max={100} value={c.volume} onChange={e => patch({ volume: Number(e.target.value) })} />
            </label>
            <Switch label="Sonido con cada sub" checked={c.subSound} onChange={v => patch({ subSound: v })} />
          </>
        )}
      </div>

      {c.style === 'potions' && (
        <div className="group">
          <h3 className="group__title">Dónde está la cámara</h3>
          <p className="hint-text">En píxeles de la escena de 1920 × 1080: las pociones asoman por el borde de arriba de la cámara. Míralo en la vista previa.</p>
          <div className="fields fields--3">
            <NumberField label="Izquierda (x)" value={c.camera.x} min={-500} max={1920} onCommit={v => patch({ camera: { ...c.camera, x: v } })} />
            <NumberField label="Arriba (y)" value={c.camera.y} min={0} max={1080} onCommit={v => patch({ camera: { ...c.camera, y: v } })} />
            <NumberField label="Ancho" value={c.camera.w} min={200} max={1920} onCommit={v => patch({ camera: { ...c.camera, w: v } })} />
          </div>
        </div>
      )}
    </section>
  )
}

/** La lista de retos: se puede añadir, cambiar, apagar y borrar. */
export function ChallengesPanel({ data, patch }: { data: PanelData; patch: Patch }) {
  const list = data.config.challenges
  const [text, setText] = useState('')
  const [diff, setDiff] = useState<Difficulty>(2)
  const [confirm, setConfirm] = useState(false)
  const set = (next: Challenge[]) => patch({ challenges: next })
  const update = (id: string, change: Partial<Challenge>) => set(list.map(c => (c.id === id ? { ...c, ...change } : c)))
  const add = () => {
    const t = text.trim()
    if (!t) return
    set([...list, { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, text: t.slice(0, 120), diff, on: true }])
    setText('')
  }
  const restore = () => {
    if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 4000); return }
    setConfirm(false)
    set(defaultChallenges())
  }
  const active = list.filter(c => c.on && !c.done).length
  const doneCount = list.filter(c => c.done).length
  const [confirmBack, setConfirmBack] = useState(false)
  const allBack = () => {
    if (!confirmBack) { setConfirmBack(true); setTimeout(() => setConfirmBack(false), 4000); return }
    setConfirmBack(false)
    set(list.map(c => (c.done ? { ...c, done: false } : c)))
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Retos</h2>
        <span className="tag">{active} disponibles</span>
      </div>
      <ul className="challenges">
        {list.map(c => (
          <li key={c.id} className={`${c.on ? '' : 'is-off'}${c.done ? ' is-done' : ''}`}>
            <button type="button" role="switch" aria-checked={c.on} className="switch switch--sm" onClick={() => update(c.id, { on: !c.on })} title={c.on ? 'Puede salir' : 'Apagado: no sale'}><span /></button>
            <input className="challenge-text" defaultValue={c.text} maxLength={120} aria-label="Texto del reto"
              onBlur={e => { const v = e.target.value.trim(); if (v && v !== c.text) update(c.id, { text: v }); else e.target.value = c.text }}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
            <select className={`diff-select d${c.diff}`} value={c.diff} onChange={e => update(c.id, { diff: Number(e.target.value) as Difficulty })} aria-label="Dificultad">
              {([1, 2, 3] as Difficulty[]).map(d => <option key={d} value={d}>{DIFFICULTY_NAME[d]}</option>)}
            </select>
            {c.done && <button type="button" className="tag tag--ok tag--button" onClick={() => update(c.id, { done: false })} title="Ya se consiguió: no vuelve a salir. Pulsa para devolverlo a la lista.">Completado · devolver</button>}
            {c.by && !c.done && <span className="tag tag--by" title={`Lo pidió ${c.by} con puntos del canal`}>{c.by}</span>}
            <button type="button" className="icon-button icon-button--sm" onClick={() => set(list.filter(x => x.id !== c.id))} aria-label="Borrar reto" title="Borrar"><Trash2 size={15} /></button>
          </li>
        ))}
      </ul>
      <div className="add-challenge">
        <input className="challenge-text" value={text} placeholder="Nuevo reto…" maxLength={120} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add() }} aria-label="Nuevo reto" />
        <select className={`diff-select d${diff}`} value={diff} onChange={e => setDiff(Number(e.target.value) as Difficulty)} aria-label="Dificultad">
          {([1, 2, 3] as Difficulty[]).map(d => <option key={d} value={d}>{DIFFICULTY_NAME[d]}</option>)}
        </select>
        <Button size="sm" onClick={add} disabled={!text.trim()}><Plus size={15} /> Añadir</Button>
      </div>
      <div className="row-end">
        {doneCount > 0 && <Button variant="ghost" size="sm" onClick={allBack}>{confirmBack ? `Pulsa otra vez: vuelven ${doneCount}` : `Devolver los completados (${doneCount})`}</Button>}
        <Button variant="ghost" size="sm" onClick={restore}><RotateCcw size={15} /> {confirm ? 'Pulsa otra vez: se borra tu lista' : 'Lista por defecto'}</Button>
      </div>
    </section>
  )
}
