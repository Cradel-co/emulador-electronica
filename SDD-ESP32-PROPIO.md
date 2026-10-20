# SDD: motor ESP32 propio con ejecución de firmware real

**Estado:** propuesta de diseño; implementación y mediciones pendientes.

**Fecha:** 20 de octubre de 2026.

**Solicitud:** sustituir `esp-emu` mediante emulación propia a nivel de código, con contratos, leyes y estrategias explícitas.

**Primer objetivo:** ESP32-C3 DevKitM-1; núcleo RISC-V y periféricos implementados en TypeScript.

**Nombre propuesto del backend:** `esp32-propio`.

**Base inspeccionada:** `53e5721`; `main` sin PR abiertos al iniciar este diseño.

Este documento planifica el reemplazo. No anuncia un motor disponible, firmware ejecutado ni
compatibilidad demostrada. Cada capacidad se habilita después de completar su evidencia.

## 1. Resultado buscado y decisiones de alcance

El producto debe ejecutar instrucciones del firmware compilado para el chip y conectar sus
periféricos con el circuito existente. La lógica de la aplicación permanece dentro del firmware:
un programa que lee un botón debe leer el registro del GPIO; el motor eléctrico determina la
tensión del pad; el controlador GPIO produce el valor y la interrupción correspondientes.

Decisiones propuestas para implementación:

1. **Núcleo propio en TypeScript.** Implementar CPU, memoria, registros y periféricos dentro del
   proyecto. QEMU y `esp-emu` serán referencias externas de contraste, no requisitos de ejecución
   del backend nuevo. Se permite estudiar especificaciones y código con licencia compatible,
   registrando procedencia y condiciones antes de incorporar código ajeno.
2. **C3 primero.** Fijar una revisión del SoC, una variante de placa, una ROM y una configuración
   de flash. C6 necesita otro perfil y revisión de ISA/periféricos. S3 necesita un núcleo Xtensa;
   una CPU RISC-V no ejecuta su firmware.
3. **Firmware real sin puente obligatorio.** La ruta final no depende de `simbridge.py`, de
   `sim_bridge` ni de sustituir llamadas de `machine`. El firmware usa los periféricos emulados.
4. **Compatibilidad progresiva y declarada.** Un ELF de laboratorio, una aplicación IDF, el
   firmware oficial MicroPython y ESPHome son hitos distintos.
5. **Retiro gradual.** `esp-emu` sigue seleccionable durante la migración. Retirarlo por completo
   requiere cubrir las placas y recorridos actualmente soportados, incluido S3 y sus funciones de
   red. Una entrega C3 sin red no alcanza para ese cierre.
6. **Primera estrategia de fidelidad:** funcional con tiempo virtual determinista. La latencia
   de cada instrucción y las características analógicas requieren modelos adicionales; no se
   publicará precisión de ciclos, consumo o radio que no haya sido validada.

No se reinterpretará el código C/Python del usuario en el host ni se inferirán sus salidas a partir
de patrones de texto. Un intérprete MicroPython podrá correr como firmware dentro del SoC emulado.

## 2. Situación actual y piezas reutilizables

| Pieza existente | Uso previsto y adaptación necesaria |
|---|---|
| `app/server/src/engines/{index,tipos}.ts` | Registrar el motor con disponibilidad acorde con el alcance real. |
| `app/server/src/emulatorBackend.ts` | Conservar el ciclo de vida y el canal de pines del producto; extender capacidades por contrato. |
| `app/server/src/emulator.ts` | Backend externo actual, versión fijada `0.44.0`; referencia de compatibilidad durante la transición. |
| `app/server/src/avrSim.ts`, `avrEmulator.ts` | Referencia local para CPU en worker, entradas nativas y adaptación de eventos; no reutilizar supuestos AVR como reglas ESP. |
| `app/server/src/bus/{busChips,proyectoChips}.ts` | Reutilizar dispositivos externos y sus estados, alimentación y persistencia. |
| `app/server/src/bus/puenteChips.ts` | Extraer conexión al dominio que sirva; el transporte UART y los shims MicroPython no son el controlador nativo. |
| `app/server/src/sim/`, observación eléctrica | Mantener un único motor del circuito y sus diagnósticos. |
| `app/server/src/buildService.ts`, `toolchains/` | Conservar compilación, caché y errores; enriquecer el manifiesto de artefactos. |
| `app/server/src/debug/` | Conservar contratos de producto y adaptar acceso a CPU/memoria cuando exista soporte. |

Bloqueos de integración comprobados en el código:

- `app/shared/src/board.ts` exige `port` y `bit` para todo `io.mode: native`. Definir el mapeo de
  pads por motor; conservar validación AVR. No agregar puertos ficticios al ESP para pasar el esquema.
- `toolchains/micropython.ts` valida y genera exclusivamente la ruta `bridge-uart`. Separar carga
  de archivos por REPL de la instrumentación de pines y buses.
