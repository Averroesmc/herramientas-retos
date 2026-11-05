import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, FlaskConical } from 'lucide-react'
import { Avatar } from '@/components/arc/avatar/avatar'
import Toast from '@/components/arc/toast/toast'
import { ThemeToggle } from '@/components/theme-toggle'
import { BattlePanel, HistoryPanel, ObsPanel, RoundPanel } from '@/components/live'
import { ChallengesPanel, SettingsPanel } from '@/components/settings'
import { ApiError, fetchPanel, HOME, saveConfig, sendOps, type PanelData } from '@/lib/api'
import type { Config, PanelOp } from '../shared/logic'

type Notice = { key: number; title: string; description?: string }

export default function App() {
  const [data, setData] = useState<PanelData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const versionRef = useRef(-1)
  const [skew, setSkew] = useState(0)

  const notify = useCallback((title: string, description?: string) => setNotice({ key: Date.now(), title, description }), [])
  const accept = useCallback((next: PanelData) => {
    if (next.version < versionRef.current) return
    versionRef.current = next.version
    setSkew(next.now - Date.now())
    setData(next)
  }, [])

  // Cada 2 s se mira cómo va (subs, reto en marcha, chats), también lo que cambia el overlay.
  useEffect(() => {
    let stop = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        accept(await fetchPanel())
        setError(null)
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404)) { setError(e.message); return }
      }
      if (!stop) timer = setTimeout(tick, 2000)
    }
    void tick()
    return () => { stop = true; clearTimeout(timer) }
  }, [accept])

  const ops = useCallback(async (...list: PanelOp[]) => {
    try { accept(await sendOps(...list)) } catch { notify('No se pudo hacer', 'Vuelve a intentarlo') }
  }, [accept, notify])

  // La configuración se guarda sola al cambiar algo (solo lo que cambia).
  const pending = useRef<Partial<Config>>({})
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const patch = useCallback((change: Partial<Config>) => {
    setData(d => (d ? { ...d, config: { ...d.config, ...change } } : d))
    pending.current = { ...pending.current, ...change }
    clearTimeout(saveTimer.current)
    setSaving(true)
    saveTimer.current = setTimeout(async () => {
      const body = pending.current
      pending.current = {}
      try { accept(await saveConfig(body)) } catch { notify('No se ha guardado', 'Revisa la conexión y vuelve a cambiarlo') }
      setSaving(false)
    }, 500)
  }, [accept, notify])

  return (
    <div className="app">
      <header className="nav">
        <a className="brand" href={HOME} title="Volver a herramientas">
          <span className="brand__mark"><FlaskConical size={18} /></span>Retos
        </a>
        <span className="save-state">{saving ? 'Guardando…' : data ? 'Todo guardado' : ''}</span>
        <div className="nav__actions">
          <ThemeToggle />
          {data && <span className="who"><Avatar name={data.user.name} src={data.user.avatar} size="sm" /><span className="who__name">{data.user.name}</span></span>}
        </div>
      </header>

      <main className="main">
        {error ? (
          <section className="panel empty"><strong>No se puede abrir</strong>{error}<a className="back-link" href={HOME}><ArrowLeft size={16} /> Volver a herramientas</a></section>
        ) : !data ? (
          <div className="loading"><span className="spinner" /></div>
        ) : (
          <div className="view">
            {data.other && (
              <div className="other-banner">
                <Avatar name={data.owner.name} src={data.owner.avatar} size="sm" />
                <span>Estás editando los retos de <strong>{data.owner.name}</strong>. Lo que cambies aquí es su configuración y su overlay.</span>
                <a href="/">Volver a los míos</a>
              </div>
            )}
            <section className="hero hero--retos">
              <div className="hero__blobs" aria-hidden="true" />
              <div className="hero__copy">
                <span className="hero__eyebrow">Batalla de pociones</span>
                <h1 className="hero__title">Retos del chat</h1>
                <p className="hero__lead">Twitch, YouTube y Kick llenan su poción con subs y miembros. La primera en llegar a su meta gana un reto de {data.config.challengeMin} minutos.</p>
              </div>
            </section>
            <div className="columns">
              <div className="column">
                <ObsPanel data={data} accept={accept} notify={notify} />
                <RoundPanel data={data} skew={skew} ops={ops} />
                <BattlePanel data={data} ops={ops} />
                <HistoryPanel data={data} ops={ops} />
              </div>
              <div className="column">
                <SettingsPanel data={data} patch={patch} ops={ops} />
                <ChallengesPanel data={data} patch={patch} ops={ops} />
              </div>
            </div>
          </div>
        )}
      </main>

      <div className="toasts">
        {notice && <Toast key={notice.key} title={notice.title} description={notice.description} open onOpenChange={open => { if (!open) setNotice(null) }} duration={3200} />}
      </div>
    </div>
  )
}
