# Modo debug (siempre activo)

> Pedido del usuario (2026-09-30): "tenemos manera de saber el estado de todo en el código
> para que la IA debuguee, que sea por defecto como un modo debug, por si tenemos un código
> más complejo". La UI tiene que comportarse como Android Studio / VS Code: por eso todo
> está modelado con los conceptos del **Debug Adapter Protocol** (DAP).

No hay que prender nada. Cada vez que se ejecuta un proyecto, el server:

1. **Graba todo** lo que pasa (la *grabadora*): cada cambio de nivel de cada pin (de salida
   y de entrada, y quién lo causó), cada línea de la consola, los mensajes del puente, los
   cambios de estado del emulador, la compilación, los avisos eléctricos, los LEDs que se
   queman, los errores detectados y las paradas del depurador. Con tiempo (ms desde que
   arrancó la corrida), en un buffer circular de 5000 eventos (lo viejo se pisa y se cuenta).
2. **Detecta errores** en la consola y los resume: `Traceback` de MicroPython con
   archivo:línea; `Guru Meditation`, `abort()`, `assert failed`, stack overflow y watchdog
   del ESP32 con el backtrace traducido a función y línea (con el `.elf`); errores de log
   `E (…) tag:` de ESP-IDF y `[E][tag]` de ESPHome (los repetidos se agrupan).
3. **Engancha un depurador** según el motor de la placa, para leer las variables del
   firmware, evaluar expresiones, poner breakpoints y avanzar paso a paso.
4. Arma la **instantánea**: todo el estado actual en un JSON pensado para que lo lea una IA.

Código: `app/server/src/debug/` (ver "Archivos" al final).

## Qué se puede en cada motor (honesto)

| | Arduino Uno (avr8js) | ESP32 C/C++/ESPHome/Arduino-IDF (esp-emu + stub GDB) | MicroPython (esp-emu + puente) |
|---|---|---|---|
| Variables globales / `static` | Sí, con tipo (DWARF), leídas de la SRAM de avr8js **sin frenar** | Sí, con tipo (DWARF); leer **frena el chip ~0,1-0,3 s** y lo suelta | Sí: globales de `main.py` (`__main__`), leídas por el puente **sin frenar** |
| Structs, arreglos, punteros, enums, bitfields | Sí (expandibles) | Sí (expandibles; clases C++ con sus bases) | dict/list/tuple/set/objetos con `__dict__` (expandibles) |
| Variables locales | No | No | No (solo globales del módulo) |
| `evaluate` | Expresiones C de solo lectura | Expresiones C de solo lectura | Expresiones Python (sin `import`, `exec`, `open`, `sleep`, `reset`…); vencen a los 3 s |
| Registros | PC, SP, SREG, r0-r31, X/Y/Z, ciclos | Xtensa: pc, a0-a15 (ventana), ps, sar, ar0-ar63…; RISC-V: pc, x0-x31 | — |
| Registros de E/S | Sí (PORTx, DDRx, PINx, timers… como variables) | Por dirección (`/api/debug/memory`) | — |
| Breakpoints por línea | Sí (exactos) | Sí (en `main.yaml` para las lambdas de ESPHome) | No (el firmware oficial no trae `sys.settrace`) |
| Breakpoints por función | Sí, salvo `setup`/`loop` (LTO los mete en `main`: usar línea) | Sí | No |
| pause / continue | Sí (exacto) | Sí | No |
| next / stepIn / stepOut | Por línea, con breakpoints temporales | Por línea; en el CPU1 del S3 ver abajo | No |
| Pila de llamadas | **Aproximada** (escaneo de la pila buscando retornos después de CALL/RCALL/ICALL) | **Exacta** en S3 (ventanas de Xtensa, como `esp_backtrace`) para el CPU0; C3/C6 (RISC-V): PC + `ra` (aproximada) | La del último `Traceback` |
| Hilos | 1 (ATmega328P) | 1 por núcleo, con la tarea FreeRTOS que corre (`pxCurrentTCBs`) | main.py y el hilo del puente (informativo) |
| Memoria cruda | Sí (SRAM y flash) | Sí | No |

### Verificado contra los emuladores reales (2026-09-30)

- **Arduino Uno** (sketch compilado por arduino-cli, corriendo en avr8js en el worker del
  server): globales con tipo (`volatile long unsigned int contador`, `char nombre[12]`),
  registros de E/S, `evaluate`, breakpoint en `sketch.cpp:17` → `continue` avanza
  exactamente una vuelta de `loop` (`contador` +1), `next`, `pause` (el valor queda quieto),
  `stepIn`, `stepOut`, breakpoint por función (`micros`), memoria (`0x800100` = `"uno-debug"`).
