# SDD: plataforma propia de componentes y esquemáticos jerárquicos

**Estado:** diseño con implementación P0/P1 y integración DC y selección exclusiva de representaciones; editor y ESP32 pendientes.

**Fecha:** 20 de octubre de 2026.

**Solicitud:** gestionar esquemáticos propios como composiciones jerárquicas de componentes, con leyes, contratos y estrategias; sustituir `esp-emu` mediante la primera integración de esta plataforma.

**Base del producto:** plataforma reutilizable de componentes y esquemáticos propios.

**Primera integración de plataforma:** ESP32-C3 DevKitM-1; núcleo RISC-V y periféricos propios en TypeScript.

**Nombre propuesto del backend:** `esp32-propio`.

**Base inspeccionada:** `53e5721`; `main` sin PR abiertos al iniciar este diseño.

Este documento planifica la plataforma y su primera integración para reemplazar `esp-emu`. No
anuncia jerarquía ejecutable disponible, motor implementado, firmware ejecutado ni compatibilidad
demostrada. Cada capacidad se habilita después de completar su evidencia.

### Inicio de implementación

P0 cuenta con un [inventario de capacidades, corpus y presupuestos](docs/componentes/P0-INVENTARIO.md)
y el [ADR de identidad, composición y fuente de verdad](docs/componentes/ADR-001-COMPOSICION.md).
El contrato está en `app/shared/src/componentes/contratos.ts`. El [elaborador P1](docs/componentes/elaboracion.md)
resuelve definiciones por versión/hash y produce instancias/redes con origen en memoria, validando
parámetros y dependencias sin modificar proyectos existentes. La [integración DC](docs/componentes/electrico.md)
verifica paquetes legados y calcula tensiones/corrientes de divisores anidados, comparándolas con
un plano independiente mediante el motor eléctrico actual. La selección exclusiva de interior o
equivalente ya está implementada para consultas DC; agenda común y editor siguen pendientes; no se acreditan H0–H3 completos ni compatibilidad ESP32.

## 1. Resultado buscado y decisiones de alcance

El producto debe permitir crear, abrir, modificar, conectar, reutilizar y simular esquemáticos
propios, desde componentes discretos hasta placas completas. Un componente compuesto contiene
instancias de otros componentes y conexiones; sus puertos hacen explícita la relación con el exterior.
La jerarquía es una estructura ejecutable del dominio y también la base de edición y fabricación.

El ESP32 es la primera integración grande: la placa combina alimentación, USB, botones, conectores,
flash y un SoC; el SoC compone CPU, memorias y periféricos. La lógica de la aplicación permanece en
el firmware: botón → tensión → pad → registro/IRQ → instrucciones → salida → LED. Cambiar un
regulador o su cableado debe poder afectar VCC, producir un reset y modificar esas salidas.

La plataforma debe demostrar composición y edición antes de implementar la CPU. Un circuito
jerárquico sin MCU permite comprobar que sus contratos sirven también fuera de la familia ESP32.

Decisiones propuestas para implementación:

1. **Plataforma común primero.** Definiciones versionadas, instancias, puertos tipados, conexiones,
   esquemáticos internos y estrategias de representación pertenecen al dominio general. El núcleo
   de composición y tiempo no importa ni conoce ESP32.
2. **Núcleo propio en TypeScript.** Implementar CPU, memoria, registros y periféricos dentro del
   proyecto. QEMU y `esp-emu` serán referencias externas de contraste, no requisitos de ejecución
   del backend nuevo. Se permite estudiar especificaciones y código con licencia compatible,
   registrando procedencia y condiciones antes de incorporar código ajeno.
3. **C3 primero.** Fijar una revisión del SoC, una variante de placa, una ROM y una configuración
   de flash. C6 necesita otro perfil y revisión de ISA/periféricos. S3 necesita un núcleo Xtensa;
   una CPU RISC-V no ejecuta su firmware.
4. **Firmware real sin puente obligatorio.** La ruta final no depende de `simbridge.py`, de
   `sim_bridge` ni de sustituir llamadas de `machine`. El firmware usa los periféricos emulados.
5. **Compatibilidad progresiva y declarada.** Un ELF de laboratorio, una aplicación IDF, el
   firmware oficial MicroPython y ESPHome son hitos distintos.