- `index.ts` consulta `instanceof EmulatorManager` para recorridos de MicroPython y recarga de
  código. Introducir capacidades explícitas, sin trasladar dependencias de esa clase al motor propio.
- Eventos, estado, PWM y oyentes de chips tienen convenciones heredadas. Caracterizarlas antes de
  ampliar interfaces; mantener compatibilidad HTTP/WS y aislamiento por `boardId` y ejecución.
- El toolchain IDF fija `espressif/idf:v5.5.5` y avisa que aún falta el puente de entradas C/C++.
  El piloto nativo debe resolver ese recorrido por registros, con firmware que no use el puente.

La documentación actual del WASM de `esp-emu` anuncia entradas GPIO externas y sus interrupciones.
Es una posible referencia adicional, todavía no integrada aquí. No se generaliza la limitación
del adaptador nativo actual a todas las versiones upstream ni se toma ese WASM como motor propio.

## 3. Requisitos verificables

| ID | Requisito | Evidencia mínima |
|---|---|---|
| R01 | Ejecutar código máquina del C3 | Imagen identificada por hash, ISA declarada y trazas de ejecución. |
| R02 | Núcleo independiente del servidor | CPU y SoC funcionan sin Fastify, DOM, red ni estado global del host. |
| R03 | GPIO conectado al circuito | Botón → tensión → pad → lectura/IRQ → firmware → salida → LED. |
| R04 | Repetibilidad | Mismos artefactos, configuración y entradas temporizadas producen el mismo digest de traza observable. |
| R05 | Diagnósticos útiles | Fallo identifica ejecución, PC, instrucción/acceso, periférico y capacidad faltante. |
| R06 | Funcionalidad sin modelos ficticios | Registro no implementado, ADC sin perfil y radio ausente no devuelven éxito fabricado. |
| R07 | Instancias independientes | Dos placas/proyectos no comparten RAM, flash mutable, pads, eventos ni periféricos. |
| R08 | Ciclo de vida correcto | Stop/reset/pérdida de alimentación cancelan eventos de la generación anterior y liberan recursos. |
| R09 | Compatibilidad de firmware por versión | Manifiesto y corpus separan IDF, Arduino, MicroPython y ESPHome. |
| R10 | Migración reversible | Selección explícita de motor; volver al anterior no altera fuentes ni datos del proyecto. |
| R11 | App utilizable | Ejecución aislada con presupuestos; pausa y parada atienden aun con firmware en bucle infinito. |
| R12 | Retiro justificable | Matriz de placas y recorridos del producto cubierta antes de eliminar `esp-emu`. |

## 4. Modelo de dominio: leyes, contratos y estrategias

### 4.1 Tres niveles de descripción

- **Placa:** esquema, conectores, alimentación, módulo, flash y pines expuestos. Continúa en el
  catálogo. Los esquemas públicos describen esta conectividad.
- **SoC:** CPU, mapa de memoria, relojes, matriz GPIO, interrupciones y periféricos. Se implementa
  como plataforma; no se genera una CPU a partir del esquema de una DevKit.
- **Componentes externos:** sensores, pantallas y actuadores existentes. Se conectan al SoC a
  través de pads/buses y al circuito mediante sus modelos eléctricos.

### 4.2 Ficha obligatoria para cada bloque del SoC

Cada bloque debe declarar, antes de implementarse:

| Campo | Contenido obligatorio |
|---|---|
| Identidad | Chip/revisión, versión de modelo y referencias con capítulo, sección y revisión. |
| Estado | Registros, FIFOs, contadores y estado persistente/volátil, con valores de reset. |
| Contrato | Direcciones, tamaños de acceso, alineación, endianness, máscaras, RO/WO/RW y efectos de lectura/escritura. |
| Leyes | Invariantes y transición de estado: W1C, FIFO lleno, habilitación de reloj, IRQ pendiente, etc. |
| Conexiones | Entradas/salidas, interrupciones, buses, alimentación y dependencias de otros bloques. |
| Tiempo | Dominio de reloj, eventos, orden observable y estrategia de latencia. |
| Estrategias | Modelo funcional o temporal, precisión/limitaciones y parámetros con procedencia. |
| Diagnóstico | Situaciones no soportadas, operación inválida y límites de recursos. |
| Evidencia | Casos normales, bordes, reset, integración y comparación independiente. |

Metadatos y tablas de registros irán en datos tipados cuando alcance. Las transiciones con efectos
complejos usarán TypeScript. No crear un lenguaje de reglas universal para la ISA. Reglas y pruebas
se vinculan a la misma ficha, con expectativas revisadas de manera independiente: copiar una tabla
errónea al código y a sus tests no certifica el bloque.

### 4.3 Políticas de comportamiento

- Aplicar semántica de hardware documentada, incluidos bits reservados y escrituras ignoradas.
  Un registro implementado que devuelve cero por especificación es válido.