- **ESP32-S3 con ESPHome** (esp-emu 0.44 con `--gdb`): lectura de memoria de una global
  (`globals__contador__pstorage`, coincide con lo que imprime el firmware), `evaluate
  contador->value_` con tipo (`GlobalsComponent<int>`), pila exacta del CPU0
  (`esp_cpu_wait_for_intr` ← `esp_vApplicationIdleHook` ← `prvIdleTask`), nombre de las
  tareas (`IDLE0`, `loopTask`), breakpoint en una línea de lambda de `main.yaml` → frena en
  el CPU1, `continue` = una ejecución más del intervalo (+1), `next` a la línea siguiente,
  `pause`, eventos por WebSocket. Tener el cliente GDB conectado no cambia la velocidad del
  emulador (medido: 40 vs 41 intervalos de 500 ms en 20 s).
- **MicroPython en ESP32-S3** (firmware oficial 1.29, esp-emu 0.44): `@DUMP` con las
  globales de `main.py` en ~0,1 s, expansión de dict/list/objetos, `evaluate` (con el
  bloqueo de `import`/`sleep`), detección del `Traceback` con archivo:línea y pila.

### Implementado pero no verificado en vivo

- **ESP-IDF C/C++ y Arduino sobre IDF**: usan exactamente el mismo camino que ESPHome
  (`.elf` + stub GDB), pero la imagen `espressif/idf` (~3 GB) no está bajada en esta PC,
  así que no se compiló ninguno. `app_main` corre en el CPU0: ahí todo es exacto.
- **ESP32-C3/C6 (RISC-V)**: orden de registros según el `target.xml` que manda el stub;
  pila aproximada (PC + `ra`, sin CFI). Sin prueba en vivo.

## Límites y detalles del ESP32 (esp-emu)

- **No hay gdb de Xtensa/RISC-V/AVR** en la PC (verificado: ni la imagen de ESPHome ni la
  de arduino-cli lo traen; la de ESP-IDF no está bajada). Por eso el tipado de variables,
  las líneas y la pila se sacan directo del `.elf` con un lector de DWARF 2-5 propio
  (`dwarf.ts`), y se habla con el stub con un cliente del protocolo GDB propio (`gdbRsp.ts`).
  Consecuencia: **no hay variables locales** (necesitan CFI y listas de ubicaciones).
- **El stub escucha en 0.0.0.0** (`--gdb` solo acepta un número de puerto) y deja leer y
  escribir la memoria del chip. Atiende un cliente a la vez: la app se conecta apenas
  arranca el emulador y **se queda conectada** mientras corre, así nadie más de la red
  puede engancharse. Para no abrirlo nunca: `EMU_DEBUG_GDB=0` al arrancar el server.
- **Al conectarse, el stub frena el chip** (y lo suelta al desconectarse). La app aprovecha:
  se conecta, lee el `.elf` con el chip frenado, pone los breakpoints guardados y recién
  ahí lo suelta — así un breakpoint en `setup()` no se pierde.
- **Dos núcleos (S3), un solo juego de registros**: el stub solo muestra el CPU0 (probado:
  `Hg`/`qfThreadInfo`/`qRcmd` no dan acceso al CPU1). ESPHome y Arduino corren `loop()` en
  el CPU1. Si el chip frena por un breakpoint y el PC del CPU0 no es ninguno, **lo tocó el
  CPU1**: la ubicación se deduce del breakpoint (exacta si había uno solo activo; si no,
  la descripción lista los candidatos), la pila muestra solo ese lugar, `next` pone un
  único breakpoint temporal en la línea siguiente (para saber exactamente dónde frenó),
  `stepOut` no se puede, y `continue` quita el breakpoint, suelta el chip 60 ms para que el
  CPU1 lo pase y lo vuelve a poner (`s` solo avanza el CPU0: verificado).
  *Sugerencia (no aplicada, toca los toolchains):* compilar la simulación con
  `CONFIG_FREERTOS_UNICORE=y` haría todo exacto en el S3, a costa de cambiar el reparto de
  tareas respecto de la placa real.
