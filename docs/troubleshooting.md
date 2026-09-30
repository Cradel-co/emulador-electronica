# Troubleshooting — cuando no arranca

Errores que cuestan tiempo porque el síntoma no dice dónde está la causa. Todos
vienen de instalar en una máquina nueva y por lo tanto quedan fuera de la
prueba del proyecto.

La regla general: **si la UI falla pero la API responde, el problema es del
frontend**. Comprobación rápida:

```bash
curl -s http://127.0.0.1:5180/api/health   # si responde JSON, el server está bien
```

---

## La UI queda en blanco y no deja crear proyectos

**Síntoma.** Se abre la app y no carga nada: sin lista de proyectos, sin poder
crear ninguno. El server responde 200 y `curl` a la API anda perfecto, así que
todo parece sano. En la consola del navegador:

```
Uncaught TypeError: crypto.randomUUID is not a function
```

**Causa.** `app/web/app.js` generaba el id de pestaña con
`crypto.randomUUID()`, que **solo existe en contextos seguros** (HTTPS o
`localhost`). Servir la app por `http://192.168.1.50:5180` o por la IP de una
tailnet no es un contexto seguro: la llamada tira `TypeError` en la línea 8 y
el módulo entero muere al cargar.

**Por qué es confuso.** El server está sano y responde. La API responde. El
error está en una línea que no se parece a nada de lo que estabas buscando, y el
síntoma visible ("no me deja crear proyectos") no apunta al frontend.

**Arreglo.** El código ya trae un fallback (`?? \`c-${Date.now()...}\``), así que
si ves esto es que tenés una versión anterior. Actualizá el archivo.

---

## La app no abre desde la LAN o desde la tailnet

**Síntoma.** `curl http://127.0.0.1:5180/` responde 200, pero desde otra
máquina de la red todo da **403 Forbidden**, incluida la raíz.

**Causa.** El server escucha solo en `127.0.0.1` (por diseño, sección 13 de la
guía) y además valida `Origin`/`Host` contra una allowlist fija para
desprotegerlo de DNS rebinding. Con `HOST` fijo en el fuente no había forma de
cambiar ninguna de las dos cosas.

**Arreglo.** Levantar con las dos variables de entorno:

```bash
HOST=0.0.0.0 \
EMU_ALLOWED_HOSTS=192.168.1.50:5180,emulador.tail.midominio.com:5180 \
npm run dev
```

`EMU_ALLOWED_HOSTS` es una lista separada a propósito: cuando `HOST` es
`0.0.0.0` no hay un host concreto de escucha contra el cual validar, así que
tenés que decir explícitamente qué hosts son tuyos. El default sigue siendo
`127.0.0.1` y nunca `0.0.0.0`.

> **HTTP vs HTTPS**: si exponés esto por la LAN, todo el tráfico (incluidos los
> comandos MCP) va en claro. En una tailnet el tráfico ya va cifrado por Tailscale
> —no necesitás HTTPS— pero no lo expongas fuera de ella.

---

## "no se pudo conectar al REPL en 15 s" (proyectos ESP32)

**Síntoma.** El proyecto Arduino compila bien. Al arrancar un proyecto de
ESP32:

```
Subiendo el código por el REPL…
[error] no se pudo subir el código: no se pudo conectar al REPL en 15 s
```

**Causa.** `esp-emu` no está instalado o no está en el `PATH` del proceso del
server. El error menciona el REPL, pero el motor de emulación nunca arrancó.

**Comprobar.**

```bash
which esp-emu        # si no imprime nada, no está
esp-emu --version
```

**Arreglo.**

```bash
curl -fsSL https://raw.githubusercontent.com/espressif/esp-emulator/main/install.sh | sh
```

Queda en `~/.local/bin/esp-emu`. Si el server ya estaba corriendo, **reinicialo**
para que herede el `PATH`: si lo levantaste con `npx` desde otra terminal sin
`~/.local/bin`, el proceso no lo ve aunque ahora exista.

> `wokwi-cli` es opcional y va en `~/bin/wokwi-cli` (otra ruta). Si no lo tenés,
> no pasa nada mientras uses el camino de `esp-emu`.

---

## ESPHome se cuelga en el bootloader (solo ESP32-S3)

**Síntoma.** El firmware ESPHome nunca termina de bootear. Último renglón del
log y nada más:

```
entry 0x403c89xx
```

**Causa.** ESPHome manda la consola del S3 por **USB-Serial-JTAG** por defecto, y
`esp-emu` se cuelga para siempre esperando ese puerto.

**Arreglo.** En el YAML:

```yaml
logger:
  hardware_uart: UART0
```

Con eso bootea completo en segundos. En la placa real no cambia nada
importante: los logs salen por el puerto USB marcado "UART" en vez del "USB".

---

## Un proyecto del repo no aparece en la lista

**Síntoma.** Una carpeta existe en `projects/` pero no figura en el selector de
proyectos. Si la abrís a mano por la URL: **500 Internal Server Error**, con
algo como:

```json
{"error":"ENOENT: no such file or directory, open '.../projects/lab-fase0/project.json'"}
```

**Causa.** El listado solo lee carpetas que tienen `project.json`. `lab-fase0`
está commiteada en el repo con un solo `main.yaml` (y su `.gitignore`) — sin el
`project.json`, no es un proyecto válido para la app.

**Arreglo.** Crear el `project.json` a partir del de un proyecto que sí funcione,
con `name`, `board`, `language`, `modules` y `wires` — o renombrar la carpeta
para que quede claro que es material de trabajo, no un proyecto.

---

## "Chequeo circuito ↔ código: 3 aviso(s) (no bloquea)"

**Síntoma.** Aparece antes de compilar y no deja avanzar.

Esto **no es un error**: es el chequeo que compara el diagrama con el código y
avisa de pines declarados que el firmware no usa, o al revés. Dice explícitamente
*no bloquea*. Para verlos todos, abrí la pestaña que los lista.
