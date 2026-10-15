# Motor eléctrico: DC vivo y análisis transitorio de diseño

Actualizado el **4 de octubre de 2026**. Esta guía describe el camino activo y sus límites. La [auditoría](../AUDITORIA-FIDELIDAD-ELECTRONICA.md) conserva los defectos de la base anterior; el [plan de fidelidad](PLAN-FIDELIDAD-FISICA.md) define los requisitos y la evidencia pendiente.

La aplicación resuelve una **red global de equivalentes eléctricos** mediante ngspice, compilado a WebAssembly por `eecircuit-engine`. Sustituye el cálculo antiguo por caminos aislados: puede resolver mallas, ramas, referencias distintas y dispositivos no lineales dentro de los modelos disponibles. No reproduce toda la física de un montaje real ni acredita precisión de hardware por resolver correctamente sus ecuaciones.

## Alcance del análisis

El circuito que acompaña al firmware ejecuta **`.op`: punto de operación de continua**. En este régimen un capacitor ideal no conduce en estado estacionario y un inductor ideal tiene caída DC nula. La API de diseño añade **`.tran`** con condiciones iniciales y trazas RC/RL/RLC, manteniendo GPIO/topología fijos: todavía no es una co-simulación temporal del firmware. `.ac` y `.noise` siguen fuera del camino integrado. Véase [análisis temporal, ADC y evidencia](ANALISIS-TEMPORAL-Y-EVIDENCIA.md). El [manual oficial ngspice](https://ngspice.sourceforge.io/docs/ngspice-manual.pdf) describe los modos; su versión no identifica automáticamente la del WASM instalado.

El SDK expone R, C, L, D, V, I, S, SV y REG. Las ecuaciones de las primitivas son el equivalente matemático seleccionado; sus **parámetros no son universales**. Consumo del chip, resistencia de pad, pulls, Vf/ruptura del LED y dropout pueden ser valores genéricos o típicos. Un modelo de LED ajustado a Vf nominal no es una curva caracterizada de cualquier LED de ese color.

| Fenómeno | Representación actual y límite |
|---|---|
| Ohm, redes resistivas, KCL/KVL | Resolución nodal global; válido para la topología y parámetros modelados. |
| Potencia DC | Convención pasiva: `P=(Va−Vb)·I`; positiva absorbe, negativa entrega. El DC vivo no integra temperatura. |
| Transitorio de diseño | `.tran` de topología fija, condiciones iniciales, fuentes PWL y trazas V/I/P. Pruebas RC/RL/RLC; separado del firmware. |
| Térmica opcional | Cuerpo RC isotermo con parámetros declarados y potencia de R/S de una traza; sin realimentación eléctrica ni averías. |
| Diodos/LEDs | Curva no lineal con polaridad y parámetros del modelo; no certifica brillo, ruptura ni tiempo de avería de un número de parte no identificado. |
| Fuente CV/CC | Equivalente estático limitado; no representa dinámica del lazo, overshoot ni todas las características source/sink de una fuente física. |
| Regulador | Equivalente de caída/límite y consumo propio; los parámetros proceden del descriptor. No implica comportamiento térmico o transitorio del regulador real. |
| GPIO | Push-pull/open-drain/pulls y clamps según información disponible. Source/sink, drive y límites dependen del descriptor y siguen siendo aproximaciones. |
| Brownout | Retira salidas y conserva el diagnóstico de la carga que hizo caer el riel. No simula duración, histéresis ni oscilación temporal de reinicios. |
| USB | Fuente con límite declarado por placa; no simula tiempo de disparo, recuperación ni temperatura de un PPTC. |
| Sobrecarga | Aviso de riesgo o violación del rango modelado. No equivale a una avería permanente. |

El riel 3V3 del Uno R3 utiliza el límite específico de **50 mA publicado por Arduino**, sin heredar el límite genérico de un DevKit ESP32. Esto no acredita una curva exacta de limitación del regulador. Véase [pinout oficial Uno R3](https://content.arduino.cc/assets/Pinout-UNOrev3_latest.pdf).

## Arquitectura

```text
proyecto + catálogo + controles + estado GPIO disponible
  → topología: terminales/pads, alias, islas y referencias
  → modelos de módulos y placa: primitivas del equivalente
  → netlist: .op, vectores y ramas de medición
  → worker supervisado: ngspice WASM
  → validación numérica, observación de módulos y diagnóstico
  → API/MCP/firmware y representación visual
```

| Archivo | Responsabilidad |
|---|---|
| [analisis.ts](../app/server/src/sim/analisis.ts) | Orquesta red global, alimentación por placa, entradas y observación. Publica `resuelto`. |
| [conectividadDc.ts](../app/server/src/sim/conectividadDc.ts) | Referencias conductivas DC; una C o una R hacia extremo suelto no justifican por sí solas un nivel digital. |
| [placa.ts](../app/server/src/sim/placa.ts) | Traduce alimentación y GPIO del descriptor a equivalentes. |
| [modelos.ts](../app/server/src/sim/modelos.ts), [sandbox.ts](../app/server/src/sim/sandbox.ts) | Modelo del catálogo y ejecución aislada; fallo de modelo no se convierte silenciosamente en una carga omitida válida. El sandbox no certifica fidelidad de parámetros. |
| [netlist.ts](../app/server/src/sim/netlist.ts), [validacionSpice.ts](../app/server/src/sim/validacionSpice.ts) | Netlist, signos, vectores completos/finitos y clasificación de errores. |
| [conservacion.ts](../app/server/src/sim/conservacion.ts) | Gate de KCL y balance de potencia DC sobre los elementos resueltos. |
| [spice.ts](../app/server/src/sim/spice.ts), [spiceWorker.ts](../app/server/src/sim/spiceWorker.ts), [colaWorker.ts](../app/server/src/sim/colaWorker.ts) | Adaptador ngspice, worker terminable y cola acotada. |
| [estadoAlimentacion.ts](../app/server/src/estadoAlimentacion.ts), [pararPlacasSinEnergia.ts](../app/server/src/pararPlacasSinEnergia.ts) | Diagnóstico de alimentación y política de ejecución por placa. |

`solver.ts`/`circuitNetwork.ts` forman un solver independiente para contraste; no seleccionan el motor activo de la aplicación. El catálogo conserva modelos legacy `model.js`; toda fuente nueva o modificada debe seguir el requisito TypeScript de `AGENTS.md`, con conversión del JavaScript existente si se modifica.

### Referencia, alias y regularización

Los alias de un mismo GPIO físico se normalizan antes de unir la red, evitando que A4 y SDA del Uno reciban drivers separados según el orden de los cables. Las tensiones se interpretan respecto de su referencia; una tierra dibujada cerca de otra no las une eléctricamente.

El netlist usa fugas de regularización muy pequeñas y opciones de convergencia. **No representan aislamiento físico, una resistencia medida ni un camino que garantice una entrada digital**. El análisis distingue nodo flotante de lectura definida; las diferencias internas de una isla y la referencia elegida deben interpretarse por separado.

## Cuándo se acepta un resultado

`electrico.resuelto === true` indica que el equivalente pudo resolverse con los controles aplicados. Un vector faltante, NaN/Infinity, error fatal, modelo roto o residuo excesivo no se sustituye por cero. Solo la referencia explícita del solver se define deliberadamente como 0 V.

El gate DC comprueba los presupuestos numéricos heredados de las pruebas:

- Por nodo: `abs(ΣI) ≤ 1 µA + 0,1 %·Σabs(I)`.
- Balance de potencia: `abs(ΣP) ≤ 1 nW + 0,1 %·Σabs(P)`.

Estos límites permiten detectar incoherencias del **equivalente resuelto**; no son tolerancia del componente, incertidumbre de instrumento ni precisión física universal. Tampoco certifican fenómenos ausentes. Puede haber terminales sin representación eléctrica completa: sus avisos y alcance siguen siendo necesarios aunque el subconjunto resuelto sea consistente.

Un fallo devuelve `resuelto:false` y diagnóstico, sin medidas inventadas. Editor y visor exigen la señal de resultado resuelto; ante error invalidan la observación anterior. Al cambiar/cerrar proyecto se limpian las medidas anteriores y se descartan respuestas pendientes del contexto viejo. No confundir “no hay medición válida” con “el circuito está sano” o “no circula corriente”.

### Worker, límites y recuperación

ngspice se ejecuta en **un worker**, fuera del hilo principal del servidor. El arranque/importación dispone de hasta **20 s**; después de `listo`, cada cálculo dispone de hasta **5 s**. Al vencer el límite o fallar el worker, el supervisor solicita su terminación y espera que termine antes de avanzar la cola; el siguiente trabajo puede crear otra instancia.

Hay una tarea activa como máximo. La capacidad configurada es **32 trabajos admitidos, contando el activo**, según el contador de `ColaWorker`; al alcanzar ese límite se rechazan nuevas solicitudes. El tiempo de espera en cola no está incluido en los 5 s de cálculo y estos valores no prometen una latencia total fija de la API.

Los límites de recursos V8 del worker **no acotan toda la memoria externa de WebAssembly ni imponen una cuota CPU del sistema operativo**. El aislamiento/cancelación mejora la recuperación, pero no autoriza cargas arbitrarias ni reemplaza límites de tamaño/pasos o supervisión de recursos. Esta guía no reproduce estimaciones antiguas de milisegundos como garantía de rendimiento actual.

## GPIO, entradas, sensores y firmware

Las consultas vivas usan `nivelesReales:true`: si no hay un nivel recibido para una salida, **no se presupone HIGH**. Sin firmware o antes del primer evento, la salida no recibe un driver alto inventado. Los escenarios forzados del motor quedan separados del camino de medidas vivas.

El modo/dirección/pull sigue dependiendo parcialmente de `pinScan` y de inferencias del código/catálogo. El scanner no acredita orden real de ejecución, modos pasados por variables, `Pin.init`, DDR u otras reconfiguraciones runtime completas. Open-drain alto libera el driver de salida; sus pulls y clamps se consideran aparte. La captura runtime completa sigue pendiente.

Las entradas se clasifican con VIL/VIH del descriptor y la tensión del riel. Una entrada flotante o en la franja no garantizada conserva nivel indefinido. El puente evita enviar ese nivel y retiene la lectura anterior por **política de software**: no simula histéresis Schmitt, ruido ni metastabilidad del pad.

El sensado se agrupa con una demora de **50 ms** después del trabajo activo y mantiene como máximo un grupo pendiente. Esto acota solicitudes; **no captura necesariamente todos los flancos**. Polling AVR/MicroPython y la red externa todavía no forman una co-simulación analógica por eventos con reloj compartido. PWM, pulsos cortos, fase y energía por ciclo no están acreditados.

La alimentación calculada se propaga a chips durante la ejecución; su transición y registros siguen el alcance del backend/modelo. I2C/SPI funcionales y firmware precompilado prueban bytes, registros y ciertos tiempos, no capacitancia de bus, umbrales por bit, arbitraje eléctrico universal ni contención analógica. El ADC ideal del Uno recibe el snapshot DC resuelto y sus referencias; una entrada desconocida no produce cero ficticio. No representa adquisición, ruido ni ADC de ESP32. Véase el contrato y las pruebas en [análisis temporal](ANALISIS-TEMPORAL-Y-EVIDENCIA.md).

La política de parada aplica los diagnósticos a **cada placa correspondiente**; no interpreta que una placa independiente deba perder energía porque otra falla. Es una decisión del entorno de emulación, no un modelo térmico ni una garantía de seguridad del montaje.

## Una observación viva por consulta

`GET /api/projects/:nombre/pins` obtiene una observación DC viva para LEDs, fuentes, tensiones, medidas, alimentación y avisos. Ya no mezcla resultados de todas-las-salidas-altas y todas-las-salidas-bajas ni los denomina “peor caso”. Esa observación puede requerir pasadas internas para alimentación/brownout y cálculos auxiliares de demanda de fuentes: **no implica una sola ejecución SPICE total**.

`mA` es la corriente viva del LED. El campo legacy **`mAFijo` ahora es un alias de `mA`**, conservado por compatibilidad: no significa corriente independiente del firmware ni escenario con todas las salidas bajas.

El estado que devuelve un modelo se conserva desde la observación viva. Editor y visor usan la corriente/observación resuelta, sin exigir que corra firmware para encender un LED alimentado físicamente por USB o una fuente. Consultas separadas del editor/visor pueden recalcular la red: aún no hay un contrato global de snapshotId/tiempo compartido que garantice identidad temporal entre clientes.

### Riesgo no equivale a daño

Los LEDs con sobrecorriente muestran riesgo y conservan la conducción del modelo. **No quedan apagados permanentemente por una marca visual ni se exige reemplazarlos para recuperar el indicador.** La temperatura, tiempo hasta fallo y topología de avería no se simulan.

La alimentación fuera de rango también informa riesgo e impide ejecución según su diagnóstico. El enum legacy `quema` no demuestra destrucción; `quemada:false` permanece por compatibilidad y **no hay latch de avería permanente**. Corregido el circuito se vuelve a evaluar el estado actual.

Avisos/modelos genéricos pueden emplear umbrales configurados: no deben interpretarse como máximos garantizados o curvas de daño de un componente no identificado. Las etiquetas de peligro/riesgo son diagnósticos del modelo y la política de ejecución, no una certificación de hardware.

## Verificación y evidencia

Las suites existentes incluyen fórmulas independientes, redes resistivas, fuentes/reguladores, alias, flotación, brownout, open-drain, entradas y varias placas. El contraste MNA/ngspice detecta discrepancias de ecuaciones, pero ambos pueden compartir parámetros genéricos.

| Suites | Alcance de su evidencia |
|---|---|
| `sim/motor.test.ts`, `sim/regulador.test.ts`, `sim/comparacion.test.ts`, `sim/multiplaca.test.ts` | Redes y equivalentes DC; no transitorios ni exactitud de hardware completo. |
| `sim/fidelidad.test.ts`, `sim/placa-descriptor.test.ts`, `sim/instantanea-real.test.ts` | Regresiones de topología, alimentación, modos y estado vivo. |
| `sim/netlist-resultados.test.ts`, `sim/validacionSpice.test.ts`, `sim/conservacion.test.ts` | Vectores ausentes/no finitos, errores y consistencia numérica. |
| `sim/colaWorker.test.ts` | Plazos de arranque/cálculo, interrupción controlada y recuperación; no cuota total de memoria WASM. |
| `sim/sandbox.test.ts`, `sim/modelos-fidelidad.test.ts`, `moduleImporter.test.ts` | Contratos/errores de modelos e importación; no certificación de física de cada modelo. |
| `bus/*`, `avrSim.test.ts`, `pinScan.test.ts` | Periféricos/firmware/scanner dentro de su perfil; no integridad eléctrica universal del bus. |
| `tests/unit/estado-electrico.test.ts` | Indicador vivo, riesgo separado e invalidación de lectura; no sustituye una prueba de interacción en navegador. |

**Evidencia histórica:** la versión anterior de esta guía registraba 332 pruebas unitarias y 43 e2e y observaciones manuales. Esos resultados corresponden a aquella entrega; algunas comprobaciones de “quemadura permanente” describían un comportamiento visual retirado. La auditoría posterior registra sus propios comandos y 304 pruebas existentes, además de reproducciones adversariales. Ninguno de esos totales es el resultado final de esta actualización.

El informe de entrega del [plan de fidelidad](PLAN-FIDELIDAD-FISICA.md) registra comandos, versiones, aprobados/fallidos/omitidos y límites de cobertura. No se afirma validación de navegador. **El baseline de laboratorio sigue pendiente**: faltan partes/revisiones identificadas, instrumentos, condiciones e incertidumbre para acreditar exactitud física. El verificador de registros de medición valida declaraciones, no autentica instrumentos ni certifica exactitud.

## Límites honestos

- El vivo permanece DC. `.tran` y térmica de diseño no ejecutan firmware ni sustituyen el reloj físico común que falta. AC, ruido general, rebote, PWM energético y térmica calibrada por parte siguen pendientes.
- Modelos concretos limitados y parámetros parcialmente genéricos; un símbolo visual no garantiza una representación completa del dispositivo.
- Sin modelo calibrado de avería permanente, latch-up, envejecimiento, protección térmica o batería electroquímica.
- Firmware/entradas/buses no comparten aún una co-simulación física temporal completa; inyecciones directas son herramientas de prueba, no medidas del nodo.
- Cables mayormente ideales: sin geometría eléctrica, propagación, EMI, RF de canal, aislamiento/arcos o seguridad de montaje acreditados.
- Resolver el equivalente y pasar gates numéricos no acredita lo ausente ni elimina incertidumbre de parámetros. La fidelidad se declara por fenómeno, perfil, condiciones y evidencia.

## Documentos relacionados

- [Auditoría de fidelidad](../AUDITORIA-FIDELIDAD-ELECTRONICA.md) y [plan físico](PLAN-FIDELIDAD-FISICA.md): baseline, hallazgos, criterios y pendientes.
- [Módulos y su código](modulos-y-su-codigo.md): contratos del SDK; contrastar cualquier afirmación histórica con el alcance actual.
- [Fuentes de alimentación](fuentes-de-alimentacion.md): controles y configuración de energía.
- [Formato del catálogo](../modules/README.md) y [chips](../chips/README.md).
- [Diseño de circuito libre](../SDD-CIRCUITO-LIBRE.md): solver independiente y antecedentes.
- [Convenciones](../CLAUDE.md): TypeScript, pruebas, componentes propios y adaptadores.