- **ESPHome**: cada `id:` del YAML es un puntero `const` que el compilador reemplazó (no
  tiene dirección en DWARF); el objeto vive en `<dominio>__<id>__pstorage`. El depurador lo
  reconstruye: `contador` se ve como el objeto (`{value_ = 1001}`) y `contador->value_` o
  `contador.value_` dan el valor. `esphome::App` (en DWARF `app_storage`) se ve como
  `esphome::Application`. Las lambdas compilan con `#line N "main.sim.yaml"`: los
  breakpoints se piden en **`main.yaml`** y se traducen con el mapa de líneas de la
  compilación; las paradas se muestran de vuelta en `main.yaml`.

## Arduino Uno (avr8js)

- El control de depuración vive junto a la CPU, en el worker (`avrControl.ts`): lee la SRAM
  y los registros entre tramo y tramo de simulación, sin frenar nada.
- Breakpoints: `AvrSimulador.ejecutar` compara el PC en cada instrucción **solo si hay
  breakpoints** (sin breakpoints el bucle es el de siempre, costo cero).
- Mientras está pausado, el tiempo simulado no avanza (el LED no cambia, el Serial no imprime).
- arduino-cli compila con LTO: `setup()` y `loop()` quedan dentro de `main()`. Los
  breakpoints por línea en `sketch.cpp` andan; por nombre `setup`/`loop`, no (el mensaje
  lo explica). Variables globales que el programa nunca lee pueden desaparecer (LTO).

## MicroPython

El puente en Python (`simbridge.py`, generado por `templates/micropythonBridge.ts`) suma dos
mensajes al protocolo de la sección 7.1 de la guía:

| App → firmware | Firmware → app |
|---|---|
| `@DUMP <id>` | `@VARS <id> <i>/<n> <trozo>` × n |
| `@EVAL <id> <expresión en base64>` | `@VARS <id> <i>/<n> <trozo>` × n |

La respuesta es un JSON en base64 partido en trozos de 180 caracteres (las líneas del puente
son de menos de 256 bytes). `@DUMP` devuelve `vars` (`[nombre, tipo, repr, largo, expandible]`,
hasta 60, `repr` recortado a 120), `funcs`, `mem_free`, `mem_alloc`, `ticks_ms`, las entradas
que maneja la app y los pines vigilados. `@EVAL` devuelve `{tipo, repr, len, hijos}` o
`{error}`. Corre en el hilo del puente: no frena `main.py`, pero si `main.py` no suelta el
intérprete (bucle sin `sleep`), el pedido vence a los 3-5 s y se avisa.

## API REST (`/api/debug/...`)

Todas validan con Zod; un error de uso vuelve `400 {error}` con el motivo.

| Método y ruta | Qué hace | Respuesta |
|---|---|---|
| `GET /api/debug/state` | Capacidades, estado, breakpoints | `{capabilities, state, breakpoints, corrida}` |
| `GET /api/debug/snapshot?variables=true&serial=40` | Instantánea completa | ver abajo |
| `GET /api/debug/trace?since=<seq>&types=pin,serial&limit=500` | Eventos de la grabadora | `{eventos, ultimoSeq, perdidos, seHuboSaltos, corrida}` |
| `GET /api/debug/threads` | Hilos | `{threads: Thread[]}` |
| `GET /api/debug/stack?threadId=1` | Pila | `{stackFrames: StackFrame[], totalFrames}` |
| `GET /api/debug/scopes?frameId=0` | Ámbitos | `{scopes: Scope[]}` |
| `GET /api/debug/variables?ref=N&start=&count=` | Hijos de un `variablesReference` | `{variables: Variable[]}` |
| `POST /api/debug/evaluate` `{expression, frameId?}` | Evaluar | `{result, type?, variablesReference, memoryReference?}` |
| `GET /api/debug/breakpoints` | Breakpoints actuales | `{breakpoints: Breakpoint[]}` |
| `PUT /api/debug/breakpoints` `{project?, source?, lines?, functions?}` | Como `setBreakpoints` (reemplaza los de ese archivo) / `setFunctionBreakpoints` (reemplaza todos los de función) de DAP. Se guardan por proyecto y se aplican en cada ejecución | `{breakpoints: Breakpoint[]}` |
| `POST /api/debug/control` `{action, waitMs?}` | `pause` \| `continue` \| `next` \| `stepIn` \| `stepOut`; con `waitMs` espera a que vuelva a frenar | `{state: EstadoEjecucion}` |
| `GET /api/debug/memory?address=0x3fc9daf0&length=16` | Memoria cruda (hasta 4096) | `{address, length, hex, ascii}` |

`GET /api/emulator` y los eventos `emu.state` traen además `status.paused` (true mientras el
depurador tiene el programa frenado).