6. **Retiro gradual.** `esp-emu` sigue seleccionable durante la migración. Retirarlo por completo
   requiere cubrir las placas y recorridos actualmente soportados, incluido S3 y sus funciones de
   red. Una entrega C3 sin red no alcanza para ese cierre.
7. **Primera estrategia de fidelidad:** funcional con tiempo virtual determinista. La latencia
   de cada instrucción y las características analógicas requieren modelos adicionales; no se
   publicará precisión de ciclos, consumo o radio que no haya sido validada.

No se reinterpretará el código C/Python del usuario en el host ni se inferirán sus salidas a partir
de patrones de texto. Un intérprete MicroPython podrá correr como firmware dentro del SoC emulado.

## 2. Situación actual y piezas reutilizables

| Pieza existente | Uso previsto y adaptación necesaria |
|---|---|
| `modules/`, `chips/`, `app/shared/src/module.ts` y `fabricacion.ts` | Adaptar catálogo, modelos, reglas y fabricación al contrato jerárquico; preservar identificadores y datos existentes. |
| `app/server/src/engines/{index,tipos}.ts` | Registrar el motor con disponibilidad acorde con el alcance real. |
| `app/server/src/emulatorBackend.ts` | Conservar el ciclo de vida y el canal de pines del producto; extender capacidades por contrato. |
| `app/server/src/emulator.ts` | Backend externo actual, versión fijada `0.44.0`; referencia de compatibilidad durante la transición. |
| `app/server/src/avrSim.ts`, `avrEmulator.ts` | Referencia local para CPU en worker, entradas nativas y adaptación de eventos; no reutilizar supuestos AVR como reglas ESP. |
| `app/server/src/bus/{busChips,proyectoChips}.ts` | Reutilizar dispositivos externos y sus estados, alimentación y persistencia. |
| `app/server/src/bus/puenteChips.ts` | Extraer conexión al dominio que sirva; el transporte UART y los shims MicroPython no son el controlador nativo. |
| `app/server/src/sim/`, observación eléctrica | Mantener un único motor del circuito y sus diagnósticos. |
| `app/server/src/buildService.ts`, `toolchains/` | Conservar compilación, caché y errores; enriquecer el manifiesto de artefactos. |
| `app/server/src/debug/` | Conservar contratos de producto y adaptar acceso a CPU/memoria cuando exista soporte. |

El formato actual de `modules/README.md` ya vincula `model.ts` con `esquematico.discreto`, nodos y
piezas de fabricación. El SDD-MODULOS propone importación desde esquemáticos y una fuente de verdad.
Esta propuesta extiende esos contratos: antes de crear un esquema de datos nuevo, inventariar lo
implementado frente a lo propuesto y definir su adaptación. Los metadatos de despiece actuales no
acreditan por sí solos composición jerárquica ejecutable ni edición interna.

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
| R13 | Composición reutilizable | Mismo componente compuesto instanciado dos veces, con parámetros, estado y conexiones independientes. |
| R14 | Esquemático propio editable | Abrir subcircuito, modificar una pieza/conexión, guardar y recargar conserva identidad y comportamiento. |
| R15 | Una representación activa por dominio | Cambiar entre modelo equivalente e interno no duplica corriente, consumo, eventos ni salidas. |
| R16 | Conectividad jerárquica correcta | Elaboración produce la misma conectividad que un circuito plano de referencia, con diagnóstico por ruta original. |
| R17 | Plataforma independiente del ESP32 | Circuito compuesto sin MCU usa los mismos contratos, agenda y adaptadores sin importar `esp32/`. |
| R18 | Fabricación trazable | Exportación incluye piezas físicas del nivel elegido, mantiene referencias y excluye bloques virtuales del silicio. |
| R19 | Cambios con alcance explícito | Edición de instancia no altera definición compartida; actualización de definición requiere migración visible de versiones. |

## 4. Modelo de dominio: leyes, contratos y estrategias

### 4.1 Jerarquía y entidades propias

Ejemplo de composición, sujeto a la variante física elegida:

```text
proyecto/placa
├── alimentacion
│   └── regulador, resistencias, capacitores, transistor si corresponde
├── interfaz-usb
├── botones-y-conectores
├── flash-externa (cuando la variante la tenga)
├── antena-y-adaptacion
└── modulo-esp32
    └── soc
        ├── cpu
        ├── memorias
        ├── matriz-gpio
        ├── adc, pwm, uart, spi, i2c
        └── wifi, bluetooth
```

Los niveles placa/módulo/SoC son composiciones de la misma plataforma; la ubicación real de flash,
antena y demás piezas depende del esquema de la variante. El interior funcional del silicio no es
una lista de piezas discretas soldables. Cada bloque declara qué conocemos de su interior.

Entidades propuestas, a concretar con los esquemas existentes en P0/P1:

| Entidad | Contrato |
|---|---|
| Definición de componente | Identificador y versión inmutables, puertos, parámetros, leyes, representaciones y evidencia. Puede ser primitiva o compuesta. |
| Instancia | ID estable, referencia a versión exacta, parámetros y estado propios; sin estado mutable en la definición compartida. |
| Esquemático interno | Instancias hijas, conexiones y mapeo entre puertos públicos y terminales internos. Fuente de verdad para la composición elegida. |
| Puerto/terminal | ID estable, dominio, ancho/unidad, dirección cuando aplique y límites/capacidades. Distinguir puerto externo de nodo interno. |
| Conexión | Une terminales de dominio compatible; buses, IRQ y relojes no se conectan implícitamente como un cable analógico. |
| Representación | Implementación eléctrica, funcional o interna con cobertura declarada y política de activación. |
| Instancia elaborada | Grafo ejecutable derivado de las definiciones y conexiones; conserva ruta de origen para depuración. No se edita como segunda fuente. |
| Vista gráfica/fabricación | Proyecciones de las mismas identidades y conexiones, con metadatos físicos y de presentación. |

Identidad de ejecución: proyecto + placa + ruta de IDs de instancia + generación. La referencia
visible `R1` puede repetirse en hojas distintas; renombrar una etiqueta no cambia la identidad.
Los parámetros tienen tipo, unidad, rango y procedencia; overrides explícitos y reproducibles,
sin evaluar expresiones arbitrarias del proyecto en el host.

Puertos eléctricos se resuelven como redes; señal digital lógica, IRQ, reloj, transacción de bus y
canal de radio son dominios diferenciados. Adaptadores explícitos convierten tensión↔nivel,
registros↔controlador de bus y protocolo↔transporte; cada adaptador declara umbrales, tiempos y
pérdida de detalle. La referencia de tierra se conecta explícitamente: dos hojas con un terminal
llamado GND no quedan cortocircuitadas por compartir nombre. Uniones globales requieren declaración.

La dependencia entre definiciones debe ser acíclica; rechazar autorreferencia, versiones ausentes,
puertos inexistentes y profundidad/tamaño excesivos. Esta restricción de composición no impide
lazos eléctricos o feedback válidos dentro del circuito: esos los resuelve el motor correspondiente.

### 4.2 Ficha obligatoria para cada componente

Cada primitiva o compuesto debe completar la ficha antes de implementarse. CPU y periféricos
agregan los campos de registros/ISA que correspondan; un resistor no necesita inventar registros:

| Campo | Contenido obligatorio |
|---|---|
| Identidad | Definición/versión, variante física o bloque virtual, y referencias de esquema/hoja de datos/manual con revisión. |
| Estado | Variables eléctricas/funcionales, estado persistente/volátil y reset; registros/FIFOs/contadores cuando correspondan. |
| Contrato | Puertos, parámetros, dominios y mapeo interno; en MMIO, direcciones, tamaños, alineación, endianness, máscaras y efectos de acceso. |
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

### 4.3 Representaciones, nivel de detalle y propiedad de efectos

Una resistencia/capacitor/transistor usa el solver eléctrico y sus parámetros; un regulador puede
combinar ecuaciones y estados; flash usa protocolo, memoria y tiempos; CPU ejecuta instrucciones;
WiFi combina controlador y protocolo, con fidelidad RF como capacidad independiente. Todos son
componentes del dominio común y conservan modelos adecuados a su responsabilidad.