- Una instrucción ilegal o acceso inválido genera el trap correspondiente cuando esté modelado.
  Un acceso a un periférico aún no implementado genera además un diagnóstico de soporte y detiene
  la certificación; no se convierte silenciosamente en un periférico de ceros.
- Modo de investigación opcional: continuar con aproximaciones explícitas, registrar cada una y
  marcar la corrida no certificable. Nunca activar ese modo por omisión.
- El perfil eléctrico decide umbrales y drive; la CPU decide dirección/configuración. Ningún
  análisis estático del código reemplaza los registros del firmware en ejecución.
- Modelos ideales, parámetros medidos y límites desconocidos deben conservar su procedencia.

## 5. Arquitectura propuesta

```text
Aplicación / API / WebSocket / catálogo / toolchains
                         ↓
Adaptador esp32-propio: Emulador + capacidades explícitas
                         ↓ mensajes con generación y boardId
Worker de ejecución (TypeScript compilado)
  ├─ Máquina C3: CPU + bus de memoria + perfil + arranque
  ├─ Agenda determinista + dominios de reloj
  ├─ Controladores: GPIO/IRQ/UART/timers/flash/otros
  └─ Traza, diagnósticos y presupuestos
                         ↕ barreras temporales
Coordinación del circuito / ngspice / BusChips / entorno
```

Ubicaciones propuestas, por responsabilidad y sin mover código ajeno de paso:

```text
app/server/src/esp32/
  cpu/                 # decodificación, ejecución RISC-V y CSRs
  memoria/             # regiones, permisos, alias, MMIO y carga
  tiempo/              # agenda, dominios y barreras
  perifericos/         # modelos propios y fichas de registros
  perfiles/            # revisiones concretas C3; más chips posteriormente
  maquina.ts           # composición pura y reset
  worker.ts            # protocolo y aislamiento de ejecución
  traza.ts             # captura acotada y replay
app/server/src/engines/esp32Propio.ts
app/server/src/esp32Emulator.ts
app/tests/unit/server/esp32/
app/tests/fixtures/server/esp32/
app/tests/e2e/esp32-propio.spec.ts
```

Son destinos de implementación, todavía inexistentes. Los contratos públicos compartidos se
agregan a `app/shared` cuando sean necesarios; la UI no recibe registros internos de una librería.
El núcleo depende de interfaces de memoria, agenda y pads; no importa `index.ts` ni accede a archivos.

### 5.1 CPU RISC-V propia

Implementar por capas: RV32I, extensiones usadas por el perfil C3 (M/C y operaciones CSR/sistema
correspondientes), traps, retornos y controlador de interrupciones específico de Espressif. La
lista exacta y las particularidades se cierran con el manual de la revisión y los ELF del corpus;
no asumir que C3 implementa toda extensión de otros RISC-V ni un PLIC genérico.

Invariantes iniciales: `x0 = 0`, aritmética modular de 32 bits, cargas con extensión correcta,
comparaciones signed/unsigned, saltos y PC de 16/32 bits, excepciones precisas, división por cero y
overflow según ISA. Multiplicación de parte alta necesita conservar exactitud; JavaScript `number`
no representa todos los productos de 32 × 32 bits. Definir estrategia con enteros por partes o
`bigint` y compararla contra un oráculo independiente antes de optimizar.

Separar número de instrucciones retiradas, ciclos modelados y tiempo virtual. Un coste uniforme
de instrucción podrá servir para el perfil funcional, pero no acredita tiempo exacto del silicio.
No implementar JIT en la primera versión; optimizar después de medir y preservar trazas.

### 5.2 Memoria, imágenes y arranque

Soportar regiones RAM/ROM/flash, alias IRAM/DRAM que compartan almacenamiento según el perfil,
accesos MMIO con efectos y rangos sin mapear. Validar overflow, solapamiento y límites antes de cargar.
La flash debe tener identidad, capacidad, estado borrado y política de escritura/persistencia.

Dos rutas separadas:

1. **ELF de laboratorio:** cargar segmentos autorizados, inicializar BSS y entrar en un punto
   declarado. Sirve para desarrollar CPU/periféricos; omite la cadena real de arranque y no
   certifica una aplicación ESP-IDF ni un `.bin` comercial.
2. **Arranque compatible:** ejecutar ROM de revisión fijada, segundo bootloader, tabla de
   particiones e imagen de aplicación; modelar flash SPI, mapeo y servicios requeridos. El ELF
   opcional aporta símbolos; no reemplaza mágicamente el contenido de flash.

Antes de la segunda ruta: verificar disponibilidad, condiciones de uso/redistribución y hash de
la ROM. Si debe aportarla el usuario, integrar esa ruta y su diagnóstico. No copiar ROM desde un
binario de `esp-emu`. Un servicio ROM reimplementado requiere contrato ABI y evidencia propia;
cualquier sustitución queda identificada y limita el nivel de compatibilidad.