### Formas (DAP, campos en inglés para mapear 1:1 en la UI)

```ts
Capabilities { motor: 'avr8js'|'esp-gdb'|'micropython'|'ninguno', variables, evaluate, pause,
  lineBreakpoints, functionBreakpoints, step: boolean, stackTrace: 'exacto'|'aproximado'|'no',
  registros, memoria: boolean, notas: string[] }
EstadoEjecucion { status: 'running'|'stopped'|'unavailable', reason?: 'pause'|'breakpoint'|'step'|'exception'|'entry',
  threadId?, description?, pc?: '0x…', function?, source?: {name, path}, line?, hitBreakpointIds?: number[] }
Thread { id, name }
StackFrame { id, name, source?: {name, path}, line, column, instructionPointerReference?: '0x…', aproximado?: true }
Scope { name, presentationHint?: 'globals'|'registers'|…, variablesReference, expensive }
Variable { name, value, type?, variablesReference (>0 = expandible), indexedVariables?, evaluateName?, memoryReference? }
Breakpoint { id, verified, source?, line?, function?, instructionReference?: string[], message? }
EventoTraza { seq, t (ms), tipo: 'pin'|'serial'|'puente'|'estado'|'compilacion'|'electrico'|'led'|'error'|'debug'|'app', …datos }
```

Datos por tipo de evento: `pin {pin, nivel, direccion: 'salida'|'entrada', origen: 'firmware'|'ui'|'mcp'}`,
`serial {linea}`, `puente {direccion: 'fw→app'|'app→fw', linea}`, `estado {estado, salida?}`,
`compilacion {ok, durationMs, errores}`, `electrico {severidad, pin, mensaje}`, `led {id, estado, mA}`,
`error {tipoError, mensaje, lineas, marcos?, pc?, backtrace?}`, `debug {evento: 'detenido'|'continuado'|'breakpoints'|'aviso'|'error', …}`,
`app {mensaje}`.

### Instantánea (`GET /api/debug/snapshot`)

```jsonc
{
  "generado": "2026-09-30T03:41:22.139Z", "tiempoCorridaMs": 6835,
  "proyecto": { "nombre", "placa", "lenguaje", "motor", "firmware", "elf" },
  "emulador": { "estado", "corriendo", "pausadoPorDepurador", "pid", "uptimeMs", "ip", "salida" },
  "depuracion": { "motor", "capacidades", "estado", "breakpoints", "pila"? /* si está frenado */ },
  "pines": { "13": { "nombre": "D13", "salida": 1, "entrada": null, "modulos": ["led1.IN", "r1.1"], "cambios": 3, "ultimoCambioMs": 1096 } },
  "circuito": { "placa", "modulos": [{ "id", "tipo", "nombre", "rol", "props", "pines": [{ "pin", "tipo", "conectadoA", "gpio", "nombreGpio" }], "encendido"? , "nivelEntrada"? }], "cables" },
  "electrico": { "ramas": [{ "desde", "hasta", "tensionFuenteV", "resistenciaSerieOhm", "resistenciaFuenteOhm", "caidaLedV", "corrienteMa", "componentes" }], "leds", "avisos" },
  "consola": [{ "t", "linea" }],
  "errores": [{ "tipo", "t", "mensaje", "lineas", "marcos"?, "pc"?, "backtrace"? }],
  "compilacion": { "proyecto", "t", "ok", "durationMs", "errores" },
  "variables": { "globales": { "contador": "321  (volatile long unsigned int)" }, "cpu"? /* AVR */, "interprete"? /* MicroPython */ },
  "traza": { "eventosTotales", "enMemoria", "ultimoSeq" }
}
```

La Ley de Ohm de la instantánea usa los niveles **reales** de la simulación (una salida que el
firmware nunca reportó cuenta como 0, no como el "peor caso" del chequeo previo a ejecutar).
Después de parar el emulador la instantánea y la traza siguen mostrando la última corrida
(sirve para ver por qué se cayó).

## WebSocket (`/ws`)

| `type` | Contenido |
|---|---|
| `debug.stopped` | `EstadoEjecucion` (reason, description, pc, function, source, line, hitBreakpointIds, threadId) |
| `debug.continued` | `{threadId, allThreadsContinued}` |
| `debug.trace` | `{eventos: EventoTraza[], ultimoSeq}` — lo nuevo de la grabadora, cada ~250 ms, hasta 300 |
| `debug.exception` | `{error}` — se detectó un Traceback / Guru Meditation / abort / assert / watchdog |
| `emu.state` | como siempre, con `status.paused` |