Cada representación declara qué dominios y efectos implementa. Un plan de ejecución elige un
único propietario para cada efecto: corriente, carga capacitiva, drive, consumo, IRQ o evento.
Un equivalente y su esquema interno son alternativas para los mismos efectos; complementos en
dominios diferentes pueden coexistir mediante un contrato explícito. Un validador rechaza cobertura
solapada y evidencia faltante. Ninguna pieza interna aparece dos veces en la netlist del solver.

**Avance del piloto DC:** [selección exclusiva](docs/componentes/representaciones.md) entre el
interior y un equivalente completo, con interfaces idénticas y elección por ruta de instancia.
El árbol inactivo no se elabora ni se ejecuta. Se comparan tensiones, carga y potencia de divisores
anidados. La cobertura parcial por dominio y los complementos funcionales siguen pendientes;
la exclusión actual asigna todos los efectos del componente a una única alternativa.

**Expandir visualmente una hoja no cambia el modelo activo.** Seleccionar más detalle requiere
una acción/configuración explícita, validación de capacidades y presupuesto. Inicialmente se hace
con la corrida detenida y reinicio declarado; no se promete transferir estado entre representaciones.
Una futura conversión en vivo necesita su contrato y pruebas de conservación de estado/energía.

Un componente sin interior conocido puede conservar un modelo funcional, con procedencia y límite
visibles. Se puede añadir un esquema interno después, sin cambiar sus puertos públicos compatibles.
La plataforma debe admitir discretos y transistores individuales, sin exigir reconstruir una CPU
transistor por transistor. El firmware real sigue ejecutándose en el modelo de CPU seleccionado.

### 4.4 Elaboración, edición y fabricación

Antes de ejecutar, validar definiciones, instancias, parámetros, puertos y representación activa.
Elaborar a un grafo con ámbitos de nombres y conectividad resuelta; generar desde allí la netlist
eléctrica y las conexiones funcionales. Conservar mapa bidireccional entre cada elemento elaborado
y su ruta/terminal en el esquema. Distinguir subcircuitos del solver frente a aplanado como estrategia
de infraestructura; ambas deben mantener conectividad, efectos y diagnósticos equivalentes.

La UI debe permitir navegar proyecto → hoja → subcomponente, ver puertos y modelo activo,
inspeccionar tensiones/estado/diagnósticos y editar parámetros, piezas y conexiones disponibles.
Editar una instancia crea overrides o una variante local explícita; editar una definición produce
una nueva versión y una actualización revisable de las instancias consumidoras. Definir undo/redo,
validación transaccional y guardado por la revisión existente del proyecto antes de implementar.

Persistir el esquema y sus referencias de versión, overrides y selección de representación; derivar
netlists y vistas. La ubicación exacta se decide en P0/P1 integrando `module.json`, `esquematico`,
`model.ts` y `chips/`, sin mantener dos esquemas editables inconsistentes. Un modelo legado puede
seguir como hoja funcional con adaptador hasta disponer de interior explícito.

Importar un esquema conocido conserva jerarquía, pines e IDs cuando el formato lo permita; listar
piezas sin modelo y pérdidas de conversión. El importador debe reutilizar herramientas/formato
existentes. P0 debe inventariar qué rutas KiCad/netlist están implementadas y cuáles requieren trabajo.
No afirmar round-trip sin pérdida para formatos o metadatos no cubiertos.

Exportar fabricación desde la composición física seleccionada: una placa puede comprar un módulo
o desglosar sus piezas disponibles. CPU, registros, periféricos y bloques de radio internos del
SoC no generan componentes ficticios en BOM/PCB. Distinguir explícitamente bloque virtual, pieza
física y subcircuito fabricable, y mantener pines, referencia, símbolo y huella trazables. Modelo de
simulación y elección de ensamblado son configuraciones diferentes.

### 4.5 Políticas de comportamiento

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
Editor jerárquico / API / catálogo / proyectos / importación y fabricación
                               ↓
Plataforma propia de componentes (contratos independientes de ESP32)
  ├─ Definiciones, instancias, parámetros, puertos y conexiones
  ├─ Elaboración, selección de representaciones y trazabilidad
  ├─ Agenda común, dominios de tiempo y ciclo de vida
  └─ Validación, diagnósticos y evidencia
             ↙                 ↓                     ↘