Extender de forma compatible el manifiesto de build con chip/revisión objetivo, tipo de imagen,
segmentos/offsets, configuración de flash, toolchain/digest, hashes y política de arranque. Rechazar
una imagen S3 en C3, imagen truncada, encabezado inválido o cifrado/firma sin estrategia soportada.
No asumir que un binario de aplicación equivale a una flash mergeada.

### 5.3 Tiempo y sincronización con el circuito

Agenda con tiempo entero y precisión declarada, orden estable por instante/fase/secuencia y
contadores sin pérdida de precisión. Dominios CPU/APB/RTC convierten sus ticks conservando residuos;
cambiar frecuencia no retrocede el reloj ni pierde eventos. La unidad y conversión se fijan en M1.

En una barrera temporal:

1. Ejecutar CPU hasta el próximo evento observable o límite de avance permitido por el circuito.
2. Publicar cambios de drive/configuración de pads con su instante, orden y generación.
3. Resolver el circuito al horizonte acordado y obtener tensiones/estados válidos.
4. Aplicar entradas, calcular IRQ y continuar CPU con el mismo orden reproducible.

Un acceso MMIO que necesita un pad actualizado o un cambio de salida adelanta la barrera. El
worker no continúa leyendo valores anteriores mientras espera el solver asíncrono. Hay que
prototipar este intercambio antes de fijar tamaño de lote: sincronizar cada instrucción con
ngspice puede ser inviable; agrupar eventos no puede ocultar pulsos que afecten al firmware.

Fijar tolerancias de muestreo por perfil. Si un pulso es más corto que la resolución validada,
declarar la limitación. Empates entre entrada externa, timer y CPU deben quedar cubiertos por
pruebas. Varias placas conectadas al mismo circuito comparten horizontes y nunca observan el
futuro de otra; el piloto puede limitarse explícitamente a una placa hasta validar ese coordinador.

Pausa congela tiempo simulado; velocidad de UI solo regula cuánto trabajo se agenda en el host.
`WFI` permite avanzar al próximo evento habilitado; espera válida no equivale a cuelgue. El reloj
de pared se usa para presupuestos del host, no para decidir un timer del firmware.

### 5.4 GPIO y leyes eléctricas

Separar latch de salida, output-enable, multiplexación, pull interno y nivel leído del pad.
Modelar push-pull/open-drain/alta impedancia y matriz IO MUX según el alcance del perfil. GPIO
no conectado no recibe un `1` inventado; aplicar pull y política documentada para nivel indefinido.

Ejemplo de ley: en open-drain, escribir alto libera el pad; un alto eléctrico requiere pull-up.
La lectura depende de tensión y umbral, y puede diferir del latch. Contención entre salidas,
sobretensión y falta de alimentación pasan por el motor eléctrico y sus diagnósticos. El MCU
no borra un cortocircuito para sostener el nivel que esperaba el programa.

Modelar registros de set/clear atómicos, habilitación de entrada, IRQ por flanco/nivel y estado
pendiente. Reinicio, EN y strapping tienen efectos del perfil; software reset y corte de energía
no retienen necesariamente las mismas memorias ni causas de reset.

### 5.5 UART, interrupciones y temporizadores

UART0 transporta consola/REPL sin interpretar logs como prueba de que booteó. Modelar FIFOs,
banderas, baudrate y eventos/IRQ necesarios. UART1 queda disponible para el firmware; no se
reserva para un puente de simulación en la nueva ruta.

Timers, SYSTIMER, watchdogs y matriz de interrupciones necesitan máscara, pendiente, prioridad,
acknowledge y reset, con referencias de la revisión. El piloto debe ejecutar un manejador real
de interrupción y volver al programa. FreeRTOS se acredita ejecutando el binario del corpus;
no se reemplaza su scheduler por callbacks del host ni se omite un watchdog para hacer pasar boot.

### 5.6 ADC, PWM y buses externos

- **ADC:** conectar el controlador SAR a tensiones del solver. Rango, atenuación, resolución,
  saturación, calibración y latencia dependen del perfil. El adaptador `machine.ADC` actual no
  acredita este controlador. Sin perfil aplicable, conservar `SIN_MODELO` y fallar la prueba.
- **LEDC/PWM:** derivar frecuencia, duty y cambios de registros. Una estrategia promediada sirve
  para cargas que la admitan; una entrada digital/IRQ o protocolo necesita flancos. Explicitar
  qué observa el firmware y qué recibe el circuito.
- **I²C/SPI:** el firmware programa el controlador MMIO; este genera transacciones hacia los
  mismos dispositivos de `BusChips`. Validar pines/matriz, alimentación, selección, orden de bits,
  ACK/NACK, frecuencia y estados de error. No conectar por ID ignorando un cable cortado.