## MCP (para agentes de IA)

| Herramienta | Uso |
|---|---|
| `debug_snapshot` | **Empezar por acá.** Todo el estado en un JSON (`variables: false` para no tocar el firmware). |
| `debug_trace` | Qué pasó y cuándo; seguir con `desde = ultimoSeq`. Filtrar por `tipos`. |
| `debug_variables` | Ámbitos y variables; `ref` para expandir. |
| `debug_evaluate` | Una expresión (C o Python según el lenguaje). |
| `debug_set_breakpoints` | `archivo` + `lineas`, o `funciones`. Quedan para las próximas ejecuciones. |
| `debug_control` | `pause`/`continue`/`next`/`stepIn`/`stepOut`, esperando a que frene (`esperar_ms`). |
| `debug_stack` | La pila de llamadas. |

Cómo depura un agente, típicamente:

1. `ejecutar` → `debug_snapshot`: ¿hay `errores`? (el Traceback/pánico ya viene con
   archivo:línea); ¿los `pines` y `electrico` son los esperados?; ¿las `variables` tienen
   valores razonables?
2. Provocar el caso (`accionar_modulo`, `poner_pin`) y mirar `debug_trace` con
   `tipos: ["pin","serial","error"]` para ver la secuencia y los tiempos.
3. Si hace falta ver el código por dentro: `debug_set_breakpoints` en la línea sospechosa,
   provocar el caso, `debug_control continue` (espera a que frene) → `debug_variables` /
   `debug_evaluate` → `debug_control next` las veces necesarias.
4. Corregir con `escribir_archivo` y volver a ejecutar (los breakpoints se mantienen).

## Archivos

- `app/server/src/debug/`
  - `grabadora.ts` — buffer circular de eventos + estado de pines/consola/errores.
  - `errores.ts` — detector de Traceback, pánicos y errores de log.
  - `depurador.ts` — orquesta todo; ganchos `al*` que llama `index.ts`; instantánea; traducción `main.yaml` ↔ `main.sim.yaml`.
  - `tipos.ts` — tipos DAP, interfaz `AdaptadorDepuracion`, registro de `variablesReference`.
  - `elf.ts` — lector de ELF32 (secciones, símbolos, desarmado C++ simple).
  - `dwarf.ts` — lector de DWARF 2-5 (globales, tipos, funciones, tabla de líneas).
  - `valoresC.ts` — formato de valores C y evaluador de expresiones.
  - `simbolos.ts` — caché del `.elf` + DWARF por compilación (se indexa al terminar de compilar).
  - `adaptadorC.ts` — base común AVR/ESP (globales, evaluate, breakpoints, next/step por línea).
  - `adaptadorAvr.ts` + `avrControl.ts` — Arduino Uno (lado server + lado worker).
  - `gdbRsp.ts` + `adaptadorEsp.ts` — cliente del protocolo GDB y depurador ESP32.
  - `adaptadorMicropython.ts` — `@DUMP`/`@EVAL` por el puente.
  - `rutas.ts`, `mcpDepuracion.ts` — API REST y herramientas MCP.
- Ganchos chicos en: `index.ts`, `mcp.ts`, `emulator.ts` (`--gdb`), `avrEmulator.ts`,
  `avrWorker.ts`, `avrSim.ts` (breakpoints por PC), `bridgeClient.ts` (líneas crudas),
  `templates/micropythonBridge.ts` (`@DUMP`/`@EVAL`), `shared/src/protocol.ts` (eventos `debug.*`, `status.paused`).
- Pruebas: `server/src/debug/*.test.ts` con fixtures en `server/src/fixtures/depuracion/`
  (`uno-debug.*` compilado por arduino-cli; `dw5-xtensa.elf` compilado con el GCC 14 de
  ESP-IDF con `-gdwarf-5`).

## Pendiente

- Variables locales y pila exacta en RISC-V/AVR (hace falta leer CFI `.debug_frame` y listas de ubicaciones).
- Registros del CPU1 del S3 (depende de esp-emu) o simular en un núcleo (`CONFIG_FREERTOS_UNICORE`).
- Watchpoints (`Z2`, "frenar cuando cambie esta variable"): no implementados ni probados contra el stub de esp-emu; en avr8js se podrían hacer con los hooks de escritura de memoria.
- Hablar DAP por cable (para enchufar VS Code directo): las formas ya son las de DAP.
