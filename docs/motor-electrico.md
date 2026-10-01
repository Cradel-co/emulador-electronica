# Motor eléctrico: física real con ngspice

> Pedido del usuario el 2026-09-30: "que el server tenga un motor de cómo funciona en la
> vida real la energía y la electrónica; un simulador real". Decisiones: **ngspice** como
> motor y el código de cada módulo en **JavaScript**. Reemplaza al cálculo anterior
> (`circuitPhysics.ts`, borrado).

## Por qué un motor nuevo

El cálculo anterior recorría caminos "desde una fuente hasta GND" sumando resistencias y
caídas fijas. Alcanzaba para "LED + resistencia a un GPIO", pero se rompía con lo que
aparece en cuanto el circuito crece:

| Caso real | Antes | Ahora |
|---|---|---|
| Mallas: puente de Wheatstone, divisores cruzados, dos fuentes sin GND común en el medio | No se resolvían | Se resuelven (análisis nodal completo) |
| LED al revés | Conducía igual (sin polaridad) | No conduce; pasados los 5 V en inversa, avisa que se daña |
| LED: caída de tensión | Fija (2 V) | Curva real de diodo (exponencial): la caída sube con la corriente |
| Varias ramas en una fuente en modo CC | Tensión aproximada | Exacta: la fuente baja hasta lo que la carga permite |
| Módulos activos (relé, transmisor RF) | No consumían nada | Consumen lo de su hoja de datos, y el relé no "pega" sin tensión suficiente |
| Módulos nuevos | Solo con flags (`diode`, `passthrough`) | Con su propio código: cualquier circuito de elementos físicos |

La idea central: **el motor no tiene reglas por componente**. Cada módulo se describe con
elementos físicos (resistencias, diodos, fuentes, interruptores...) y ngspice, el
simulador de circuitos de referencia de la industria, resuelve todo el circuito junto.
Las leyes no las implementa cada módulo: las pone el motor, y un módulo no las puede
romper.

## Las leyes que respeta (y cómo)

| Ley / fenómeno | Cómo se cumple | Dónde se verifica |
|---|---|---|
| **Ley de Ohm** (V = I·R) | Cada resistencia es un elemento `R` de SPICE. | Divisor, serie, paralelo, 40 redes al azar contra una resolución propia. |
| **Kirchhoff de corrientes** (lo que entra a un nodo, sale) | Es la base del análisis nodal modificado de ngspice. | **En todos los tests**: se suma la corriente de cada elemento en cada nodo; tiene que dar 0. |
| **Kirchhoff de tensiones** (la suma de caídas en una malla es 0) | Idem: las tensiones de nodo son únicas. | Circuito serie, mallas, puentes. |
| **Conservación de la energía** (lo que entregan las fuentes = lo que disipan las cargas) | Todo elemento que entrega energía es una fuente explícita; los reguladores sacan de su entrada lo que entregan. | **En todos los tests**: la suma de potencias de todos los elementos tiene que dar 0. |
| **Superposición / Millman** | Consecuencia de la linealidad del análisis. | Dos fuentes distintas en paralelo con resistencias. |
| **Fuentes reales (Thévenin)** | Ninguna fuente es ideal: resistencia serie mínima de 1 mΩ; un pin de salida tiene su resistencia interna (`pinOutputOhm` de la placa: ~33 Ω en un ESP32). | LED directo a un GPIO: la corriente la limita el pin. |
| **Ecuación del diodo (Shockley)** I = Is·(e^(V/(n·Vt)) − 1) | Los LEDs son diodos de verdad: Is calculada para que a 20 mA caiga el Vf del color (≈2 V rojo, ≈3 V azul), n = 2, Rs = 2 Ω, Vt a 27 °C. | Vf por color, crecimiento exponencial, dos LEDs de distinto color en paralelo (el rojo se lleva casi todo). |
| **Ruptura inversa** | Los LEDs tienen BV = 5 V (hoja de datos típica). | LED al revés con 3 V (nada), 5 V (al límite) y 9 V (se daña). |
| **Fuente de laboratorio CV/CC** | Canal con tensión y límite de corriente: si la carga pide más, entrega el límite y la tensión baja (modo CC). | CV, CC con su "demanda", corto, apagada, de −12 a +12 V. |
| **Regulador lineal** | Vout = min(Vnom, Vin − caída mínima), con límite de corriente, y la corriente que entrega la saca de su entrada (disipa (Vin − Vout)·I). | Dropout del LDO con 3,5 V, el regulador de VIN del Uno con 6/9/12 V. |
| **Brownout** | El chip consume su corriente típica mientras su riel está por encima de 0,8 × su tensión lógica; por debajo se resetea. | Fuente limitada a 50 mA alimentando un ESP32 (pide ~120). |
| **Diodos de protección de los GPIO** | Cada GPIO cableado tiene diodos al riel y a GND, aunque el chip esté apagado. | 5 V metidos a un pin de un ESP32 de 3,3 V: avisa la corriente que inyecta. |
| **Polifusible del USB** | El USB entrega hasta 500 mA y solo entrega (no absorbe). | Placa por USB; 3V3 en corto: el USB no da abasto. |
| **Potencia nominal de una resistencia** | 1/4 W: por encima se calienta, con más del doble se quema. | Resistencia chica sobre 12 V. |
| **Aislación** | Cada nodo tiene 1 TΩ a tierra: un módulo sin cablear o un circuito flotante queda definido en vez de dar error. | Circuito vacío, módulos sueltos, LED solo. |

