# Retos

`retos.averroeshosting.com`: la **batalla de pociones**. Twitch, YouTube y Kick llenan cada uno su poción con subs y miembros. La primera que llega a su meta gana un reto: salen 3 retos al azar, el chat vota (o decide una ruleta) y el streamer tiene unos minutos para conseguirlo.

- **Panel** (`/`): con la sesión de herramientas y acceso a «retos». Desde ahí se configura todo: estilo del overlay, metas, canales, minutos del reto, votación, sonidos, posición de la cámara y la lista de retos. También tiene los botones para probar (+1, +5, llenar) y para marcar el reto como conseguido o fallado.
- **Overlay para OBS** (`/o/<clave>`): fuente de navegador de 1920 × 1080. No pide login: la clave larga hace de contraseña. Si se cambia el enlace desde el panel, el anterior deja de funcionar.
- **Admin** puede abrir la configuración de cualquier persona con `/?persona=<id de Discord>` (el botón «Editar sus retos» de la sección Personas de herramientas).

## Cómo funciona

- **Dos estilos de overlay**:
  - *Pociones*: tres pociones pixeladas que asoman por encima de la cámara, delante la que va ganando. Con cada sub cae una gota, y al llenarse la poción vuela al centro, salta el corcho y empieza el reto.
  - *Banner con corazones*: el overlay queda limpio. Con cada sub baja un banner arriba en el centro con una fila de corazones por plataforma, y vuelve a subir.
- **El reto**: salen 3 retos de la lista (los activos que no se han completado en este directo). Según la configuración vota el chat de la plataforma ganadora, votan todos los chats o decide una ruleta. Si hay empate, también decide una ruleta. Luego sale un temporizador (15 minutos por defecto).
- **Conseguido o fallado**: desde el panel, o desde el chat con `!completado` / `!fallado` (también `!conseguido` o `!fallo`). Solo cuentan los moderadores y el propio streamer, y solo el primer comando. Se puede activar o desactivar por plataforma.
- **Retos completados**: no vuelven a salir en el mismo directo. Vuelven con «Nuevo directo» o solos tras 8 horas sin actividad.
- **Qué cuenta como sub**:
  - Twitch: subs, resubs y regaladas.
  - YouTube: miembros nuevos, aniversarios y regalos de membresía.
  - Kick: subs y regaladas.
  - Las renovaciones se pueden desactivar.

Los chats los lee el propio overlay de OBS: con varias fuentes abiertas, solo lee una.

- **Twitch** se lee como invitado, sin cuenta.
- **YouTube** se lee con la API oficial si el Worker tiene `YOUTUBE_API_KEY`. Si no hay clave o se acaba la cuota, el servidor lee la web de YouTube (método de reserva, el mismo del bingo y el teatro).
- **Kick** se lee por su chat público, que no es oficial: si Kick lo cambia, puede dejar de ir. Si no encuentra el chat del canal, se puede poner su número a mano en el panel.

### Código

| Dónde | Qué |
|---|---|
| `shared/logic.ts` | Toda la lógica: estado, fases del reto, votos, comandos. La usan el servidor, el panel y el overlay. |
| `worker/index.ts` | El Worker: rutas del panel y del overlay, base de datos (tabla `retos`, se crea sola). |
| `worker/access.ts`, `worker/gate.ts` | Copiados de herramientas-web (sesión compartida). |
| `worker/youtube.ts` | Chat de YouTube sin clave (copiado del bingo). |
| `src/overlay/` | El overlay: `view.ts` (animaciones), `chat.ts` (lectura de chats), `sfx.ts` (sonidos de 8 bits). |
| `src/App.tsx`, `src/components/` | El panel, con los componentes y estilos de herramientas. |

## Publicarlo

Todo en Cloudflare, como las demás herramientas.

1. **Workers y Pages → Crear → Importar un repositorio** → este repositorio.
   - Comando de compilación: `npm run build`
   - Implementar comando: `npx wrangler deploy`
2. La base de datos D1 `herramientas` ya está en `wrangler.toml` (el mismo ID que herramientas-web).
3. **Configuración → Variables y secretos** (opcional): `YOUTUBE_API_KEY` como secreto, la misma clave del teatro y el bingo. En Google Cloud, añade `https://retos.averroeshosting.com/*` a los sitios permitidos de esa clave.
4. **Configuración → Dominios y rutas → Añadir → Dominio personalizado**: `retos.averroeshosting.com`.
5. En **herramientas** (herramientas-web) ya está la tarjeta de Retos y el permiso «retos» para dar acceso a cada persona.

## Probarlo en local

```bash
npm install
npm run dev
```

Para entrar en local hace falta una sesión en la base de datos local (`npx wrangler d1 execute herramientas --local …`), como en las demás herramientas.