- Una estrategia de transacciones puede empezar con límites explícitos. Bit-banging, arbitraje,
  stretching y fidelidad por flanco requieren pruebas separadas; no se declaran por reutilizar
  modelos de dispositivos. Reutilizar perfiles físicos existentes cuando correspondan.
- DMA, RMT, I²S y USB requieren sus propios modelos; una API de alto nivel adaptada no acredita
  ejecución de sus drivers físicos.

### 5.7 Red, radio y seguridad del SoC

WiFi/BLE no se incluyen en el piloto. Para ESPHome y proyectos con red, abrir un hito específico
con inventario de blobs/ABI, registros, interrupciones, buffers, RNG, NVS y dependencias de ROM.
Documentación pública de placa/SoC no garantiza descripción suficiente de la radio para ejecutar
todos los drivers. Esta incertidumbre puede bloquear la sustitución completa.

Comparar estrategias antes de elegir: modelo funcional compatible con el driver binario,
adaptación explícita de servicios con alcance reducido, o mantener el backend anterior para
esos proyectos. Las adaptaciones de servicios requieren recompilación y no acreditan compatibilidad
con el mismo binario. No anunciar asociación, tráfico ni BLE exitosos mediante respuestas simuladas
sin transporte funcional probado. Un transporte del host es infraestructura detrás de una interfaz.

Secure boot, flash encryption, eFuse, crypto y aleatoriedad tendrán alcance por perfil. La semilla
determinista de pruebas queda marcada como emulada; no se presenta como seguridad física equivalente.

## 6. Contratos de integración y ciclo de vida

Proponer un protocolo tipado worker↔adaptador con: versión, `boardId`, generación, secuencia,
instante virtual y payload validado. Comandos: cargar, ejecutar lote, pausar, paso, entrada, reset,
detener. Eventos: estado, salida de pad, consola, barrera eléctrica, diagnóstico y métricas.

El adaptador conserva `Emulador` y presenta `PuenteSim` como fachada de pads nativos. `watch`
suscribe observaciones; no instrumenta firmware. RF solo se ofrece cuando exista una ruta
implementada. Definir capacidades tipadas para consola/REPL, carga de archivos, memoria/debug,
PWM, chips y ADC; evitar nuevos `instanceof` y casts para descubrir métodos opcionales.

Estados internos propuestos: vacío → cargado → iniciando → ejecutando ↔ pausado → detenido;
fallo/soporte incompleto conservan causa. Adaptarlos a los estados públicos existentes mediante
una tabla probada. `bridge`/READY expresa disponibilidad del canal nativo, no que la aplicación
del firmware haya terminado de arrancar ni que todas las capacidades sean compatibles.

Stop/reset invalidan la generación antes de cancelar timers, entradas y respuestas del solver.
Nueva ejecución comienza con estado limpio salvo persistencia declarada de flash/NVS. Escrituras
persistentes necesitan commit atómico por proyecto/placa; un fallo no sobrescribe el firmware base.
Definir warm reset, power-on, brownout y reset por watchdog con una tabla de retención y causas.

Firmware y artefactos son datos no confiables. Imponer máximos de imagen, segmentos, RAM, eventos,
trazas y consola; validar antes de reservar recursos. Worker con presupuesto por lote y parada
forzada evita bloquear el servidor; no se lo considera una frontera de seguridad suficiente para
ejecutar código nativo arbitrario. La CPU interpreta instrucciones dentro de memoria validada y
no ejecuta comandos ni código dinámico del huésped en el host.

## 7. Matriz de compatibilidad y evidencia

Todos los niveles siguientes están **pendientes** en este SDD:

| Nivel | Afirmación permitida al completarlo | No acredita |
|---|---|---|
| C0 | Núcleo ejecuta ELF de laboratorio del perfil ISA probado | Boot ROM, IDF o firmware comercial. |
| C1 | Piloto C3 con GPIO/IRQ/UART/timers y circuito real de la app | Arranque completo si se usó carga ELF directa. |
| C2 | Flash mergeada IDF fijada arranca por la cadena declarada | Toda versión IDF, Arduino, MicroPython o red. |
| C3 | Drivers ADC/PWM/I²C/SPI del corpus funcionan sin puente | DMA, periféricos ausentes o exactitud temporal general. |
| C4 | Firmware MicroPython fijado usa REPL/archivos y `machine` nativo | ESPHome y conectividad completa. |
| C5 | Arduino/ESPHome y servicios de red del corpus | Todas las aplicaciones o fidelidad RF. |
| C6 | Perfiles C6/S3 y recorridos actuales migrados | Chips no inventariados o nuevas funciones upstream. |

Una capacidad declara dos ejes: **fidelidad** (funcional/temporal/eléctrica con perfil) y **evidencia**
(unitaria/integración/comparación física). Mostrar limitaciones concretas; no un porcentaje general
de compatibilidad. El preflight valida manifiesto/capacidades conocidas; dependencias descubiertas
en ejecución producen diagnóstico. Un análisis estático no puede garantizar todo acceso posible.

