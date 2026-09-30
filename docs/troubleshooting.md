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

## ESPHome y el puerto de logs del ESP32-S3

**Esto lo resuelve la app sola.** ESPHome manda la consola del S3 por
**USB-Serial-JTAG** por defecto, y `esp-emu` se cuelga para siempre esperando ese
puerto: el firmware nunca termina de bootear y el último renglón del log es un
`entry 0x403c89xx` y nada más. El arreglo es mandar la consola por UART0.

La app ya lo aplica. Al generar el YAML de simulación fuerza
`logger.hardware_uart: UART0` en `main.sim.yaml` y crea el bloque `logger:` aunque
el proyecto no tenga ninguno (`app/server/src/yamlSim.ts`), así que **no hace falta
que toques tu `main.yaml`**. Durante la compilación puede salir este aviso, que es
informativo:

```
logger.hardware_uart era "USB_CDC"; la simulación lo fuerza a UART0 (si no, el emulador se cuelga).
```

**Cuándo sí es un problema.** Si el cuelgue aparece corriendo ESPHome **fuera de la
app** (por ejemplo `esphome run` sobre tu propio YAML), ahí sí hay que agregar a
mano:

```yaml
logger:
  hardware_uart: UART0
```

En la placa real no cambia nada importante: los logs salen por el puerto USB
marcado "UART" en vez del "USB".

---

## La compilación falla con "código 125" y ningún error del compilador

**Síntoma.** Cualquier compilación (Arduino, ESPHome o ESP-IDF) termina así,
sin un solo renglón del compilador que explique qué pasó:

```
La compilación terminó con código 125.
```

**Causa.** Cada toolchain compila dentro de un contenedor Docker de nombre fijo,
`emu-build-<proyecto>` (por ejemplo `emu-build-fsdff`). Si una compilación
anterior se canceló, se pasó de tiempo, o el server se reinició en medio, el
contenedor queda en estado `Created` (o corriendo huérfano). `docker run --rm`
solo borra el contenedor si el proceso termina solo: **no limpia uno que quedó a
medias**. En el siguiente intento ese nombre ya está tomado y Docker aborta antes
de compilar, con `Conflict. The container name ... is already in use`. El código
125 es ese aborto de Docker, no un fallo del compilador.

**Comprobar.**

```bash
docker ps -a --filter "name=emu-build"
```

Si aparece alguno en estado `Created`, o con horas de antigüedad, es esto.

**Arreglo.** Borrar el contenedor huérfano y volver a compilar:

```bash
docker rm -f emu-build-<proyecto>

# o todos de una:
docker ps -aq --filter "name=emu-build" | xargs -r docker rm -f
```

---

## ESPHome: "Permission denied" al compilar

**Síntoma.** La compilación de ESPHome se corta a los ~2 minutos, justo en
`Downloading ESP-IDF framework`, y en la UI se ve `La compilación terminó con
código 1`. El log de fondo dice:

```
mkdir: cannot create directory '/cache/platformio': Permission denied
INFO Downloading ESP-IDF 5.5.5 framework ...
ERROR Failed to download from all mirrors:
  [Errno 13] Permission denied: '/cache/idf'
```

**Causa.** El contenedor monta `ROOT/.cache` como `/cache` y corre con tu uid. En
un clone recién bajado la carpeta `.cache/` no existe, y **Docker crea la carpeta
faltante del bind-mount como `root`**. El contenedor, que corre como vos, no
puede escribir ahí, y ESP-IDF cachea justo en `/cache/idf`. Solo afecta a
ESPHome: `.build/` no sufre esto porque el server sí lo crea antes de montarlo.

**Comprobar.**

```bash
ls -ld .cache     # si el dueño dice "root root", es esto
```

**Arreglo.** Devolverle la carpeta a tu usuario y recompilar:

```bash
mkdir -p .cache && sudo chown -R "$(id -un)":"$(id -gn)" .cache
```

La primera compilación va a descargar ESP-IDF, así que tarda unos minutos; las
siguientes usan la caché.

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

## "Chequeo circuito ↔ código: N aviso(s) (no bloquea)"

**Esto no es un error.** Es el chequeo que compara el diagrama con el código y
avisa de pines declarados que el firmware no usa, o al revés. Dice
explícitamente *no bloquea* y la compilación sigue igual. Aparece mezclado en el
log de compilación, entre mensajes de Docker, y por su formato parece un fallo.

Para ver los avisos en detalle, abrí la lista que los muestra en la UI.
