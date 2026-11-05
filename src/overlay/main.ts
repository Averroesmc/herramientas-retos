/**
 * El overlay de OBS: retos.averroeshosting.com/o/<clave>. Fuente de navegador de 1920×1080.
 * Con ?preview=1 (la vista previa del panel) no lee los chats ni suena.
 */
import './overlay.css'
import { overlayState, type Snapshot } from './api'
import { ChatReader } from './chat'
import { View } from './view'

const key = location.pathname.split('/o/')[1]?.split('/')[0] ?? new URLSearchParams(location.search).get('key') ?? ''
const preview = new URLSearchParams(location.search).has('preview')
if (preview) document.body.classList.add('preview')

const stage = document.getElementById('stage')!
const fit = () => { stage.style.transform = `scale(${window.innerWidth / 1920})` }
addEventListener('resize', fit)
fit()

const view = new View(stage, preview)
let snap: Snapshot | null = null
let skew = 0

const apply = (next: Snapshot) => {
  if (snap && next.version < snap.version) return
  skew = next.now - Date.now()
  snap = next
  view.update(next, skew)
  reader?.update(next, skew)
}

const reader = preview ? null : new ChatReader(key, apply)
reader?.start()

async function poll() {
  try {
    const next = await overlayState(key, snap?.version ?? -1)
    if (next) apply(next)
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      stage.innerHTML = '<p style="font:32px sans-serif;color:#fff;background:#000c;padding:24px;margin:40px;display:inline-block">Este enlace del overlay ya no vale: cópialo otra vez desde el panel de retos.</p>'
      return
    }
  }
  setTimeout(poll, 1000)
}
void poll()