Cada evidencia guarda: commit del motor, versión de modelo y especificación, toolchain por digest,
hash de firmware/ROM/configuración/circuito, semilla, entradas temporizadas, estrategia, tolerancias,
traza normalizada y resultado. Datos físicos agregan placa/revisión, instrumento, muestreo y conexión.
Los binarios redistribuibles se versionan como fixtures con manifiesto; los demás tienen obtención
reproducible y hash, sin descargas implícitas en unitarios.

## 8. Plan de validación para la implementación

Diseñar pruebas antes del bloque correspondiente y comprobar que detectan su defecto. La presente
entrega documental no ejecuta ni incorpora tests de una implementación inexistente.

| Área | Casos obligatorios |
|---|---|
| ISA | Cada familia, bordes signed/unsigned, multiplicación alta, división, compresión, CSRs, traps y retorno. |
| Memoria | Alias compartidos, BSS, permisos, alineación, límites, accesos parciales y MMIO con efectos. |
| Registros | Reset, máscaras, W1C, solo lectura, enable/disable, FIFO y cambios de reloj. |
| Tiempo | Orden de empates, wraparound, cambio de frecuencia, WFI, pausa, replay y eventos atrasados. |
| GPIO | Dirección en runtime, pull, alta impedancia, open-drain, contención, IRQ y strapping. |
| Circuito | Alimentación ausente/recuperada, corto, flotante, umbral y `resuelto:false` como fallo. |
| Arranque | Imagen inválida/otro chip, ROM fijada, bootloader, particiones, flash y reinicio. |
| Buses | Cable desconectado, NACK, módulo sin VCC, CS incorrecto, frecuencia y transferencia real del driver. |
| Producto | Start/stop/reset, recarga, consola, debugger, instancias y respuestas obsoletas. |
| Recursos | Bucle infinito, cola saturada, UART excesiva, muchas instancias y cancelación forzada. |

Contrastar ISA con tests arquitectónicos RISC-V de versión fijada y, cuando corresponda, un modelo
independiente. Pasar un subconjunto no implica certificación oficial RISC-V. Comparar firmware con
QEMU/`esp-emu` donde ambos soporten el caso; resolver discrepancias con especificación y placa física.
El comportamiento del emulador anterior no es la autoridad final.

El primer recorrido completo usa un firmware mínimo generado desde plantillas TypeScript, sin
puente: configura GPIO, imprime por UART, espera un timer y cambia LED por IRQ del pulsador. Se
guarda el binario compilado para repetirlo sin Docker y se conserva su compilación reproducible.
Comparación física: mismo binario, UART y flancos medidos; orden exacto cuando sea contractual y
ventanas de tolerancia fijadas previamente para tiempos físicos.

Benchmarks por etapa: instrucciones/s, avance virtual/real, RAM, tamaño de traza, latencia de
stop, barreras por segundo y coste del solver. Registrar equipo/corpus/carga; no prometer 1× antes
de medir. Umbral inicial propuesto de stop: p95 ≤ 250 ms con un worker cargado en equipo de referencia,
con terminación forzada ≤ 2 s. Fijar presupuestos restantes en M0 y usar la misma máquina al comparar.

## 9. Backlog por hitos y puertas de aceptación

Cada hito se implementa en ramas/PRs revisables con changelog, pruebas y evidencia. Si excede un PR,
dividir por contrato o bloque completo; ningún PR habilita por defecto capacidades sin validar.