Adaptador eléctrico      Modelos funcionales       Primera integración: ESP32
ngspice / solver         chips / memoria / buses     C3: CPU + periféricos + perfil
             ↖                 ↕                     ↗
             Coordinación de efectos y barreras temporales
                               ↓
           Adaptador esp32-propio: Emulador / worker / eventos de app
```

El motor eléctrico sigue siendo el existente; la plataforma compone sus primitivas y las conecta
con modelos funcionales. El coordinador y los puertos son reutilizables. El backend ESP32 adapta una
composición concreta a `Emulador`; el código general de componentes no depende de ese backend.

Ubicaciones propuestas, por responsabilidad y sin mover código ajeno de paso:

```text
app/shared/src/componentes/       # contratos públicos, esquemas y versiones
app/server/src/componentes/
  definiciones.ts                # catálogo/adaptación de módulos y chips
  elaboracion.ts                 # instancias, ámbitos, redes y origen
  representaciones.ts            # cobertura y propiedad de efectos
  tiempo/                        # agenda común, dominios y barreras
  adaptadores/                   # solver, buses y persistencia existentes
app/server/src/esp32/
  cpu/                           # decodificación, ejecución RISC-V y CSRs
  memoria/                       # regiones, permisos, alias, MMIO y carga
  perifericos/                   # componentes propios y fichas de registros
  perfiles/                      # composición/versiones concretas C3; otros después
  maquina.ts                     # compone componentes mediante la plataforma
  worker.ts                      # protocolo y aislamiento de ejecución
  traza.ts                        # trazas específicas de firmware