Lo que **no** modela todavía está al final, en [Límites](#límites-honestos).

## Arquitectura

```
proyecto (módulos + cables)
        │
        ▼
 sim/analisis.ts  ── une los cables (union-find) → nodos; decide la tierra
        │
        ├── por cada módulo: sim/modelos.ts → su model.js en el sandbox (sim/sandbox.ts)
        │                                     o el modelo armado con sus flags
        │      └─ devuelve elementos físicos (R, C, L, D, V, I, S, SV)
        ├── la placa: sim/placa.ts (USB, reguladores, chip, GPIO, diodos de protección)
        │
        ▼
 sim/netlist.ts  ── arma el netlist SPICE (con amperímetros para medir cada elemento)
        │
        ▼
 sim/spice.ts    ── ngspice compilado a WebAssembly (eecircuit-engine), análisis .op
        │
        ▼
 sim/analisis.ts ── lee tensiones y corrientes; cada modelo "observa" su resultado;
                    arma LEDs, fuentes, alimentación de la placa y avisos
```

| Archivo (`app/server/src/sim/`) | Qué hace |
|---|---|
| `spice.ts` | Corre ngspice (WASM, en el mismo proceso). Cola de a uno, 5 s de tiempo máximo (si ngspice no converge, se descarta la instancia y se crea otra). Arranca en ~0,7 s; cada cálculo tarda ~2–4 ms. |
| `netlist.ts` | Convierte elementos a SPICE. Cada elemento que no es una resistencia lleva un amperímetro en serie (fuente de 0 V) para medir su corriente. Convención: la corriente de un elemento es la que **entra por su terminal `a`**; la potencia es (Va − Vb)·I (positiva = disipa, negativa = entrega). |
| `sandbox.ts` | Corre el `model.js` de cada módulo aislado (ver [módulos y su código](modulos-y-su-codigo.md)). |
| `modelos.ts` | Elige el modelo de cada tipo: su `model.js` o, si no tiene, uno armado con los flags del module.json (`source`, `passthrough`, `diode`, `switch`). Si el `model.js` está roto, usa el de los flags y avisa. |
| `placa.ts` | Modelo eléctrico de la placa armado desde su descriptor (`board.power`, `logicVoltage`, `pinOutputOhm`): código del server, de confianza. |
| `analisis.ts` | Orquesta todo: nodos, rieles, tierra, pasadas, brownout, lecturas, avisos. |
| `tipos.ts` | Tipos de lo que devuelve (LEDs, fuentes, alimentación, avisos). |

### La tierra

ngspice necesita un nodo de referencia. Con placa, es el GND de la placa; sin placa, el GND
de la primera fuente regulable. Las demás tensiones son relativas a ese punto (como mide
un tester con la punta negra ahí). Una fuente cuyo GND no está unido al resto queda
"flotando" (los 1 TΩ de aislación la definen) y no cierra circuito: igual que en la mesa.

### La placa

`armarPlaca()` traduce el descriptor de la placa a elementos:

| Parte | Modelo |
|---|---|
| USB (si "USB conectado") | Fuente de 5 V, hasta 500 mA, solo entrega. |
| VIN (Arduino Uno) | Regulador lineal a 5 V, caída mínima 1 V, hasta 1 A. |
| LDO de 3,3 V | Regulador desde el riel de 5 V, caída 0,3 V, hasta 600 mA, más ~5 mA propios. |
| El chip | Consume `power.currentMa` de su riel lógico; por debajo del brownout el consumo cae (se está reseteando). |
| Cada GPIO cableado | Diodos de protección al riel y a GND. Con el chip andando: salida push-pull (resistencia `pinOutputOhm` al riel o a GND) o pull-up de 45 kΩ si el firmware lo pide. Un pin que no es salida queda en alta impedancia. |

El brownout se resuelve en dos pasadas: primero con el chip andando; si su riel queda
por debajo del umbral, se recalcula con el chip apagado (se resetea, como uno real).

### Tres cálculos por proyecto

`GET /api/projects/:nombre/pins` corre el motor hasta tres veces (~10 ms en total):

| Cálculo | Para qué |
|---|---|
| **vivo** | Con los niveles reales de la simulación y los pulsadores como están: avisos, consumo de cada fuente, alimentación de la placa, lo que muestra cada módulo (`electrico.modulos`), tensiones de cada pin (`electrico.tensiones`). |
| **peor caso** | Todas las salidas del firmware en alto: la corriente de cada LED si su pin se prende (la UI lo "quema" si la simulación lo prende así). |
| **fijo** | Todas las salidas en bajo: la corriente que le llega a cada LED sin depender del código (`mAFijo`: un LED en un circuito con pulsador y fuente). |

Sin placa alcanza con el primero. El estado interno que cada modelo devuelve (`estado`) se
guarda del cálculo vivo y vuelve en el siguiente; se borra al energizar o apagar.

### Lo que se ve

- **Avisos** (`#avisos-dibujo`, panel Problemas, MCP `ver_proyecto`): cortocircuitos (con
  los dos puntos en corto, para la animación), LED que se quema o sobreexigido, pin por
  encima de su corriente, tensión de afuera en un pin, fuente en modo CC, riel en corto,
  placa fuera de especificación, y los avisos propios de cada modelo.
- **Fuentes**: ajuste, salida real, mA, W, modo (CV, CC, corto, apagada) y lo que pediría la
  carga sin límite.
- **Instantánea de depuración** (`GET /api/debug/snapshot`, y la tool MCP de instantánea):
  bloque `electrico` con la tensión de cada pin y la corriente/potencia de cada elemento
  físico, como lo mediría un tester. La ventana Debug muestra la alimentación y las fuentes.
- Los cambios de estado físico (un pulsador apretado desde el MCP) llegan a todas las
  pestañas (`project.changed` con `what: "electrico"`): recalculan sin recargar el dibujo.

## Cómo se verificó

Todo con tests automáticos que comparan contra la fórmula, no contra "lo que da":

| Suite | Qué cubre |
|---|---|
| `sim/motor.test.ts` (46) | Leyes (Ohm, serie, paralelo, Wheatstone balanceado y desbalanceado, fuentes en serie, Millman, fuente negativa, **40 redes de resistencias al azar** contra un análisis nodal propio resuelto por Gauss), fuente CV/CC/corto/apagada/rango, LEDs (corriente con 220 Ω, Vf por color, curva exponencial, inversa, quemado vs. protegido por la fuente, paralelo de colores, serie), interruptores, placa (USB, sin energía, fuente en 5V, sin GND común, por 3V3, brownout, dropout, sobretensión, polaridad invertida, 3V3 en corto, Arduino por VIN), pines (pull-up, corto a GND, LED directo, inyección de 5 V, alta impedancia), módulos activos (relé, relé con 3,3 V, RXB6, STX882), robustez y tiempo. **En cada caso** se exige Kirchhoff en todos los nodos y la conservación de la energía. |
| `sim/sandbox.test.ts` (51) | Aislamiento y seguridad del código de los módulos (ver la otra guía), modelos rotos dentro del motor, memoria (`estado`). |
| `moduleImporter.test.ts` | Importar módulos con código: se instala el modelo, y uno roto se rechaza antes de instalarlo. |
| e2e (Playwright, 43) | La UI con el motor nuevo: avisos de Ley de Ohm, LED quemado, cortos, circuitos sin placa. |

Además se probó a mano contra la app corriendo: circuito sin placa (pulsador → LED →
220 Ω, 13,8 mA al apretar: (5 − 1,97) / 220), corto directo, LED sin resistencia con la
fuente a 100 mA (se quema) y a 15 mA (la fuente lo protege), LED al revés, relé
alimentado por una fuente (75 mA: 71 de la bobina + 4 de la base, y su "ON" prendido).

Resultado de la última corrida: 332 tests unitarios y 43 e2e, todos verdes.

## Límites honestos

- **Solo continua (punto de operación).** Los capacitores son circuitos abiertos y las
  bobinas, cables: todavía no hay tiempo (cargas, rebotes, PWM, el clic del relé). El
  SDK ya acepta capacitores e inductores; el análisis transitorio es la siguiente fase.
- **El firmware ve niveles digitales.** El motor sabe si un pin está en alto o en bajo,
  pero lo que el firmware **lee** (una entrada, el ADC) todavía no sale del motor.
- **Sin temperatura ni daño acumulado.** "Se quema" es un umbral de hoja de datos, no un
  modelo térmico; un LED quemado lo recuerda la UI, una placa quemada el server.
- **Valores típicos.** Consumos, Vf, caídas de reguladores y resistencias de pin son de
  hojas de datos, no de una unidad en particular.
- **Precisión de las fuentes.** Una fuente regulada tiene unos pocos mV de error con
  carga (como una de banco real), por cómo se modela el modo CV/CC.
- **Convergencia.** Puntos muy no lineales (una fuente en CC que hace resetear la placa,
  un riel en corto) los resuelve ngspice con sus métodos de respaldo (gmin/source
  stepping); si no converge en 5 s, el proyecto muestra "No se pudo resolver el circuito
  eléctrico" en vez de colgarse.

## Documentos relacionados

- [`modulos-y-su-codigo.md`](modulos-y-su-codigo.md) — cómo se describe un módulo, el SDK
  de su código y cómo crear uno nuevo.
- [`fuentes-de-alimentacion.md`](fuentes-de-alimentacion.md) — la fuente regulable, la
  energía de la placa, los circuitos sin placa.
- [`../modules/README.md`](../modules/README.md) — formato de módulo e importación.