| Hito | Dependencia | Entregable | Puerta para cerrar |
|---|---|---|---|
| M0 — inventario y perfil | SDD | Matriz real de placas/lenguajes/funciones; revisión C3/ROM/flash; corpus y presupuestos | Versiones/digests/hashes fijados, procedencia comprobada y huecos de documentación registrados. |
| M1 — contratos y tiempo | M0 | Máquina pura, protocolo worker, agenda y contrato de pads/barreras | Replay de eventos, cancelación por generación y medición del coste de barreras; regresiones de integración existente. |
| M2 — memoria y RV32I | M1 | Bus, ELF de laboratorio, instrucciones base y diagnósticos | Corpus ISA base y casos de límites pasan contra referencia independiente; C0 parcial explícito. |
| M3 — ISA del perfil y traps | M2 | Extensiones requeridas, CSRs, excepciones y IRQ del C3 | Corpus C0 completo del perfil; interrupción entra y retorna correctamente. |
| M4 — primer circuito vivo | M3 | GPIO/IO MUX mínimo, UART, reloj y timer; adaptador experimental | Mismo firmware sin puente controla LED con pulsador en la app; replay, stop/reset y comparación física C1. |
| M5 — cadena de arranque | M4 | ROM, flash, mapeos, bootloader y registros de sistema necesarios | Flash mergeada IDF fijada llega a app y reinicia sin bypass oculto; C2. |
| M6 — runtime IDF | M5 | SYSTIMER/TIMG/watchdogs, IRQ y demás dependencias observadas | Aplicación FreeRTOS con tareas, espera y watchdog ejecuta corpus; no se inhabilitan bloques para ocultar fallos. |
| M7 — periféricos de aplicación | M6 | ADC, LEDC, I²C y SPI con perfiles y adaptación a chips | C3 con sensores/pantallas; lecturas dependen del circuito, fallos eléctricos y buses tienen diagnóstico. |
| M8 — MicroPython nativo | M7 | Firmware fijado, REPL/archivos sin shims de GPIO/I²C/SPI/ADC | C4; carga, recarga y reset conservan semántica sin exigir `EmulatorManager`. |
| M9 — funciones adicionales | M7 | DMA/RMT/I²S/USB y debugger según inventario M0 | Cada función del producto tiene driver real y evidencia, o sigue explícitamente sin soporte. |
| M10 — radio/red y ESPHome | M6, M9 según corpus | Investigación de interfaces, estrategia aprobada y transporte; corpus Arduino/ESPHome | C5 por caso; red real de extremo a extremo y límites declarados. Si falta información crítica, se registra bloqueo de retiro. |
| M11 — ESP32-C6 | C3 estabilizado | Perfil y diferencias de ISA, IRQ, memoria, ROM y periféricos | Corpus específico del C6; no se hereda certificación del C3. |
| M12 — ESP32-S3 | M0, infraestructura estable | Núcleo Xtensa propio, multicore, memoria/periféricos y ROM del S3 | Corpus S3 actual incluyendo funciones de proyectos; prueba de concurrencia entre núcleos y circuito. |
| M13 — promoción por placa | Hitos correspondientes | Selección por capacidades, certificación y migración reversible | Cero regresiones del corpus de esa placa y recorridos de UI completos. |
| M14 — retiro de esp-emu | M10–M13 + inventario satisfecho | Eliminar dependencia, rutas de puente obsoletas y documentación antigua | R12 completo; ninguna placa previamente soportada queda degradada silenciosamente. |

Camino crítico inicial: **M0 → M1 → M2 → M3 → M4**. El primer resultado útil es M4; no exige terminar
radio ni S3. La cadena ROM/IDF es la siguiente prueba de viabilidad. No fijar fechas del reemplazo
total antes de medir CPU/barreras y estudiar ROM/radio/Xtensa. En cada cierre registrar esfuerzo
real y recalcular lo restante; los hitos son criterios de salida, no estimaciones de duración.

### Primeros PR propuestos

1. Inventario versionado del corpus, perfil C3 y decisiones de ROM/ISA. Añadir caracterización de
   los contratos existentes que se van a extender, sin cambiar el motor seleccionado.
2. Agenda, protocolo de generación y experimento de sincronización con solver; métricas reales.
3. Bus de memoria y cargador ELF de laboratorio con validación de entradas.
4. Núcleo RV32I dividido por familias verificables; después extensiones, traps y CSR del perfil.
5. Periféricos mínimos y primer circuito completo. Agregar selección experimental únicamente
   cuando ese camino funcione; el nombre registrado no representa disponibilidad general.

## 10. Migración y reversibilidad

1. Conservar los descriptores actuales; identificar motor efectivo en diagnóstico y evidencia.
2. Agregar soporte experimental por selección explícita y perfil de capacidades; no cambiar
   globalmente `board.backend.engine` ni crear una placa falsa para eludir validaciones.
3. Incluir motor/perfil/versión en claves de compilación/caché cuando afecten artefactos. Separar
   configuración física de ajustes exclusivos de emulación.
4. Adaptar validación `native`, toolchains, REPL, PWM y debug por capacidades, manteniendo AVR.
5. Para cada placa, ejecutar corpus físico/emulado y recorridos UI antes de promoverla.
6. Persistir la elección y mostrar soporte incompleto antes de iniciar cuando sea conocido. Ante
   fallo, conservar diagnóstico y ofrecer volver al backend anterior; sin fallback silencioso.
7. Probar ida/vuelta con copias de proyectos y NVS. Preservar datos al desactivar el experimento;
   snapshots internos del motor se versionan y pueden declararse incompatibles.
8. Retirar `esp-emu` solo tras cumplir M14. Si se acuerda abandonar alguna función anterior,
   registrar la decisión de producto y migración explícita; no presentarla como compatibilidad lograda.

## 11. Riesgos y decisiones pendientes