app/server/src/engines/esp32Propio.ts
app/server/src/esp32Emulator.ts
app/web/react/componentes/       # navegación e inspección/edición jerárquica
app/tests/unit/shared/componentes/
app/tests/unit/server/componentes/
app/tests/unit/server/esp32/
app/tests/fixtures/server/componentes/
app/tests/fixtures/server/esp32/
app/tests/e2e/componentes-jerarquicos.spec.ts
app/tests/e2e/esp32-propio.spec.ts
```

Son destinos propuestos de implementación. P0/P1 deben ajustarlos a capacidades existentes y
ampliar sus contratos antes de duplicar infraestructura. La UI no recibe estado interno de ngspice
ni tipos privados de una librería. Ni dominio de componentes ni CPU importan `index.ts`.

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

La agenda pertenece a la plataforma común. Cada componente registra sus dominios, eventos y
barreras mediante esos contratos; la CPU C3 es un consumidor, no el propietario del tiempo global.

Agenda con tiempo entero y precisión declarada, orden estable por instante/fase/secuencia y
contadores sin pérdida de precisión. Dominios CPU/APB/RTC convierten sus ticks conservando residuos;
cambiar frecuencia no retrocede el reloj ni pierde eventos. La unidad y conversión se fijan en P2 y se reutilizan en M1.

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

WiFi/BLE son componentes de la jerarquía con puertos y estrategias propios: controlador digital,
protocolo/transporte y representación de antena/radio se identifican por separado. Dibujar o
expandir esos bloques no acredita propagación RF, cobertura, interferencias o fidelidad de antena.

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

El ciclo de vida se propaga desde la composición a sus hijos según sus conexiones y dominios de
alimentación/reset. Una fuente de alimentación interna desconectada afecta a sus consumidores;
la CPU no recibe energía por ser una placa programable. Detener la composición cancela sus eventos,
conservando persistencia solo en las instancias que la declaran. La traza incluye ruta de componente.

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

La plataforma se acepta primero con evidencias independientes del firmware, todas pendientes:

| Nivel | Evidencia de plataforma |
|---|---|
| H0 | Definiciones/instancias versionadas, validación de puertos, ámbitos y selección de representación. |
| H1 | Subcircuito repetido y anidado produce conectividad/resultados equivalentes al plano, con una sola representación activa por efecto. |
| H2 | Abrir/editar/guardar/recargar un esquema propio y exportar su composición física mantiene identidades y conectividad. |
| H3 | Sustituir una pieza de alimentación afecta al circuito y al estado de sus consumidores mediante contratos comunes; se acredita sin MCU en P4 y con ESP32 en M4. |

H0–H3 son evidencia de composición, edición e integración; la compatibilidad de firmware C0–C6 se
acredita por separado. Todos los niveles siguientes están **pendientes** en este SDD:

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

Diseñar pruebas antes del bloque correspondiente y comprobar que detectan su defecto. La planificación
no constituye evidencia: cada avance registra las pruebas realizadas y las capacidades aún pendientes.

| Área | Casos obligatorios |
|---|---|
| Jerarquía | Instancias anidadas/repetidas, ámbitos, GND explícito, puertos y parámetros inválidos, versiones ausentes y ciclos de composición. |
| Representaciones | Modelo interno/equivalente, rechazo de doble efecto, expansión visual sin cambio de ejecución y reinicio al cambiar estrategia. |
| Elaboración | Equivalencia con plano, IDs estables y diagnóstico que retorna a hoja/pieza/terminal. |
| Edición/persistencia | Navegar/editar/undo/redo/guardar/recargar; variantes locales, nuevas versiones compartidas y conflictos de revisión. |
| Fabricación | BOM física sin bloques virtuales, pines y conexiones trazables, pérdidas de importación explícitas. |
| Independencia | Subcircuito sin MCU ejecuta agenda y adaptadores comunes sin dependencia ESP32. |
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

El primer recorrido de plataforma usa un subcircuito reutilizable sin MCU: fuente → regulación
con componentes disponibles → carga e indicador. Instanciar dos copias, modificar una, verificar
independencia y comparar con el plano; abrir una hoja, guardar/recargar y exportar con trazabilidad.
P0 elige piezas con modelos existentes y valores documentados. La variante con transistor usa el
modelo existente si está disponible; si falta, se registra como capacidad nueva con su propio TDD.

El primer recorrido ESP32 completo usa un firmware mínimo generado desde plantillas TypeScript, sin
puente: configura GPIO, imprime por UART, espera un timer y cambia LED por IRQ del pulsador. Se
guarda el binario compilado para repetirlo sin Docker y se conserva su compilación reproducible.
Comparación física: mismo binario, UART y flancos medidos; orden exacto cuando sea contractual y
ventanas de tolerancia fijadas previamente para tiempos físicos.

Benchmarks de plataforma: profundidad y cantidad de instancias/terminales, tiempo de elaboración,
memoria, tamaño de netlist, coste de expandir/editar/guardar y equivalencia de resultados según
representación. P0 fija casos pequeños, medianos y grandes con presupuesto medible.

Benchmarks ESP32 por etapa: instrucciones/s, avance virtual/real, RAM, tamaño de traza, latencia de
stop, barreras por segundo y coste del solver. Registrar equipo/corpus/carga; no prometer 1× antes
de medir. Umbral inicial propuesto de stop: p95 ≤ 250 ms con un worker cargado en equipo de referencia,
con terminación forzada ≤ 2 s. Fijar presupuestos restantes en M0 y usar la misma máquina al comparar.

## 9. Backlog por hitos y puertas de aceptación

Cada hito se implementa en ramas/PRs revisables con changelog, pruebas y evidencia. Si excede un PR,
dividir por contrato o bloque completo; ningún PR habilita por defecto capacidades sin validar.

| Hito | Dependencia | Entregable | Puerta para cerrar |
|---|---|---|---|
| P0 — inventario de plataforma | SDD | Contratos existentes y brechas, ejemplos sin MCU, formato versionado y presupuestos | ADR de fuente de verdad y adaptación de catálogo/solver/editor/importación; corpus H0–H3 definido. |
| P1 — componentes y elaboración | P0 | Definiciones, instancias, puertos, conexiones, versiones, ámbitos y mapa de origen | H0; mismo subcircuito repetido/anidado con estado independiente; rechazo de referencias y dominios inválidos. |
| P2 — ejecución y representaciones | P1 | Propiedad de efectos, agenda común, elaboración eléctrica y adaptadores funcionales | H1; equivalencia con plano, sin doble conteo, barreras y cancelación reproducibles; expandir vista no cambia resultados. |
| P3 — editor y fabricación | P2 | Navegación/edición interna, variantes, guardado/recarga, exportación física y conversión de la ruta de importación elegida | H2 en la app; modificación aislada, undo/redo, pines/BOM trazables y pérdidas de conversión declaradas. |
| P4 — piloto reusable | P3 | Composición sin MCU y variantes de alimentación; evidencia y costes | H3 para el recorrido sin MCU; la pieza cambiada afecta a consumidores, comparación con plano y presupuestos documentados. |
| M0 — inventario y perfil | P4 | Matriz real de placas/lenguajes/funciones; revisión C3/ROM/flash; corpus y presupuestos | Versiones/digests/hashes fijados, procedencia comprobada y huecos de documentación registrados. |
| M1 — integración C3 en plataforma | M0, P2 | Composición C3, máquina pura, protocolo worker y adaptación de CPU/pads a agenda común | Reutiliza contratos sin duplicar tiempo, conectividad ni estado; replay y coste de barreras medidos. |
| M2 — memoria y RV32I | M1 | Bus, ELF de laboratorio, instrucciones base y diagnósticos | Corpus ISA base y casos de límites pasan contra referencia independiente; C0 parcial explícito. |
| M3 — ISA del perfil y traps | M2 | Extensiones requeridas, CSRs, excepciones y IRQ del C3 | Corpus C0 completo del perfil; interrupción entra y retorna correctamente. |
| M4 — primera placa ESP32 viva | M3, P3 | Placa jerárquica C3, GPIO/IO MUX mínimo, UART, reloj y timer; adaptador experimental | C1: firmware sin puente controla LED con pulsador; abrir subhoja y cambiar alimentación afecta pads/reset; replay y comparación física. |
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

Camino crítico inicial: **P0 → P1 → P2 → P3 → P4 → M0 → M1 → M2 → M3 → M4**. P4 es la
primera entrega útil de plataforma; M4 es la primera integración ESP32 y no exige terminar radio
ni S3. H3 se completa para el consumidor ESP32 en M4. La cadena ROM/IDF es la siguiente prueba
de viabilidad. No fijar fechas del reemplazo total antes de medir CPU/barreras y estudiar ROM/radio/Xtensa. En cada cierre registrar esfuerzo
real y recalcular lo restante; los hitos son criterios de salida, no estimaciones de duración.

Trazabilidad de los nuevos requisitos de plataforma:

| Requisito | Hitos y evidencia |
|---|---|
| R13, R16, R17 | P1/P2/P4: composición anidada sin MCU, equivalencia con plano y núcleo independiente de ESP32. |
| R14, R19 | P3: edición por instancia/definición, undo/redo, guardado y recarga con versiones e IDs estables. |
| R15 | P2: selección por efecto, rechazo de solapamiento y resultados invariantes al expandir la vista. |
| R18 | P3: exportación del ensamblado físico y BOM sin bloques virtuales, con ruta de origen. |
| R03, R08, R13–R17 | M4: firmware real sobre la composición, cambios en alimentación con consecuencias y ciclo de vida aislado. |

### Primeros PR propuestos

1. Inventario de composición/importación/editor/fabricación existentes y ADR de contratos/fuente
   de verdad; corpus sin MCU y mapa de migración de `modules/` y `chips/`.
2. Definiciones/instancias/puertos versionados y elaboración, con equivalencia contra un plano.
3. Representaciones y adaptadores, agenda compartida y experimento de barreras con el solver.
4. Navegación/edición de subhojas, variantes y persistencia; exportación e importación elegida con
   trazabilidad y regresión del catálogo actual.
5. Piloto sin MCU con modificaciones eléctricas visibles y métricas de plataforma.
6. Perfil C3 y corpus ROM/ISA; después memoria/ELF, núcleo RISC-V y componentes de periféricos en
   PRs acotados. La selección experimental ESP32 se habilita cuando funcione su primer circuito.

## 10. Migración y reversibilidad

Primero migrar la composición: adaptar módulos/chips actuales como hojas compatibles; versionar
el formato jerárquico, probar apertura/guardado de proyectos anteriores y conservar respaldo antes
de convertir. No regenerar IDs al abrir. Fijar versiones de definiciones para que actualizar catálogo
no cambie un proyecto guardado. Layout de subhojas y esquema eléctrico comparten referencias estables.

La representación física y la activa se guardan con el proyecto; modelos derivados se invalidan
por hashes de composición/versiones/parámetros. Cambiar una definición actualiza instancias mediante
una migración explícita; dependencias sin resolver bloquean esa conversión con diagnóstico.

Después migrar la ejecución ESP32:

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
| Jerarquía visual que no gobierna ejecución | P1/P2 elaboran el grafo ejecutable desde la misma composición que edita la UI; equivalencia con plano obligatoria. |
| Doble conteo de interno y equivalente | P2 valida un propietario por efecto y rechaza solapamiento antes de ejecutar. |
| Catálogo y esquemático divergen o actualización rompe instancias | P0 define fuente de verdad, versiones fijadas y migración revisable; P3 cubre guardado/exportación. |
| Crecimiento de netlist por expansión indiscriminada | Presupuestos por tamaño/profundidad y selección explícita de detalle; expansión visual independiente. |
| Información incompleta o restricciones de ROM | M0 verifica fuentes y condiciones; frena M5, no oculta el problema con stubs. |
| Semántica ISA/CSRs específica del C3 | Perfil documentado, corpus arquitectónico y contraste físico antes de IDF. |
| Coste TypeScript o comunicación con solver | Medir M1/M4; optimizar lotes y memoria preservando contratos; reevaluar estrategia en un ADR si no alcanza. |
| Boot parece requerir muchos bloques adicionales | Trazar accesos y sumar contratos; no resolverlo devolviendo ceros de forma genérica. |
| Radio o Xtensa excede información/recursos disponibles | Hitos de investigación separados; conservar backend previo para las capacidades pendientes. |
| Errores comunes entre modelo y pruebas | Oráculo independiente y medición física; los tests generados de una tabla no son evidencia suficiente. |
| Tiempo funcional confundido con ciclos reales | Etiquetar estrategia y calibración; métricas/tolerancias separadas. |
| Integración altera circuitos AVR o ESP actuales | Caracterización y regresión por contrato; promoción individual por placa. |
| Pérdida de datos por reset/migración | Políticas de retención, persistencia atómica y pruebas sobre copias. |

P0 debe fijar contratos comunes, adaptación del formato actual, identidad/versionado, semántica
de puertos, representación física/activa, alcance de importación y presupuestos de jerarquía.
P1/P2 validan elaboración, propiedad de efectos y tiempo compartido; P3 fija transacciones de edición.

Decisiones que M0 debe cerrar con evidencia: revisión exacta de C3 y placa física disponible; ROM
obtenible y condiciones; perfil ISA/CSRs; imagen IDF por digest; firmware y proyectos de referencia;
presupuestos en equipo identificado. M1 adapta CPU y pads al contrato temporal fijado en P2. M10 fija
estrategia de conectividad. M12 necesita su propio anexo Xtensa antes de implementar esa CPU.
No se delegan estas decisiones a valores por defecto sin procedencia.

## 12. Definición de terminado

**Plataforma base:** H0–H3 del piloto sin MCU, edición/guardado/exportación trazables, equivalencia
con plano, representación activa sin doble conteo, límites de detalle y migración de catálogo.
El núcleo común no depende de ESP32. La integración M4 amplía esa evidencia al firmware real.

**Por bloque:** ficha + implementación TypeScript + pruebas que detectan defectos + reset/errores +
evidencia y límites. **Por hito:** todos sus requisitos y casos pasan, incluida prueba en la app con
firmware corriendo cuando tenga un recorrido visible. Tests por separado no cierran M4/M7/M8.

Las verificaciones previstas para PRs de implementación son: tests afectados y suite de regresión,
typecheck server/shared/web y modelos según cambios, build y E2E del recorrido.
Cambios en rutas requieren arranque real del servidor y único registro por método/ruta. Toda
simulación `resuelto:false` falla también en smoke/importación/`soloValidar`. Evidencia debe separar
pasados, fallidos, omitidos y no ejecutados; un skip de hardware nunca cuenta como validación física.

**Primera integración ESP32:** composición de placa y SoC reutiliza contratos comunes, admite
inspección jerárquica y cambios eléctricos efectivos; firmware verifica las consecuencias.

**Sustitución total:** plataforma base aceptada y corpus inventariado cubierto en C3/C6/S3 y lenguajes/funciones actuales,
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