| Riesgo | Acción y punto de decisión |
|---|---|
| Información incompleta o restricciones de ROM | M0 verifica fuentes y condiciones; frena M5, no oculta el problema con stubs. |
| Semántica ISA/CSRs específica del C3 | Perfil documentado, corpus arquitectónico y contraste físico antes de IDF. |
| Coste TypeScript o comunicación con solver | Medir M1/M4; optimizar lotes y memoria preservando contratos; reevaluar estrategia en un ADR si no alcanza. |
| Boot parece requerir muchos bloques adicionales | Trazar accesos y sumar contratos; no resolverlo devolviendo ceros de forma genérica. |
| Radio o Xtensa excede información/recursos disponibles | Hitos de investigación separados; conservar backend previo para las capacidades pendientes. |
| Errores comunes entre modelo y pruebas | Oráculo independiente y medición física; los tests generados de una tabla no son evidencia suficiente. |
| Tiempo funcional confundido con ciclos reales | Etiquetar estrategia y calibración; métricas/tolerancias separadas. |
| Integración altera circuitos AVR o ESP actuales | Caracterización y regresión por contrato; promoción individual por placa. |
| Pérdida de datos por reset/migración | Políticas de retención, persistencia atómica y pruebas sobre copias. |

Decisiones que M0 debe cerrar con evidencia: revisión exacta de C3 y placa física disponible; ROM
obtenible y condiciones; perfil ISA/CSRs; imagen IDF por digest; firmware y proyectos de referencia;
presupuestos en equipo identificado. M1 fija unidad temporal, orden de fases y barreras. M10 fija
estrategia de conectividad. M12 necesita su propio anexo Xtensa antes de implementar esa CPU.
No se delegan estas decisiones a valores por defecto sin procedencia.

## 12. Definición de terminado

**Por bloque:** ficha + implementación TypeScript + pruebas que detectan defectos + reset/errores +
evidencia y límites. **Por hito:** todos sus requisitos y casos pasan, incluida prueba en la app con
firmware corriendo cuando tenga un recorrido visible. Tests por separado no cierran M4/M7/M8.

Las verificaciones previstas para PRs de implementación son: tests afectados y suite de regresión,
typecheck server/shared/web y modelos según cambios, build y E2E del recorrido.
Cambios en rutas requieren arranque real del servidor y único registro por método/ruta. Toda
simulación `resuelto:false` falla también en smoke/importación/`soloValidar`. Evidencia debe separar
pasados, fallidos, omitidos y no ejecutados; un skip de hardware nunca cuenta como validación física.

**Sustitución total:** corpus inventariado cubierto en C3/C6/S3 y lenguajes/funciones actuales,
incluida conectividad necesaria; documentación/capacidades actualizadas; proyectos y persistencia
migrables; CI y pruebas de app completas; revisión de licencias; dependencia de `esp-emu` eliminada.
Ninguna casilla de este documento está completada por haber escrito el SDD.

## 13. Fuentes y documentos relacionados

Fuentes oficiales consultadas el 20 de octubre de 2026. En M0 fijar revisiones/hashes: URLs `stable`,
`latest` y `main` cambian; la guía IDF consultada hoy sirve de referencia conceptual y no sustituye
la versión 5.5.5 fijada por el proyecto.

- [ESP32-C3 TRM, versión 1.4](https://www.espressif.com/sites/default/files/documentation/esp32-c3_technical_reference_manual_en.pdf): contratos de CPU y periféricos; capítulos CPU, memoria, GPIO, reset, arranque, IRQ, timers y buses.
- [ESP32-C3 datasheet](https://www.espressif.com/sites/default/files/documentation/esp32-c3_datasheet_en.pdf): límites y características del SoC; no equivale al esquema de la placa.
- [ESP32-C3 DevKitM-1](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c3/esp32-c3-devkitm-1/user_guide.html): módulo, conexiones y referencias de placa.
- [RISC-V RV32I, biblioteca 20260120](https://docs.riscv.org/reference/isa/v20260120/unpriv/rv32.html): semántica base; completar extensiones y especificación privilegiada según perfil.
- [RISC-V Architectural Tests](https://github.com/riscv/riscv-arch-test): corpus independiente para el perfil soportado; revisar versión, integración y licencia.
- [Flujo de arranque IDF/C3](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-guides/startup.html) y [formato de imagen](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-reference/system/app_image_format.html): cadena ROM/bootloader/aplicación y validación de segmentos.
- [ROM ELF de Espressif](https://github.com/espressif/esp-rom-elfs): investigar artefactos por revisión y condiciones; no se presupone permiso de redistribución.
- [QEMU de Espressif](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-guides/tools/qemu.html): referencia de contraste cuando el caso esté soportado.
- [ESP Emulator](https://github.com/espressif/esp-emulator) y [guía WASM](https://github.com/espressif/esp-emulator/blob/main/docs/guides/BROWSER.md): backend anterior y funciones documentadas upstream.
- [Motores existentes](app/server/src/engines/README.md), [arquitectura server](docs/arquitectura-server.md), [motor eléctrico](docs/motor-electrico.md), [chips](chips/README.md), [SDD módulos](SDD-MODULOS.md), [perfiles físicos](docs/PERFILES-FISICOS.md) y [proceso de módulos](docs/agregar-un-modulo.md): contratos que esta migración debe preservar.
