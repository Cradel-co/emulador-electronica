# Módulos completos: emulados, probados y fabricables

> Pedido del usuario el 2026-10-01: que cada módulo tenga su esquemático (para exportar el del
> proyecto entero, listo para mandar a construir), sus propios tests y sus propias reglas, y todo
> lo necesario para emularlo completo, pensando en módulos reales y electrónica compleja. Que un
> programador pueda crear un módulo nuevo basado en algo de la vida real. "Mañana" es un decir:
> la idea es que **si se crea o se inventa un módulo nuevo, se pueda implementar acá**, aunque no
> exista en ningún catálogo ni librería. Tiene que ser robusto pero fácil de implementar.
>
> Estado: **parcialmente implementado (2026-10-01)**: chips con lógica en el I2C del Uno, cinco
> chips reales y cuatro módulos, `ctx.regulador` y `ctx.bateria`, librerías de Arduino. Qué se
> hizo, en qué se apartó del diseño y qué se aprendió: sección 8. El resto sigue siendo diseño.

## Qué falta hoy

Un módulo (`modules/<tipo>/`) tiene `module.json` (identidad, pines, props), `module.svg`
(dibujo) y `model.js` (circuito interno con elementos físicos, más `observar()` con los avisos;
ver [`docs/modulos-y-su-codigo.md`](docs/modulos-y-su-codigo.md)). Le faltan cuatro cosas:

1. **Esquemático propio**, para que la función "exportar esquemático del proyecto" saque todo
   listo para fabricar (KiCad → PCB → Gerber + BOM). Secciones 1 y 2.
2. **Reglas declarativas**. Hoy las reglas están mezcladas en `observar()` en JS. Sección 3.
3. **Tests propios**, para que el módulo pruebe que se comporta como su hoja de datos. Sección 4.
4. **Comportamiento más allá de lo eléctrico**: hablar I2C/SPI/UART, medir el entorno, mostrar una
   pantalla o mover un motor, con sus tiempos, consumos y ruido. Sin esto, un sensor o una
   pantalla solo consumen corriente. Sección 5.

Formato elegido: **declarativo (JSON) para lo común, y código JS opcional para lo raro**.

## Principio: fácil para algo recién inventado

Un módulo nuevo o inventado no tiene símbolo de KiCad, modelo SPICE, librería ni chip conocido.
Por eso (ver también la sección 7):

- **Lo único obligatorio sigue siendo lo de hoy**: `module.json` con sus pines. Todo lo nuevo es
  opcional, y cuando falta, la app genera algo que sirve igual:

  | Si falta… | Se usa… |
  |---|---|
  | `esquematico.simbolo` | Una **caja con sus pines** (como un chip genérico), con el nombre y el `kind` de cada pin. |
  | `esquematico.huella` | Una **tira de pines de 2,54 mm**, en el orden del module.json. Así se conecta casi cualquier módulo nuevo. |
  | `parte` | Una línea de la lista de materiales con el nombre del módulo y "MPN a completar". |
  | `tests.json` | **Tests automáticos**: el modelo carga, con su tensión típica no hay NaN ni corto, no se queman sus propios elementos. |
  | `comportamiento.js` / `registros.json` | El módulo es solo eléctrico, como hoy. |
  | `entorno`, `salidas` | Sin controles deslizantes; el dibujo usa `ui.on` y `ui.brillo`. |
  | `tiempos`, `modos`, `precision` | Respuesta instantánea, un solo consumo, lecturas exactas. |

- **Nivel de soporte**, igual que las placas (emula / compila / solo-dibujo). Cada módulo muestra
  qué tan completo está y qué le falta para subir. Son dos ejes independientes:

  | Eje | Niveles |
  |---|---|
  | Emulación | `dibujo` → `electrico` (tiene `model.js`) → `funcional` (tiene comportamiento, entorno y salidas si los necesita) → `certificado` (su ejemplo compila, se emula y da lo esperado) |
  | Fabricación | `generico` (caja y tira de pines) → `identificado` (tiene `parte`) → `fabricable` (símbolo, huella y BOM reales) |

  Aparte, `probado` es una marca: tiene tests propios y pasan. Un módulo puede ser `certificado`
  y `generico` (se emula perfecto pero no se sabe qué comprar), o al revés.

  Se exporta siempre, pero el exportador avisa qué partes son genéricas.
- **Nada de lenguaje nuevo**: los tests y las reglas usan los nombres que ya existen (pines del
  module.json, nodos internos y elementos de `model.js`, `severidad`).
- **La IA lo arma desde la hoja de datos**: `crear_modulo` (MCP) recibe nombre, pines y valores de
  la hoja de datos, y genera la carpeta completa, con tests y reglas sacados de esos mismos valores.

## Dos puertas de entrada: "tengo el esquemático" o "sé cómo se comporta"

Pedido del usuario el 2026-10-01: "la idea es que si la persona tiene el esquemático o sabe cómo
se comporta, pueda crearlo". Son dos formas de describir un módulo, y las dos tienen que alcanzar
**solas**. Terminan en el mismo formato de carpeta, y se pueden combinar.

| | Puerta A: tengo el esquemático | Puerta B: sé cómo se comporta |
|---|---|---|
| Quién | El que diseñó la placa, o tiene la de referencia del fabricante | El que usa el módulo como caja negra, o lo está inventando |
| Qué trae | Un `.kicad_sch` (o una netlist KiCad `.net` / SPICE `.cir`) | Una descripción: qué pines tiene, qué consume, qué hace con cada entrada |
| Qué genera la app sola | Modelo eléctrico, pines, despiece, BOM, hoja para exportar | Modelo eléctrico desde los pines, caja para el esquemático, dibujo genérico |
| Lo que falta completar | El comportamiento de los chips con lógica que tenga adentro | El circuito interno, si se quiere fabricar a nivel de componentes |

### Puerta A: el esquemático **es** el modelo

Hoy el diseño tiene el circuito interno dos veces: en `model.js` (para simular) y en
`esquematico.discreto` / `hoja` (para fabricar), con una "validación cruzada" para que no se
contradigan. Con la puerta A eso desaparece: **una sola fuente de verdad**.

1. El autor pone su `esquematico.kicad_sch` en la carpeta.
2. La app lo convierte a netlist y la traduce a primitivas del motor:

   | En el esquemático | En el motor |
   |---|---|
   | R, C, L (con su valor: "10k", "100nF") | `resistencia`, `capacitor`, `inductor` |
   | D, LED, Zener (por símbolo o por valor: "1N4148", "LED_Red") | `diodo` con parámetros de una tabla de piezas conocidas, o genéricos con aviso |
   | Transistor BJT/MOSFET (S8050, 2N7002…) | `transistor` (primitiva nueva, sección 7) |
   | Regulador (AMS1117-3.3, LM7805…) | `regulador` con su tensión, caída y límite |
   | Conector o etiqueta jerárquica (J1, "VCC", "SDA") | **Los pines del módulo**: nombre, orden y posición para la tira de pines |
   | Un IC con lógica (U1: BME280, NE555, ATtiny85) | Caja negra: busca su chip en `chips/` por valor o MPN; si no está, lo marca como **pendiente** (puerta B para ese chip) |
   | Componentes con "DNP"/"NC" | Se ignoran para simular y para la BOM |

3. Lo que no reconoce lo dice con nombre y referencia ("U3 'XYZ123': chip desconocido, sin
   comportamiento"; "D5: diodo genérico, faltan parámetros"). El módulo se importa igual, con el
   nivel de soporte que corresponda.
4. `model.js` queda **solo para agregar** lo que el esquemático no dice: reglas complejas,
   `observar()`, el estado visible. Puede leer los elementos generados por su referencia (`R1`, `U1`).

Detalles a resolver, dichos claro:
- **Conectividad**: sacar la netlist de un `.kicad_sch` exige resolver cables, uniones, etiquetas y
  hojas jerárquicas. No conviene reimplementarlo: usar `kicad-cli sch export netlist` en una imagen
  Docker (como ya se hace con los toolchains). Hoy `kicad-cli` **no está instalado** en esta PC.
  Aceptar también la netlist directa (`.net` de KiCad o `.cir` de SPICE), que no necesita KiCad.
- **Otros formatos** (EasyEDA, Eagle, Altium): primero solo KiCad y SPICE. EasyEDA y Eagle se
  pueden abrir con KiCad, que los convierte.
- **Valores con tolerancia y unidades** ("4k7", "100n/50V", "20K(5%)"): un parser de valores con tests.
- **Tamaño**: una placa de referencia completa (como la de Espressif) tiene cientos de
  componentes; hoy el límite es 200 elementos por módulo. Subirlo para los generados desde un
  esquemático y medir el tiempo del motor.

### Puerta B: describir el comportamiento sin código, y código solo si hace falta

Quien sabe cómo se comporta un módulo puede no saber escribir un `model.js` con diodos y
fuentes. Para eso, el lado eléctrico se arma desde **cómo se ven los pines desde afuera**
(lo que dicen las hojas de datos en "características eléctricas"):

```json
"pines": [
  { "nombre": "VCC", "tipo": "alimentacion", "consumo": { "reposo_ma": 0.05, "activo_ma": 15 } },
  { "nombre": "OUT", "tipo": "salida", "nivel": "VCC", "corrienteMax_ma": 20 },
  { "nombre": "EN",  "tipo": "entrada", "pull": { "a": "VCC", "ohms": 10000 }, "umbral_v": 1.4 },
  { "nombre": "AO",  "tipo": "salida-analogica", "rango": ["GND", "VCC"] },
  { "nombre": "GND", "tipo": "tierra" }
]
```

La app genera las primitivas: una carga entre VCC y GND según el modo, una salida con su
resistencia interna, un pull-up, una fuente controlada para la salida analógica. **Un módulo
común no necesita `model.js`.**

El comportamiento, en tres escalones, del más fácil al más potente:

1. **Tabla de reglas** (`comportamiento.json`), para lo que se dice con "cuando… entonces…":
   ```json
   [
     { "cuando": "entorno.movimiento", "entonces": { "OUT": 1, "ui.on": true }, "durante_ms": "props.retardo_ms" },
     { "cuando": "EN == 0", "entonces": { "modo": "reposo", "OUT": 0 } },
     { "siempre": { "AO": "entorno.luz / 100 * VCC" } }
   ]
   ```
   Cubre PIR, sensores de umbral (LM393 con su comparador), relés, módulos de luz, finales de
   carrera, sensores analógicos. Corre en código nativo del server (es un dato), así que es rápido.
2. **`registros.json`** para chips I2C/SPI (sección 5.1).
3. **`comportamiento.js`** para lo que no entra: protocolos propios, máquinas de estados.

### Cómo se combinan

- Placa con esquemático y un chip conocido (el BME280 de Adafruit): puerta A para la placa; el chip
  sale de `chips/bosch-bme280/`. **Cero código.**
- Placa con esquemático y un chip inventado: puerta A para la placa, puerta B para el chip nuevo.
- Módulo que solo se conoce por fuera: puerta B. Para fabricarlo a nivel de componentes, se le suma
  el esquemático después y la app comprueba que el comportamiento eléctrico no cambió (los mismos
  `tests.json` tienen que seguir pasando).

### Lo que esto cambia en el resto del diseño

- `esquematico.discreto` y la "validación cruzada" (sección 2) se reemplazan por la puerta A.
- `model.js` deja de ser el centro: es el último recurso, para agregar.
- Las primitivas `transistor`, `regulador` y `fuenteControlada` (sección 7) dejan de ser opcionales:
  las necesita la traducción del esquemático.
- El SDK (sección 6) suma el conversor de esquemático y el validador de la tabla de reglas.
- `crear_modulo` (MCP) acepta las dos entradas: un esquemático, o una descripción en texto que la
  IA convierte en `pines` + `comportamiento.json`.

## Se puede cambiar todo: el proyecto está en desarrollo

Pedido del usuario el 2026-10-01: "estamos en desarrollo todavía, así que se puede modificar todo
del proyecto". Este diseño **no tiene que ser compatible con el formato de hoy**: no hay módulos
de terceros publicados que cuidar. Lo que se gana es no arrastrar dos formas de hacer lo mismo.
Consecuencias:

| Hoy | Con este diseño | Por qué |
|---|---|---|
| Dos formas de dar el modelo eléctrico: flags (`passthrough` + `ohmsProp`, `diode` + `diodeVfDefault`, `switch`, `source`, `electrical`) o `model.js` | **Solo `model.js`** (o ningún modelo). Los flags se borran. De los 11 módulos de fábrica que no son placas, 8 ya tienen `model.js`; `door-sensor-433`, `siren-433` y `remote-433` (inalámbricos) quedan sin modelo eléctrico o con uno nuevo. | Los flags están repartidos en `sim/modelos.ts`, `sim/analisis.ts`, `circuitNetwork.ts`, `circuitEngine.ts`, `diagramOps.ts`, `pinScan.ts`, `web/app.ts` y el depurador. Una sola vía es menos código y un solo lugar para las reglas. |
| `bridge` con 5 roles fijos y un solo pin | **Se reemplaza** por el `comportamiento` (sección 5.1) y, para lo simple, por un comportamiento de fábrica reusable (`"comportamiento": "salida-digital"`, `"entrada-digital"`, `"rf-433"`) | El rol y el pin único son la lista cerrada que más frena (sección 7). Lo usan `diagramOps.ts`, `emulator.ts`, `mcp.ts`, `sim/analisis.ts`, el depurador y la web: hay que migrarlos juntos. |
| `ui` con `on`/`brillo` y `data-si` con 8 estados fijos | `ui` libre y el SVG lee cualquier campo | Sección 7. |
| Esquema que borra lo que no conoce | Esquema **estricto** con `formato: 2`, y `x-…` para experimentos | Sección 6, corrección 1. |
| `chips/` con chips de Wokwi a medio hacer | `chips/` pasa a ser la carpeta de chips de este formato (sección 6, corrección 2). Los de Wokwi se importan con el importador. | Un solo significado por carpeta. |
| Campos del JSON mezclando inglés (`pins`, `props`, `controls`) y español (`parte`, `reglas`, `entorno`) | **Decisión pendiente del usuario**: todo en un idioma. Recomendación: español, como el resto del dominio (`CLAUDE.md` decía que los campos quedaban como estaban; eso se puede revisar ahora). | Un autor externo no debería adivinar en qué idioma va cada campo. |
| `SandboxModelo` compila un string por llamada con vigilante de tiempo | API nueva con script precompilado y llamadas por lote | Sección 6, prueba C. |
| `solver.ts` + `circuitNetwork.ts` (MNA a mano), el verificador independiente del motor | Tiene que entender las primitivas nuevas (`regulador`, `transistor`…) o la comparación (`sim/comparacion.test.ts`) se limita a los circuitos que entiende, y se dice. | Si no, el verificador queda viejo sin que nadie lo note. |

Lo único que sí hay que cuidar al romper el formato:
- **Los proyectos locales** de `projects/` (no se versionan, y suele haber una simulación corriendo):
  un script de migración `formato 1 → 2` que reescribe los `project.json` (cables a pines
  renombrados, módulos que cambiaron de tipo) y deja una copia del original. Nunca tocar el
  proyecto abierto en la sesión en vivo sin avisar.
- **Los tests y los e2e**: cambian junto con el formato, en el mismo PR.
- **La documentación**: `modules/README.md`, `docs/modulos-y-su-codigo.md`, `docs/motor-electrico.md`
  y `CLAUDE.md` se reescriben, no se parchean.

## Estructura de la carpeta

```
modules/bme280/
├── module.json            # obligatorio; bloques nuevos opcionales (ver abajo)
├── module.svg             # dibujo de la simulación (igual que hoy)
├── model.js               # modelo eléctrico (igual que hoy)
├── tests.json             # NUEVO: casos de prueba declarativos            (sección 4)
├── tests.js               # NUEVO: casos que no entran en el JSON          (sección 4)
├── esquematico.kicad_sch  # NUEVO: circuito interno, p. ej. el del fabricante (sección 2)
├── registros.json         # NUEVO: mapa de registros, sin código            (sección 5.1)
├── comportamiento.js      # NUEVO: lógica digital, protocolo               (sección 5.1)
├── ejemplos/              # NUEVO: programa mínimo por lenguaje, se certifica (sección 5.7)
│   ├── esphome.yaml
│   ├── arduino.ino
│   └── micropython.py
└── modelo3d.step          # NUEVO: para el PCB y la caja                    (sección 5.10)
```

Bloques nuevos en `module.json`, todos opcionales:

| Bloque | Para qué | Sección |
|---|---|---|
| `parte` | Fabricante, número de parte, datasheet, proveedores. | 1 |
| `esquematico` | Símbolo, huella, pines, despiece, hoja, notas. | 2 |
| `reglas` | Límites de la hoja de datos y ERC. | 3 |
| `entorno` | Lo que mide del mundo (temperatura, distancia…). | 5.2 |
| `salidas` | Lo que produce (pantalla, luz, sonido, movimiento). | 5.3 |
| `tiempos`, `modos` | Tiempos de arranque y conversión; consumo por modo. | 5.4 |
| `precision` | Exactitud, resolución y ruido. | 5.5 |
| `configuracion` | Jumpers, dirección I2C, ajustes físicos. | 5.6 |
| `drivers` | Librería o componente por lenguaje. | 5.7 |
| `submodulos` | Armarlo reusando otros módulos. | 5.8 |
| `radio` | Banda, modulación y alcance de los inalámbricos. | 5.9 |
| `mecanica` | Medidas y agujeros de montaje. | 5.10 |
| `chip` | El chip que usa (`chips/<chip>/`), con el mapeo de pines: comportamiento, registros, tiempos y entorno vienen de ahí. | 6 |

## 1. `parte`: la pieza real

Para la lista de materiales y la compra.

```json
"parte": {
  "fabricante": "Songle",
  "mpn": "SRD-05VDC-SL-C",
  "datasheet": "https://…",
  "proveedores": [{ "nombre": "LCSC", "sku": "C35449" }]
}
```

Si una prop cambia la pieza (LED rojo o verde, resistencia de 220 Ω o 1 kΩ), `mpn` admite
plantillas (`"RC0805FR-07{{props.ohms}}L"`) o un mapa por prop, como ya hacen los `vars`.

## 2. `esquematico`: símbolo, huella y circuito interno

### Dos niveles de fabricación

Un "módulo" puede ser dos cosas distintas a la hora de construir:

| Nivel | Ejemplo | Qué se exporta |
|---|---|---|
| **`modulo`** (se compra armado) | RXB6, relé en placa, DevKit ESP32 | Un conector con sus pines. Se compra el módulo y se enchufa. |
| **`discreto`** (componentes sueltos) | Resistencia, LED, o el relé "desarmado" | Sus piezas reales: R, D, Q, K… cada una con símbolo, valor, huella y número de parte. |

Cada módulo declara un nivel por defecto (`fabricacion`) y puede ofrecer el otro. Se elige por
proyecto o por instancia al exportar.

### Formato

```json
"esquematico": {
  "referencia": "K",
  "valor": "{{props.etiqueta}}",
  "simbolo": { "kicad": "Relay:SRD-05VDC" },
  "huella": { "kicad": "Relay_THT:Relay_SPDT_SANYOU_SRD_Series_Form_C" },
  "pines": { "IN": "1", "VCC": "2", "GND": "3" },
  "fabricacion": "modulo",
  "hoja": "esquematico.kicad_sch",
  "notas": ["La bobina es de 5 V: no alimentar desde 3V3."],
  "discreto": [
    { "ref": "R", "valor": "1k", "simbolo": "Device:R", "huella": "Resistor_SMD:R_0805", "mpn": "…", "nodos": ["IN", "base"] },
    { "ref": "Q", "valor": "S8050", "simbolo": "Transistor_BJT:S8050", "nodos": { "B": "base", "C": "bobina", "E": "GND" } },
    { "ref": "D", "valor": "1N4148", "nodos": ["bobina", "VCC"] }
  ]
}
```

| Campo | Qué es |
|---|---|
| `referencia` | Prefijo de la referencia: R, C, D, K, U, J… Al exportar se numera (K1, K2). |
| `valor` | Lo que se imprime al lado del símbolo. Admite `{{props.x}}`. Con tolerancia si hace falta ("20K(5%)"), o "NC" si no se monta. |
| `simbolo` | Símbolo de la librería oficial de KiCad (`Lib:Nombre`), o `base` (`resistencia`, `led`, `caja`…) dibujado por la app. |
| `huella` | Footprint de la librería oficial de KiCad. |
| `pines` | Pin del module.json → número de pin del símbolo y la huella. |
| `fabricacion` | `modulo` o `discreto` (ver arriba). |
| `hoja` | Un `.kicad_sch` de la carpeta con el circuito interno completo del módulo. |
| `notas` | Texto que aparece en el esquemático exportado, junto al bloque. |
| `discreto` | El despiece en componentes reales. `nodos` usa los mismos nombres que `ctx.pin()` y `ctx.nodo()` de `model.js`. |

**Validación cruzada**: un test automático compara el despiece `discreto` con lo que declara
`model.js`, para que el esquemático no diga algo distinto de lo que se simula.

### `hoja`: copiar el de referencia en vez de dibujar

Espressif y la mayoría de los fabricantes publican el esquemático de referencia de sus módulos
y DevKits, muchas veces en KiCad. Para una placa o un módulo real **se copia ese archivo a la
carpeta y listo**. Para un módulo inventado, se dibuja una vez en KiCad o se usa el despiece.

## 3. `reglas`: límites de la hoja de datos

```json
"reglas": [
  { "tipo": "tensionMax", "entre": ["VCC", "GND"], "max": 7, "severidad": "peligro", "mensaje": "La bobina es de 5 V: se recalienta." },
  { "tipo": "tensionMin", "entre": ["VCC", "GND"], "min": 3.75, "cuando": "control", "severidad": "advertencia" },
  { "tipo": "corrienteMax", "elemento": "bobina", "max": 0.09 },
  { "tipo": "potenciaMax", "elemento": "rbase", "max": 0.25 },
  { "tipo": "conectado", "pines": ["VCC", "GND"], "severidad": "advertencia" },
  { "tipo": "nivelLogico", "pin": "IN", "familia": "5V", "aceptaDe": ["3V3", "5V"] }
]
```

| Tipo | Cuándo se evalúa | Para qué |
|---|---|---|
| `tensionMax`, `tensionMin`, `corrienteMax`, `potenciaMax` | **Dinámicas**: después de cada cálculo del motor, junto con `observar()`. | Los "absolute maximum ratings" de la hoja de datos. |
| `conectado`, `nivelLogico`, `noConectarA` | **Estáticas (ERC)**: sin simular, mirando solo el cableado. | Pines que no pueden quedar sueltos, mezcla de 3,3 V y 5 V, salida contra salida. |

- Sin `mensaje`, se arma uno con los valores ("VCC en 7,4 V: máximo 7 V").
- `observar()` sigue existiendo para lo que no entra en una regla, como el relé que pega con el 75 %
  de su corriente nominal. Las reglas que hoy están en JS y caben en el JSON se migran
  (resistor, led, relay).
- El exportador no exporta con errores de ERC, y pone las reglas como notas en el dibujo.

## 4. `tests.json`: el módulo se prueba a sí mismo

Cada caso arma un mini-circuito alrededor del módulo, lo resuelve con el motor real y compara con
la hoja de datos.

```json
[
  {
    "nombre": "con 5 V la bobina pide ~71 mA y pega",
    "props": {},
    "control": false,
    "banco": { "VCC": { "fuente": 5 }, "GND": "tierra", "IN": { "fuente": 3.3 } },
    "espera": {
      "corriente": { "bobina": [0.066, 0.076] },
      "ui": { "on": true },
      "sinAvisos": true
    }
  },
  {
    "nombre": "con 3 V no pega y avisa",
    "banco": { "VCC": { "fuente": 3 }, "GND": "tierra", "IN": { "fuente": 3.3 } },
    "espera": { "ui": { "on": false }, "aviso": { "severidad": "advertencia", "contiene": "no alcanza" } }
  }
]
```

| Campo | Qué es |
|---|---|
| `banco` | Qué se conecta a cada pin: `{ "fuente": V, "limiteMa": mA }`, `"tierra"`, `{ "resistencia": Ω }` a tierra, o `"abierto"`. |
| `props`, `control` | Las props de la instancia y si su control está activo. |
| `espera.tension` / `espera.corriente` | Rangos `[min, max]` de un pin o de un elemento de `model.js`. Siempre con rango: las piezas reales tienen tolerancia. |
| `espera.ui` | Lo que tiene que devolver `observar()` (`on`, `brillo`). |
| `espera.aviso` / `espera.sinAvisos` | El aviso que tiene que salir (por severidad y texto), o que no salga ninguno. |

Para lo que no entra en el JSON, `tests.js` exporta
`[{ nombre, async correr(banco) { … } }]` y corre en el mismo sandbox que `model.js`.

**Dónde corren:**
- **Al importar**: si un test falla, el módulo no se instala y se dice qué caso falló y con qué valor.
- **En los tests del proyecto**: un test recorre el catálogo y corre los de cada módulo.
- **Por MCP**: `probar_modulo` devuelve caso por caso qué pasó, con los valores medidos.

## 5. Más allá de lo eléctrico: lo que piden los módulos complejos

Con lo anterior, un LED, un relé o un divisor quedan emulados completos. Un BME280, un SSD1306,
un MPU6050, un HC-SR04, un DFPlayer o una tira WS2812 **no**: además de consumir corriente,
**hablan un protocolo, miden algo del mundo y producen algo visible o audible**. Para esos, la
carpeta puede traer los archivos y bloques de esta sección (ver la
[estructura de la carpeta](#estructura-de-la-carpeta)).

### 5.1 Comportamiento digital: `comportamiento.js` y `registros.json`

El firmware real le habla al módulo por I2C, SPI, UART, 1-Wire o pulsos, y el módulo tiene que
contestar como el chip real. Es lo mismo que hace la [Chips API de Wokwi](https://docs.wokwi.com/chips-api/getting-started),
así que conviene copiar su forma: eventos por pin y por bus.

> **Corregido por la prueba del BME280 (sección 6):** la primera versión tenía
> `escribir(ctx, bytes)` / `leer(ctx, n)`, que no puede expresar la escritura por pares ni la
> sombra en la ráfaga. La API es **por transacción**, con inicio y fin. El motor junta la
> transacción y llama al sandbox una sola vez, porque una llamada por byte es demasiado lenta.

```js
module.exports = {
  alEncender(ctx) { /* arranque o reset: p. ej. elegir I2C o SPI según CS */ },
  i2c: {
    direcciones: (ctx) => [ctx.pinEnBajo('SDO') ? 0x76 : 0x77],
    inicio(ctx, { direccion, lectura }) { return true; },   // ACK o NACK
    escribir(ctx, byte) { return true; },                   // ACK o NACK
    leer(ctx) { return 0x60; },                             // un byte
    fin(ctx) {},
  },
  pin(ctx, nombre, nivel, t) { /* cambio en un pin, con su tiempo en µs de la emulación */ },
  temporizador(ctx, id) { /* para respuestas con retardo: el eco del HC-SR04 */ },
};
```

- El comportamiento de un **chip** va en `chips/<chip>/`, no en el módulo: varias placas
  comerciales usan el mismo chip (sección 6, corrección 2).

- **`registros.json` cubre sin código la mayoría de los sensores I2C/SPI**: dirección, ancho,
  valor de reset, solo lectura, campos de bits, escritura por pares o con autoincremento, sombra
  en ráfaga. **Corre en código nativo del server** (es un dato, no código de terceros), así que es
  rápido. Las conversiones que no son lineales (como la compensación del BME280) van en
  `comportamiento.js` con el helper `invertirMonotona` del SDK.
- `comportamiento.js` queda para lo que no entra: protocolos con tiempos (WS2812, DHT22, HC-SR04),
  máquinas de estados (GSM con comandos AT, DFPlayer), compresión o cálculos internos.
- Corre en el mismo sandbox que `model.js`.
- **Dependencia del motor**: hace falta que el emulador del chip exponga sus buses hacia los
  módulos. En el Uno se puede (avr8js tiene `AVRTWI` y `AVRSPI`, sin conectar). En ESP32 con
  esp-emu **no**: no admite dispositivos I2C/SPI propios. Con MicroPython se puede reemplazando el
  driver por el puente. Detalle en la sección 6, prueba E.

### 5.2 El entorno: `entorno` en module.json

Lo que el módulo mide del mundo, para que el usuario lo mueva durante la simulación y los
tests lo fijen:

```json
"entorno": {
  "temperatura": { "unidad": "°C", "min": -40, "max": 85, "default": 22 },
  "humedad": { "unidad": "%", "min": 0, "max": 100, "default": 45 },
  "presion": { "unidad": "hPa", "min": 300, "max": 1100, "default": 1013 }
}
```

La app genera los controles deslizantes sola. Sirve para temperatura, luz, distancia,
aceleración, gas, campo magnético, sonido, peso, presencia (PIR), humedad del suelo, etc.

### 5.3 Las salidas al mundo: `salidas` en module.json

Lo que el módulo produce y la app tiene que mostrar o hacer sonar:

| Tipo | Ejemplos | Qué dibuja la app |
|---|---|---|
| `pantalla` (`ancho`, `alto`, `color`) | SSD1306, LCD 16x2, TFT ILI9341 | Un lienzo dentro del SVG con el framebuffer del módulo. |
| `luz` (`rgb`, `cantidad`) | WS2812, LED RGB | Color y brillo por LED. |
| `sonido` | Buzzer, DFPlayer | Frecuencia y volumen (con audio del navegador). |
| `movimiento` (`angulo`, `rpm`, `pasos`) | Servo, motor DC, paso a paso | Ángulo o giro animado. |
| `texto` | Módulos con salida serie a otro equipo | Una consola propia. |

`ui.on` y `ui.brillo` de `observar()` siguen sirviendo para lo simple.

### 5.4 Tiempos y modos de energía: `tiempos` y `modos`

Datos de la hoja de datos que hoy no tienen lugar:

```json
"tiempos": { "arranque_ms": 2, "conversion_ms": 9.3, "rebote_ms": 5 },
"modos": {
  "dormido": { "corriente_ua": 0.1 },
  "medicion": { "corriente_ua": 714 },
  "espera": { "corriente_ua": 0.2 }
}
```

- El comportamiento elige el modo, y el modelo eléctrico consume según el modo (sirve para
  calcular la duración de una batería).
- Los tiempos se respetan en la emulación: leer antes de que termine la conversión da el valor viejo,
  como en el chip real. El rebote del pulsador y el tiempo de cierre del relé salen de acá
  cuando esté el análisis transitorio.

### 5.5 Imperfecciones reales: `precision`

```json
"precision": {
  "temperatura": { "exactitud": 0.5, "resolucion": 0.01, "ruido": 0.02 }
}
```

Que la lectura no sea perfecta: el código del usuario tiene que funcionar con ruido y con
tolerancias, igual que con el sensor real. Los tests fijan una semilla para ser repetibles.

### 5.6 Configuración física: `configuracion`

Lo que en el módulo real se cambia con un puente de soldadura, un jumper, un DIP o un
potenciómetro de ajuste: dirección I2C (pin ADDR/SDO), sensibilidad y tiempo del PIR,
versión de 3,3 V o 5 V, pull-ups incluidos o no. Son `props`, pero marcadas como físicas
para que el exportador las anote en el esquemático ("JP1 cerrado: dirección 0x77").

También declara lo que el módulo **trae en la placa** y cambia el circuito del proyecto:
**pull-ups de I2C** (dos módulos con pull-ups de 4,7 kΩ en paralelo quedan en 2,35 kΩ),
**adaptadores de nivel**, **regulador propio** (acepta 5 V aunque el chip sea de 3,3 V). Todo
eso va en `model.js`, y las `reglas` lo controlan.

### 5.7 Código de uso: `ejemplos/` y `drivers`

Un módulo no está completo si no se sabe cómo usarlo desde el firmware:

```json
"drivers": {
  "esphome": { "plataforma": "bme280_i2c" },
  "arduino": { "libreria": "Adafruit BME280 Library", "version": "2.2.4" },
  "micropython": { "archivo": "ejemplos/bme280.py" }
}
```

- La carpeta `ejemplos/` tiene un programa mínimo por lenguaje.
- **Certificación del módulo**, igual que `certificar_placa`: compila el ejemplo, lo emula con el
  módulo conectado y comprueba que lo que imprime coincide con el `entorno` (por ejemplo, que con
  22 °C imprime 22 ± 0,5). Esto prueba de punta a punta que el protocolo está bien emulado.
- Hace falta un gestor de librerías de Arduino (hoy no existe, ver `falta.md`).

### 5.8 Composición: `submodulos`

Muchos módulos reales son varios iguales en una placa: relé de 4 canales, 8 LEDs, 4 dígitos de
7 segmentos. Con `submodulos` se arma uno nuevo reusando otro, sin copiar su modelo:

```json
"submodulos": [{ "tipo": "relay", "cantidad": 4, "pines": { "IN": "IN{n}", "VCC": "VCC", "GND": "GND" } }]
```

### 5.9 Inalámbricos: `radio`

Generaliza el rol `air` de hoy (RF 433): banda, modulación, protocolo y alcance. Sirve para IR
(control remoto y receptor TSOP), 433/868 MHz, LoRa, NFC/RFID (RC522 y la tarjeta como otro
módulo), BLE.

### 5.10 Físico: `mecanica`

Medidas, agujeros de montaje, altura y `modelo3d.step`. Hace falta para el PCB (que el módulo
entre) y para diseñar la caja.

### Prioridad

Para "emular completo" lo esencial es **5.1 + 5.2 + 5.3 + 5.7**: hablar el protocolo, medir el
entorno, mostrar la salida y probarlo con un ejemplo real. El resto suma realismo y fabricación.
Como siempre, todo es opcional y con valores por defecto: un módulo sin `comportamiento` sigue
siendo solo eléctrico, como hoy.

## 6. Prueba de punta a punta: el BME280 de Adafruit (2026-10-01)

Para comprobar el diseño contra un caso real, se tomó un módulo comercial muy completo y se lo
pasó a este formato, con pruebas contra el código actual. Todo se corrió fuera del repo
(`/tmp/bme280-prueba/`), con el importador, el motor y el sandbox reales, sin tocar la sesión
en vivo ni la carpeta `modules/`.

### Por qué este módulo

El [Adafruit BME280 (producto 2652)](https://learn.adafruit.com/adafruit-bme280-humidity-barometric-pressure-temperature-sensor-breakout/pinouts)
junta casi todo lo difícil en una placa barata y muy usada:

| Qué tiene | Detalle real | Por qué pone a prueba el diseño |
|---|---|---|
| Tres magnitudes | Temperatura, humedad y presión | Un `entorno` con varias magnitudes que dependen entre sí: la presión y la humedad se compensan con la temperatura (`t_fine`). |
| Dos buses en los mismos pines | I2C o SPI (4 o 3 hilos). Se elige por el nivel de CS al arrancar: si CS se pone en bajo una vez, queda en SPI hasta el próximo reset. | Pines con varias funciones; comportamiento que depende del arranque. |
| Dirección configurable | 0x77 por defecto, 0x76 con el puente ADDR o SDO a GND | `configuracion` física que cambia el protocolo. |
| Electrónica en la placa | Regulador a 3,3 V (VIN de 3 a 5 V, salida 3VO de hasta 100 mA), adaptador de nivel en todos los pines, pull-ups de I2C | El `model.js` tiene que conservar la energía y modelar un regulador real. |
| Mapa de registros | ID 0x60 en 0xD0; reset con 0xB6 en 0xE0; ctrl_hum 0xF2, que **solo se aplica después de escribir ctrl_meas 0xF4**; status 0xF3 (`measuring`, `im_update`); config 0xF5; datos 0xF7–0xFE; calibración 0x88–0xA1 y 0xE1–0xE7 | Registros con efectos laterales y reglas de orden. |
| Escritura I2C por pares | Al escribir, se manda registro + dato, registro + dato (sin autoincremento); al leer sí autoincrementa | Un mapa de registros "genérico" con autoincremento en las dos direcciones lo emula mal. |
| Lectura en ráfaga con sombra | Los datos 0xF7–0xFE se congelan durante la lectura en ráfaga para que no se mezclen mediciones | Hace falta saber dónde empieza y dónde termina una transacción. |
| Modos y tiempos | Dormido, forzado y normal; tiempo de medición máximo = 1,25 + 2,3·osrs_t + (2,3·osrs_p + 0,575) + (2,3·osrs_h + 0,575) ms; arranque de 2 ms | `tiempos` que dependen de registros, no constantes. |
| Consumo por modo | ~0,1 µA dormido, ~3,6 µA promedio a 1 Hz, cientos de µA midiendo | `modos` que cambia el modelo eléctrico según el estado digital. |
| Compensación en el firmware | El chip entrega valores crudos del ADC de 20 bits; la librería los convierte con 18 coeficientes de calibración de fábrica | Para mostrar 22 °C, el módulo tiene que **calcular al revés** qué valor crudo da 22 °C. |
| Precisión | ±1 °C (0 a 65 °C), ±3 %HR, ±1 hPa | `precision` con ruido realista. |
| Variantes | El mismo chip viene en placas genéricas (GY-BME280: 4 pines, sin regulador, 0x76 por defecto), de Pimoroni, de SparkFun… | El chip y la placa del módulo son cosas distintas. |

### Pruebas que se corrieron y qué dieron

**A. Importar un módulo con los bloques y archivos nuevos.** Se armó la carpeta con
`module.json` (con `parte`, `reglas` y `entorno`), `module.svg`, `model.js`, `tests.json`,
`comportamiento.js` y `ejemplos/esphome.yaml`, y se pasó por `importar()` contra una carpeta
de destino temporal.

```
importados: bme280-adafruit, errores: [], avisos: []
archivos instalados: model.js, module.json, module.svg
bloques nuevos que sobrevivieron: parte=false reglas=false entorno=false
```

**Resultado: la importación "sale bien" y pierde todo lo nuevo en silencio.** Hay tres causas
en el código:
- `ModuleDefSchema` (`app/shared/src/module.ts`) es un `z.object` sin `.passthrough()`, así que
  zod **borra** las claves que no conoce.
- `ModuleInstaller.instalar` (`app/server/src/moduleImporter.ts`) escribe el `def` ya parseado,
  y solo copia `module.svg` y el `model`.
- `paquetesDeArchivos` solo levanta el SVG y el modelo, y `leerZip` descarta todo lo que no sea
  `.json`, `.svg` o `.js`, así que `.yaml`, `.ino`, `.py`, `.kicad_sch` y `.step` nunca llegan.
  Además, el límite de 512 KB por archivo deja afuera la mayoría de los `.step` y algunos `.kicad_sch`.

**B. Conservación de la energía con un regulador hecho a mano.** El regulador se modeló como se
puede hoy: `fuenteTension(reg, GND, 3.3, { soloEntrega: true })`, con el sensor como una
resistencia equivalente de 0,714 mA.

```
VIN=5 V:      entrega la fuente externa 1.006 mA; consume el sensor 1.005 mA
VIN=3 V:      entrega la fuente externa 0.000 mA; consume el sensor 0.714 mA; el "regulador" entrega 2.358 mW
VIN=0.0001 V: entrega la fuente externa 0.000 mA; consume el sensor 0.714 mA; el "regulador" entrega 2.358 mW
```

**Resultado: un módulo puede crear energía de la nada.** Con la entrada en 0 V el sensor sigue
alimentado y ui.on queda en verdadero. Además, con 5 V la salida "de 3,3 V" subió a ~4,6 V (por
la protección de entrada, y porque `soloEntrega` no puede absorber), sin ningún aviso. Esto
contradice lo que dice [`docs/modulos-y-su-codigo.md`](docs/modulos-y-su-codigo.md): "un módulo
nunca fija un voltaje ni una corriente a mano, así que no puede romper las leyes". Hoy sí puede,
con `fuenteTension`. La placa no tiene el problema porque usa `reguladorLineal()`
(`app/server/src/sim/placa.ts`), que saca la corriente de su entrada y disipa (Vin − Vout)·I.
Ese elemento **no está en el SDK de los módulos**.

**C. Cuánto cuesta una llamada al sandbox** (en esta PC, 20 000 a 50 000 llamadas):

| Forma de llamar | µs por llamada | Llamadas por segundo |
|---|---|---|
| `SandboxModelo.observar()` como hoy | 291 | ~3 400 |
| Igual, pero con un script mínimo | 148 | ~6 700 |
| Script precompilado + entrada como string en el contexto, con tiempo límite | 120 | ~8 300 |
| Igual, sin tiempo límite | 7,6 | ~130 000 |
| Una llamada por transacción de 32 bytes, con tiempo límite | 12,8 por byte | ~78 000 bytes/s |

Referencia: I2C a 100 kHz mueve ~10 000 bytes/s; a 400 kHz, ~40 000; SPI a 8 MHz, ~1 000 000.

**Resultado: llamar al sandbox una vez por byte no alcanza ni para I2C a 100 kHz.** Casi todo el
costo es el vigilante de tiempo límite de `vm` (que se arma en cada llamada) y compilar un string
nuevo cada vez. Agrupando por transacción, I2C a 400 kHz entra con margen. SPI rápido (pantallas
TFT) no entra en el sandbox de ninguna forma: necesita un camino nativo.

**D. Las compensaciones de Bosch, al revés.** Se escribieron las fórmulas enteras de la hoja de
datos (temperatura en 32 bits, presión en 64 bits) con los coeficientes de ejemplo de Bosch, y una
inversa por búsqueda binaria sobre el ADC de 20 bits.

```
adc_T=519888 → 25.08 °C (la hoja dice 25,08)
adc_P=415148 → 1006.53 hPa (la hoja dice 1006,53)
peor error de ida y vuelta en temperatura de -40 a 85 °C: 0.010 °C
presión de 300 a 1100 hPa: error < 0,02 hPa en todos los casos
costo de una inversión: ~1 µs
```

**Resultado: funciona, es barato y es genérico.** Toda salida monótona de un ADC se invierte con
20 pasos. Pero una "fórmula de conversión" escrita en `registros.json` no alcanza: hace falta
ejecutar la fórmula real en un sentido y buscar en el otro, con enteros de 64 bits (`BigInt`) y
con dependencias entre magnitudes (`t_fine`).

**E. Qué permiten hoy los motores** (leído del código y de la documentación):

| Motor | I2C hacia un módulo | SPI | UART | Pines |
|---|---|---|---|---|
| avr8js (Uno) | Sí se puede: `AVRTWI` expone `TWIEventHandler` con `start`, `stop`, `connectToSlave(addr, write)`, `writeByte`, `readByte(ack)`, y se contesta con `completeConnect/Write/Read`, que **se pueden diferir**. Hoy no está conectado. | Sí se puede: `AVRSPI.onByte` + `completeTransfer`. Hoy no está conectado. | `AVRUSART` ya está conectado, pero a la consola. | Con tiempo exacto en ciclos. |
| esp-emu v0.44 (ESP32) | **No**: emula el periférico I2C, pero el único esclavo es una EEPROM incorporada. No hay API para dispositivos propios. | No (GP-SPI sin dispositivos externos). | `--uart1-tcp` sirve para "un dispositivo serie externo (sensor, GPS, módem)", pero **UART1 ya lo usa el puente**. | Las entradas van por el puente, no por el pad. |
| MicroPython en ESP32 | Se puede **a nivel de driver**: el puente ya reemplaza `machine.Pin` (`templates/micropythonBridge.ts`); lo mismo sirve para `machine.I2C`, `SoftI2C` y `SPI`, enviando las transacciones por el puente. | Ídem. | Ídem. | — |

**Resultado: con las herramientas de hoy, un sensor I2C se puede emular de verdad solo en el Uno**
(y en MicroPython reemplazando el driver). Con ESPHome, ESP-IDF y Arduino-ESP32 sobre esp-emu no
se puede, hasta que Espressif agregue dispositivos externos o se arme un bus I2C propio de ESPHome
que pase por el puente (posible, pero es un componente externo para mantener). Por eso la
verificación con ESPHome que pedía la sección "Cómo se verifica" **no es realizable hoy**.

### Cómo queda el módulo en este formato

```
modules/bme280-adafruit/
├── module.json          # pines, props (addr), parte, esquematico, reglas, entorno, tiempos, modos, precision, drivers
├── module.svg
├── model.js             # regulador (ctx.regulador), pull-ups 10 kΩ, adaptador de nivel, consumo según el modo
├── chip: "bosch-bme280" # el comportamiento NO va acá: se reusa del chip (ver abajo)
├── tests.json
└── ejemplos/  arduino.ino  micropython.py  esphome.yaml
chips/bosch-bme280/      # NUEVO: el chip, compartido por todas las placas que lo usan
├── chip.json            # pines del chip, buses, direcciones posibles, entorno, tiempos, modos, precision
├── registros.json       # mapa de registros con reset, acceso y efectos simples
└── comportamiento.js    # compensación al revés, ctrl_hum que espera a ctrl_meas, sombra en la ráfaga, modos
```

Campo por campo, contra el diseño de las secciones 1 a 5:

| Necesidad del BME280 | ¿Entra en el diseño? | Qué falta o qué cambia |
|---|---|---|
| Pines VIN, 3VO, GND, SCK, SDO, SDI, CS | Parcial | `PinKind` no tiene funciones de bus. SDI es SDA en I2C y MOSI en SPI; SDO es MISO en SPI y el bit de dirección en I2C. Hace falta `funciones: ["i2c.sda", "spi.mosi"]` por pin, para el ERC y para el exportador. |
| Regulador 3,3 V y 3VO de salida | **No** | Falta `ctx.regulador(entrada, salida, gnd, { v, caida, limiteA, iq })` en el SDK, reusando `reguladorLineal()` de `placa.ts`. `fuenteTension` dentro de un módulo tiene que quedar solo para módulos `source` (o avisar al importar). |
| Adaptador de nivel | Parcial | Se modela como pull-ups a cada lado, pero el comportamiento digital tiene que saber que el nivel lógico es el de VIN, no el de 3,3 V. Falta un `nivelLogico` por pin (o por función). |
| Dirección 0x77/0x76 | Sí | Prop `addr` marcada como `configuracion` física; además, SDO a GND la cambia en tiempo real (mirar el nivel del pin, no solo la prop). |
| I2C o SPI según CS al arrancar | **No** | El `comportamiento` necesita un evento de arranque/reset (`alEncender`) y leer niveles de pin. |
| Escritura por pares, lectura con autoincremento, sombra en la ráfaga | **No** con el `i2c.escribir(bytes)` / `leer(n)` de la sección 5.1 | La API tiene que ser por transacción con inicio y fin, como avr8js y Wokwi (ver la corrección de 5.1). `registros.json` necesita `escritura: "pares" \| "autoincremento"` y `lectura: "autoincremento"`. |
| ctrl_hum se aplica al escribir ctrl_meas; reset con 0xB6 | No en JSON | Efectos laterales: `comportamiento.js`. |
| Valores crudos que dan la magnitud del entorno | No en JSON | Helper `invertirMonotona(f, objetivo)` en el SDK; la fórmula de la hoja va en `comportamiento.js`. |
| Tiempo de medición según el sobremuestreo | Parcial | `tiempos` tiene que admitir fórmulas o calcularse en `comportamiento.js`; hace falta un reloj de la emulación (no de la PC). |
| Consumo por modo | Parcial | `modos` tiene que llegar al `model.js` (`ctx.modo`), y el motor tiene que recalcular cuando cambia el modo. |
| Temperatura, humedad y presión movibles | Sí (`entorno`) | Hoy `controls` solo tiene `momentary`, `toggle` y `button`: falta un control deslizante. |
| Precisión y ruido | Sí (`precision`) | El ruido lo aplica la app (con semilla) antes de llamar al comportamiento, no cada módulo a su manera. |
| Librerías (Adafruit BME280 + Adafruit Unified Sensor + Adafruit BusIO) | Parcial | Sin gestor de librerías de Arduino no compila el ejemplo. `drivers` tiene que listar dependencias, no solo una librería. |
| Variantes del mismo chip (Adafruit, GY-BME280, SparkFun) | **No** | Separar **chip** de **placa del módulo** (ver abajo). |
| `.kicad_sch`, `.step`, ejemplos | **No** con el importador de hoy | Ver la prueba A. |
| Probar el protocolo en `tests.json` | **No** | El `banco` solo tiene fuentes y tierras. Falta un **maestro virtual**: `"i2c": [{ "escribir": [208] }, { "leer": 1, "espera": [96] }]` (0xD0 → 0x60). |
| Tensión de un pin no cableado en los tests | **No** | `analizarCircuito().tensiones` solo trae los pines cableados (en la prueba B, `s1.3VO` vino `undefined`). El runner de tests necesita leer cualquier nodo del módulo. |
| Pantalla, luz o sonido | No aplica a este módulo | Para pantallas: el SVG no admite `<image>` ni `<foreignObject>` (bien, por seguridad), así que el lienzo lo pone la app sobre una zona marcada (`data-pantalla`). |

### Correcciones al diseño (de esta prueba)

1. **El importador no puede perder nada en silencio.** Es lo primero, antes de cualquier bloque
   nuevo. Como el proyecto está en desarrollo (ver "Se puede cambiar todo"), en vez de aceptar y
   guardar lo desconocido (`.passthrough()`), el esquema pasa a ser **estricto**: una clave que no
   conoce es un **error** con un mensaje claro ("`entonro`: campo desconocido, ¿quisiste decir
   `entorno`?"). Para experimentar, los campos con prefijo `x-` se guardan tal cual sin validar.
   Además: copiar la carpeta entera con una lista de extensiones permitidas, y límites por tipo
   de archivo (`.step` hasta 10 MB, por ejemplo).
2. **Chip y placa del módulo, separados.** Nueva carpeta `chips/<fabricante-chip>/` (hoy `chips/`
   tiene chips de Wokwi a medio hacer: se puede reusar el lugar) con el comportamiento, los
   registros, los tiempos, los modos, la precisión y el entorno. El módulo dice `"chip":
   "bosch-bme280"` y mapea sus pines a los del chip. Así, el GY-BME280, el de Adafruit y el de
   SparkFun comparten todo lo difícil y solo cambian la placa (regulador, pull-ups, pines, parte).
   Un módulo nuevo que use un chip conocido es **solo datos**.
3. **API de bus por transacción**, no por byte ni por bloque fijo (reemplaza el ejemplo de 5.1):
   ```js
   i2c: {
     direcciones: (ctx) => [ctx.pinEnBajo('SDO') ? 0x76 : 0x77],
     inicio(ctx, { direccion, lectura }) { return true; },     // ACK o NACK
     escribir(ctx, byte) { return true; },                     // ACK o NACK
     leer(ctx) { return 0x60; },                               // un byte
     fin(ctx) {},
   }
   ```
   Para que sea rápido, el motor junta la transacción y llama al sandbox **una vez por transacción**:
   le pasa los bytes escritos y le pide de antemano hasta N bytes para leer (el maestro corta con
   NACK). En avr8js se puede porque `completeRead` se puede diferir.
4. **`registros.json` se ejecuta en código nativo del server**, no en el sandbox: es un dato, no
   código de terceros. Es lo que lo hace rápido (sin el costo de la prueba C) y lo que cubre la
   mayoría de los sensores. Tiene que soportar: escritura por pares o con autoincremento, campos de
   bits, solo lectura, valor de reset, "al escribir X en R, hacer reset", registros sombra en ráfaga
   y registros que se llenan desde `comportamiento.js`.
5. **SPI rápido (pantallas) con camino nativo**: un `framebuffer` declarativo (comandos de columna,
   página y dato del SSD1306 o del ILI9341) que corre en el server. El sandbox solo para lo lento.
6. **`ctx.regulador()` en el SDK** y restringir `fuenteTension` en módulos que no son `source`.
   Corregir la frase de `docs/modulos-y-su-codigo.md`.
7. **Pines con funciones** (`funciones`, `nivelLogico`), y un control deslizante para el `entorno`.
8. **Tests con maestro virtual** de I2C, SPI y UART, y lectura de cualquier nodo del módulo.
9. **Qué emula cada motor, dicho por módulo**: el nivel `certificado` es por motor y lenguaje (por
   ejemplo, "certificado en Uno/Arduino y en ESP32/MicroPython; no emulable en ESP32/ESPHome").
10. **Separar el reloj de la emulación del de la PC** para `tiempos`: en el Uno ya existe (ciclos);
    en el puente de ESP32 hay que llevar el tiempo con los mensajes.

### Lo que se puede agregar (que no estaba)

- **Importar chips de Wokwi con su lógica.** La Chips API de Wokwi tiene la misma forma que la API
  de bus propuesta (I2C: `connect`, `read`, `write`, `disconnect`). Si se implementa ese host,
  los chips de la comunidad de Wokwi (en WASM) funcionan acá. El sandbox hoy prohíbe WASM; habría
  que habilitarlo en un sandbox aparte, sin acceso a nada, como el de los modelos.
- **Grabar y repetir el entorno**: una curva de temperatura en el tiempo para los tests ("de 20 a
  30 °C en 10 s").
- **Inyección de fallas**: el sensor no contesta (NACK), contesta con un byte corrupto, se
  desconecta un cable. Sirve para probar que el firmware del usuario maneja errores.
- **Analizador de bus**: las transacciones que ya pasan por el motor se guardan en la grabadora
  (`debug/grabadora.ts`) y se muestran decodificadas ("0x77 ← escribir F4=0x27"). Sale casi gratis
  de la corrección 3.

### ¿Hace falta un SDK para desarrollar módulos?

**Sí, pero uno chico, que reuse el motor y no sea un producto aparte.** Las pruebas muestran que
"un JSON y un JS sueltos" no alcanzan para que alguien de afuera haga un módulo correcto:

| Problema que apareció | Qué lo resuelve en el SDK |
|---|---|
| El importador perdió bloques sin avisar (A) | **JSON Schema** de `module.json`, `chip.json`, `registros.json` y `tests.json`: el editor autocompleta y marca errores antes de importar. |
| Se pudo crear energía de la nada (B) | **Tipos de TypeScript** del `ctx` con las primitivas permitidas (`regulador`, etc.) y validación al cargar. |
| El costo de llamar al sandbox (C) | El contrato de la API de bus por transacción viene dado por el SDK; el autor no puede hacerlo lento. |
| La compensación al revés (D) | **Helpers**: `invertirMonotona`, campos de bits, enteros con signo de N bits, CRC-8 (DHT, SHT, DS18B20), ruido con semilla. |
| Probar un protocolo | **Maestro virtual** I2C/SPI/UART y un **banco de pruebas** que corre `tests.json` sin levantar la app. |
| Trabajar desde un repo propio de GitHub | **CLI**: `emu-modulo crear`, `validar`, `probar`, `certificar`, `empaquetar` (zip listo para importar). |

Lo que **no** tiene que ser el SDK:
- Un runtime distinto del del server. Tiene que importar el mismo motor (`sim/`), el mismo
  sandbox y el mismo validador, para que "pasa en el SDK" signifique "anda en la app".
- Una librería que haya que aprender aparte. Son los mismos nombres de este documento.
- Un paquete publicado en npm desde el día uno. Arranca como un workspace más (`app/sdk/`), con el
  CLI usable desde el repo y por MCP. Se publica cuando haya autores de afuera.

Sin SDK, el único camino seguro es que todos los módulos los haga la IA por MCP con la app
corriendo. Sirve para el día a día, pero no para que cualquiera implemente un módulo que inventó.

## 7. Un módulo inventado: que no exista en ningún lado

El BME280 (sección 6) es el caso fácil de lo difícil: tiene hoja de datos, librerías y un chip
conocido. El objetivo real es más amplio: **si alguien crea o inventa un módulo, se tiene que poder
implementar acá**, aunque no haya chip en `chips/`, ni librería, ni símbolo de KiCad, y aunque
mida algo o hable un protocolo que la app no conoce.

### Regla de diseño: nada de listas cerradas

Cada lista fija del formato es un módulo inventado que no se puede hacer. Revisión de las que hay
hoy en el código y en este diseño:

| Lista cerrada | Dónde | Qué bloquea | Cómo se abre |
|---|---|---|---|
| Estados del dibujo: `on`, `activo`, `presionado`, `flash`, `sonando`, `boton0..7` | `app/web/modulos.ts` (`estados()`) | Un invento que muestra algo propio ("cargando", "nivel 3 de 5", una aguja) | `data-si` y `{{estado.x}}` leen **cualquier** campo que devuelva `observar()` o el comportamiento en `ui`; además `data-rotar`, `data-escala` y `data-color` con un valor de `ui`. |
| `ui` solo con `on` y `brillo` | `app/shared/src/modelo.ts` | Lo mismo | `ui` libre (números, booleanos y textos cortos, con un tamaño máximo). |
| Roles del puente: `input`, `output`, `rf-rx`, `rf-tx`, `air`, con **un solo pin** | `BRIDGE_ROLES` en `app/shared/src/module.ts` | Cualquier módulo con más de un pin de señal | Que el `comportamiento` maneje todos sus pines (sección 5.1). `bridge` queda solo para los módulos simples de hoy. |
| Tipos de pin (`PinKind`) | `app/shared/src/module.ts` | Pines analógicos de salida, de RF, de alta tensión, de bus | Mantener los tipos básicos para el ERC, pero sumar `funciones` libres por pin (`"i2c.sda"`, `"mi-protocolo.dato"`). |
| Tipos de control: `momentary`, `toggle`, `button` | `ControlDefSchema` | Perillas, deslizantes, teclados, sensores que se mueven | Sumar `deslizante`, `perilla`, `teclado`; y el `entorno` genera sus propios controles. |
| Magnitudes del `entorno` | Sección 5.2 | — | Ya es libre: cualquier nombre con su `unidad`, `min`, `max` y `default`. Mantenerlo así. |
| Tipos de `salidas`: `pantalla`, `luz`, `sonido`, `movimiento`, `texto` | Sección 5.3 | Una salida que no es ninguna de esas | Los tipos conocidos tienen un dibujo hecho; cualquier otra salida se muestra con el `ui` libre y el SVG del módulo. |
| Buses: I2C, SPI, UART, 1-Wire | Sección 5.1 | Un protocolo propio | El evento `pin(ctx, nombre, nivel, t)` con tiempo de emulación y `ctx.escribirPin(nombre, nivel, enMicros)` alcanza para **cualquier** protocolo. Los buses conocidos son atajos rápidos, no el límite. |
| Primitivas eléctricas: R, C, L, D, fuentes, interruptores | `app/shared/src/modelo.ts` | Transistores, op-amps, cargas que dependen del estado | Sumar `regulador` (sección 6), `transistor`, `fuenteControlada` (tensión o corriente controlada por otra tensión) y `carga(potencia)` según el modo. Con eso se arma casi cualquier circuito interno. Si no alcanza, un `subcircuito` SPICE validado. |
| `radio` por banda conocida | Sección 5.9 | Un enlace propio | `radio` con `canal` libre: dos módulos con el mismo canal se escuchan. |

### El camino mínimo de un invento

Lo que tiene que escribir quien inventó el módulo, en orden, sin depender de nada externo:

1. **`module.json` con sus pines.** Ya se dibuja (caja generada), se cablea y se exporta
   (caja + tira de pines + "MPN a completar").
2. **`model.js`**: cuánto consume y cómo se ven sus pines desde afuera (pull-ups, una carga, un
   regulador). Ya entra en el cálculo eléctrico y en los avisos.
3. **`chips/<su-chip>/` desde cero** si tiene lógica: `chip.json` con su `entorno` y sus pines,
   y `comportamiento.js` con eventos de pin (o de un bus conocido, si usa uno). Si el chip lo
   diseñó él, este es **el lugar para describirlo**; si mañana alguien hace otra placa con el
   mismo chip, lo reusa.
4. **`module.svg`** con partes que reaccionan a su `ui` libre (si no, la caja generada).
5. **`tests.json`** con sus propios valores (no hace falta una hoja de datos publicada: los
   números los pone el autor).
6. **`ejemplos/`** con el código que lo usa. Como no hay librería publicada, el ejemplo **es** el
   driver: se compila con el proyecto. Para Arduino, una carpeta `ejemplos/arduino/` con `.h` y
   `.cpp` se copia al sketch.
7. **`esquematico.hoja`**: su propio `.kicad_sch` si ya lo dibujó; si no, el despiece `discreto`;
   si no, la caja. Para fabricar el invento hace falta el circuito interno de alguna de esas formas.

Cada paso es opcional y sube un nivel de soporte (sección "Principio").

### Qué no se puede (y hay que decirlo claro)

- **Si el invento es una placa con un microcontrolador propio** (un chip que corre su propio
  firmware), el comportamiento en JS es una aproximación, no una emulación del chip. Para emularlo
  de verdad, hace falta un **motor** para ese micro (`app/server/src/engines/`), como con el Uno y
  el ESP32. Si es de una familia conocida (AVR, RISC-V, Cortex-M con Renode), es una placa más
  (ver `docs/vision-y-alcance.md`).
- **Física que el motor no calcula**: térmica, mecánica, óptica, RF real (alcance, interferencia).
  El módulo puede declararla en su `comportamiento` con el `entorno`, pero es una aproximación del
  autor, no un cálculo del motor. El nivel de soporte lo tiene que mostrar.
- **Señales rápidas o analógicas en el tiempo** (audio, PWM fino, osciladores) dependen del
  análisis transitorio, que todavía no existe (ver `falta.md`).

### Verificación de que es realmente genérico

Antes de dar por cerrado el formato, implementar con él **un módulo inventado a propósito**, que no
exista en ningún lado y que no use ningún bus conocido. Propuesta: un "medidor de nivel de agua" con
un protocolo propio de un solo cable (pulso de inicio + 8 bits por ancho de pulso), una salida de
barra de 5 LEDs dibujada con `ui` libre, un `entorno` "nivel" en litros y un consumo que cambia al
medir. Si eso se puede hacer sin tocar el código de la app, el formato es abierto.

## 8. Implementado y aprendido (2026-10-01)

Se tomó la parte de módulos complejos (secciones 5 y 6) y se la llevó a código con chips reales,
probados contra su hoja de datos y con el firmware que usa la gente. Guía para escribir un chip:
[`chips/README.md`](chips/README.md).

### Qué quedó hecho

| Pieza | Dónde |
|---|---|
| Bus I2C del Uno hacia los chips del dibujo (TWI de avr8js), con los tiempos del bus real según SCL | `app/server/src/avrSim.ts` (`conectarI2c`), `app/server/src/bus/busI2c.ts` |
| Chips en sandbox, una llamada por transacción, estado adentro del sandbox | `app/server/src/bus/chipSandbox.ts` |
| Chips separados de las placas (corrección 2 de la sección 6) | `chips/<id>/`, `modules/*/module.json` → `chips` |
| Pines que maneja un chip (INT, SQW) como líneas de colector abierto compartidas, y despertadores | `ctx.pin`, `ctx.despertarEn`; `LineasCompartidas` en `bus/armarBus.ts` |
| Entorno por instancia, guardado en el proyecto y movible en vivo (UI, API, MCP) | `bus/rutasChips.ts`, `web/app.ts` (`seccionChip`), MCP `chips` y `mover_entorno` |
| Pantallas: el chip publica la imagen y la app la dibuja sobre `data-pantalla` | `web/modulos.ts` (`urlPantalla`) |
| `ctx.regulador` y `ctx.bateria` (corrección 6) | `shared/src/modelo.ts`, `sim/netlist.ts` |
| Librerías de Arduino por módulo (`drivers`) y por proyecto (`librerias.txt`) | `toolchains/arduinoCli.ts` |
| Maestro I2C virtual para probar chips (parte del SDK de la sección 6) | `bus/maestroVirtual.ts` |
| Chips: BME280, DS3231, AT24C32, SSD1306, MPU-6050. Módulos: `bme280-adafruit`, `ds3231-zs042`, `oled-ssd1306-128x64`, `mpu6050-gy521` | `chips/`, `modules/` |
| Memoria no volátil de los chips (`ctx.guardar` / `ctx.guardado`): la EEPROM y la hora con pila siguen entre ejecuciones, en `projects/<p>/.chips/` | `bus/memoriaChips.ts`, `avrWorker.ts` |
| Bus SPI del Uno (`AVRSPI`): CS, DC, modos, orden de bits, `entradas` (RESX); el BME280 también por SPI | `bus/busChips.ts`, `avrSim.ts` |
| Chip ST7735 y módulo `tft-st7735-128x160` (pantalla a color, imagen RGB565 en el circuito) | `chips/sitronix-st7735/`, `modules/` |
| Chips en ESP32 con MicroPython: el puente reemplaza `machine.I2C`/`SoftI2C`/`SPI`/`SoftSPI`; cualquier par de pines (`board.buses.matriz`) | `templates/micropythonBridge.ts`, `bus/puenteChips.ts`, `emulator.ts` |

Pruebas: de 418 a 610 tests unitarios (los de chips: maestro virtual + firmware real compilado con
las librerías de verdad), y e2e con Playwright para el panel, la compilación con librerías y la
pantalla en el circuito.

### En qué se apartó del diseño

- **`registros.json` no se hizo.** Con una llamada por transacción, el sandbox alcanza para I2C a
  400 kHz y cada chip real resultó tener lógica que un mapa de registros no expresa (el
  `ctrl_hum` del BME280 que espera a `ctrl_meas`, los cambios de modo diferidos, las alarmas del
  DS3231, los remapeos del SSD1306). Sigue siendo una buena idea para sensores simples, no un
  requisito.
- **La API del bus es por segmento**, no por byte (`escribir(bytes)` al cerrar el segmento,
  `leer(n)` pedido de antemano + `leidos(k)`). Alcanza para todo lo que se hizo; lo que no permite
  es un NACK a mitad de una escritura (ningún chip de los cinco lo necesita).
- **`chips` es una lista** (no `chip`): la ZS-042 lleva dos chips en el mismo bus.
- **Props por cableado** (`porCableado`): SDO a GND cambia la dirección como en la placa real, en
  vez de una prop suelta que el usuario tiene que acordarse de cambiar.
- **`arranqueMs` en la placa**: el tiempo entre la alimentación y la primera instrucción del micro.

### Lo que se aprendió

1. **Las librerías reales encuentran lo que el diseño no.** Adafruit_BME280 configura el modo
   forzado justo después de dejar el sensor en modo normal x16: por la hoja (3.3.1) la humedad
   queda en x16 y cada medición tarda 38 ms en vez de 8. Es real y está documentado en otras
   librerías ([issue #40 de SparkFun](https://github.com/sparkfun/SparkFun_BME280_Arduino_Library/issues/40)).
2. **El tiempo de la placa es parte de la fidelidad.** Sin modelar los 65 ms de arranque del Uno
   (fusibles), `begin()` del BME280 fallaba porque el sensor todavía no contestaba (2 ms).
3. **Los errores casi nunca estuvieron en el chip.** Varias pruebas fallaron por cuentas mal hechas
   en el test (ruido de 106 LSB y no 40, −10,25 °C en complemento a dos, osrs 16 en vez del código
   5). Escribir las pruebas contra la hoja, con la cuenta a la vista, las corrigió.
4. **Bajo carga aparecen los límites.** Un chip que hace mucho trabajo en una llamada (alarmas
   segundo a segundo) pasa el tiempo límite del sandbox solo cuando la suite corre en paralelo: hay
   que acotar el trabajo por llamada por diseño, no por suerte.
5. **Los avisos falsos se ven en la UI, no en los tests.** "Conectá 3VO" (3VO es una salida) y "el
   código no usa A5" (lo usa Wire) solo aparecieron en las capturas de Playwright.
6. **Un chip que no valida desaparecía en silencio** (una etiqueta de 41 caracteres): ahora un test
   exige que todos los chips de fábrica carguen.
7. **La electrónica de la placa da sorpresas reales.** La ZS-042 a 5 V carga una CR2032 con ~6 mA;
   el GY-521 tiene los pull-ups a 3,3 V. Solo se ve modelando la placa desde su esquemático.
8. **Guardar al apagar necesita tiempo.** La hora del RTC se guarda en el evento `apagar`, que corre
   en el hilo del emulador: parar tiene que esperar a que conteste (hasta 3 s; con 1 s, bajo carga, se
   perdía). Y hay que parar la corrida anterior antes de cambiar de proyecto, si no se guarda en el
   proyecto equivocado.
9. **Las variantes de una placa genérica son parte del módulo.** Las TFT ST7735 de 1,8" vienen con
   tres paneles distintos; con el `initR` equivocado la imagen sale corrida y con rojo y azul
   cambiados, como en la vida real. Es una prop (`pestana`), con el síntoma documentado.
10. **El escáner de pines también tiene que entender las librerías.** Con `SPI.h` y
    `Adafruit_ST7735 tft(10, 9, 8)`, el código no nombra D13/D11 ni usa `pinMode` en 10/9/8: se
    avisaba "módulo cableado a un pin que el código no usa". Ahora cuenta el bus SPI y los pines del
    constructor.

### Lo que sigue pendiente de este documento

- Secciones 1 a 4: `parte`, `esquematico` (exportar), `reglas` declarativas y `tests.json` por
  módulo. Los chips de esta sección tienen sus tests en `app/server/src/bus/`, no en su carpeta.
- Importar chips (hoy los chips solo vienen de fábrica, en `chips/`) y la corrección 1 del importador.
- Chips en ESP32 con Arduino o ESP-IDF (esp-emu no los acepta; ESPHome se va a quitar del proyecto).
  En MicroPython ya andan; falta que el tiempo de cada transacción sea el del bus real.
- El consumo de un chip según su modo (el modelo eléctrico del módulo no conoce el estado del chip),
  y el brillo de una pantalla según la corriente de su retroiluminación.
- Tarjeta SD por SPI (con una imagen FAT guardada con `ctx.guardar`, o un archivo aparte si pasa de 64 KB).

## Crear un módulo real, paso a paso

Cada paso es opcional y sube un nivel; se puede parar en cualquiera.

1. `crear_modulo` (MCP) o `emu-modulo crear <tipo>` (CLI del SDK) genera la carpeta con plantillas.
   Si el chip ya existe en `chips/` (por ejemplo `bosch-bme280`), el módulo solo dice `"chip"` y
   mapea sus pines: el comportamiento viene hecho.
   Con solo esto ya se dibuja, se cablea y se exporta como caja genérica.
2. **Eléctrico**: `model.js` con el consumo y el circuito de entrada de la hoja de datos, y sus `reglas`.
3. **Funcional** (si el módulo habla o mide algo): `entorno` y `salidas`; después `registros.json`,
   o `comportamiento.js` si no alcanza; `tiempos`, `modos` y `precision` de la hoja de datos.
4. **Probado**: `tests.json` con los valores de la hoja de datos; `probar_modulo` en verde. También
   comprueba que el despiece coincida con `model.js` y que el símbolo tenga todos los pines.
5. **Certificado**: `drivers` y `ejemplos/`; `certificar_modulo` compila el ejemplo, lo emula y
   compara lo que imprime con el `entorno`.
6. **Fabricable**: `parte` y `esquematico` (o la `hoja` de referencia del fabricante), `mecanica`.
7. Importarlo como hoy: carpeta, zip, URL o GitHub.

## El esquemático exportado del proyecto

Referencia: el esquemático de referencia del ESP32 de Espressif (chip, cristal, capacitores de
desacople, flash/PSRAM, antena). **Así tiene que salir, pero del proyecto entero.**

- **Componentes con referencia y valor** (R1, C14, "10nF/6.3V(10%)", "NC").
- **Etiquetas de red en vez de cables largos** (GPIO21, U0TXD) y **símbolos de alimentación**
  (3V3, GND). Esto es lo que lo hace fácil y robusto: no hay que calcular por dónde pasan los
  cables entre módulos, solo ponerle a cada pin la etiqueta de su red.
- Las redes toman el nombre del pin de la placa (GPIO4, 3V3, GND).
- **Notas** junto a cada bloque, de `esquematico.notas` y de las `reglas`.
- **Una hoja principal con un bloque jerárquico por módulo**. Cada bloque usa la `hoja` del
  módulo si la tiene; si no, su despiece `discreto`; si no, la caja generada. KiCad maneja hojas
  jerárquicas de forma nativa.

Límite: la hoja principal la acomoda la app, así que va a quedar ordenada pero no tan prolija
como una dibujada a mano. Las hojas de cada módulo sí quedan iguales al original.

**Salidas:**

| Archivo | Para qué |
|---|---|
| `.kicad_sch` | Abrirlo en KiCad y seguir hasta el PCB y los Gerber. |
| BOM `.csv` (formato JLCPCB/PCBWay) | Comprar o mandar a ensamblar. Sale de `parte` y `discreto[].mpn`. |
| `.json` | Que lo lea una IA: lo mismo, más las tensiones y corrientes calculadas por el motor. |
| `.svg` / `.pdf` | Imprimir o adjuntar, con los símbolos `base`. |
| `.cir` (SPICE) | Correrlo en LTspice o ngspice. Sale de los `model.js`. |

## Archivos a tocar

Secciones 1 a 4 (esquemático, reglas, tests):

- `app/shared/src/module.ts`: tipos y validación de los bloques nuevos.
- `app/server/src/sim/analisis.ts`: evaluar las reglas dinámicas junto a los avisos de `observar()`.
- Nuevo `app/server/src/sim/pruebasModulo.ts`: corre los `tests.json` (reusa `analizarCircuito` y
  `sim/sandbox.ts`; los helpers de `sim/comparacion.test.ts` muestran cómo armar un proyecto sin placa).
- `app/server/src/moduleImporter.ts`: aceptar los archivos nuevos y correr los tests al importar.
- `app/server/src/mcp.ts`: `probar_modulo`, `crear_modulo`.
- `modules/*`: sumar los bloques a los 15 módulos de fábrica y migrar las reglas simples de `model.js`.
- Docs: `modules/README.md` y `docs/modulos-y-su-codigo.md`.

Correcciones de la prueba del BME280 (sección 6):

- `app/shared/src/module.ts`: no borrar claves desconocidas; `funciones` y `nivelLogico` por pin;
  `chip` y su mapeo de pines; control deslizante.
- `app/server/src/moduleImporter.ts`: copiar la carpeta entera con extensiones permitidas
  (`.yaml`, `.ino`, `.py`, `.kicad_sch`, `.step`…) y límites por tipo; avisar lo que no conoce.
- `app/shared/src/modelo.ts` + `app/server/src/sim/sandbox.ts`: `ctx.regulador()` (reusa
  `reguladorLineal` de `sim/placa.ts`); restringir `fuenteTension`; llamadas con script
  precompilado y por lote.
- Nuevo `app/sdk/`: JSON Schemas, tipos, helpers (`invertirMonotona`, bits, CRC, ruido), maestro
  virtual, CLI.

Sección 5 (módulos complejos):

- Motores: en `avrSim.ts`, conectar `AVRTWI` y `AVRSPI` a los módulos (avr8js ya los trae).
  En ESP32 con MicroPython, reemplazar `machine.I2C`/`SPI` en `templates/micropythonBridge.ts`.
  esp-emu no admite dispositivos I2C/SPI propios.
- Nuevo `app/server/src/sim/comportamiento.ts`: carga `comportamiento.js` y `registros.json` en el
  sandbox, enruta los eventos de bus y pin, y lleva los temporizadores.
- `app/web/`: controles del `entorno` en el panel del módulo; dibujo de `salidas` (lienzo para
  pantallas, color por LED, ángulo animado).
- `app/server/src/certificacion.ts`: `certificar_modulo`, reusando lo que ya hace `certificar_placa`.
- Gestor de librerías de Arduino en `app/server/src/toolchains/arduinoCli.ts` (para `drivers`).

## Orden

0. **Formato 2 y limpieza** (sección "Se puede cambiar todo"): esquema estricto, borrar los flags
   y `bridge`, `ui` libre, `ctx.regulador()`, importador que copia la carpeta entera, y el script
   de migración de los proyectos locales. Va primero porque todo lo demás se construye encima, y
   cambiar el formato después cuesta más.
1. **Tests declarativos** + `probar_modulo`. Da valor enseguida y protege todo lo que viene.
2. **Reglas declarativas**: primero las dinámicas, después las de ERC.
3. **`parte` + símbolo y huella** en los 15 módulos de fábrica. El circuito interno llega con la
   puerta A (paso 5), que reemplaza la validación cruzada contra `model.js`.
4. **Exportador**: KiCad + BOM primero, después JSON, SVG/PDF y SPICE.
5. **Las dos puertas**: puerta B primero (`pines` con su lado eléctrico + `comportamiento.json`),
   porque no depende de KiCad y cubre la mayoría de los módulos simples; después puerta A
   (netlist `.net`/`.cir` directa, y luego `.kicad_sch` con `kicad-cli` en Docker).
6. **SDK chico** (`app/sdk/`): JSON Schema, tipos, helpers, maestro virtual y CLI. Crece junto
   con los puntos siguientes, no antes.
7. **Módulos complejos** (sección 5): chips separados de las placas, I2C del Uno conectado a los
   módulos con la API por transacción, `registros.json` nativo + `entorno` + `salidas`, y la
   certificación con `ejemplos/`. Primer módulo: el BME280 de la sección 6, en Uno/Arduino; después
   MicroPython en ESP32 reemplazando `machine.I2C` por el puente.

## Cómo se verifica

- `npx vitest run`: los `tests.json` de los 15 módulos pasan.
- Romper a propósito un `model.js` (bobina de 7 Ω en vez de 70 Ω): su test falla y muestra el valor medido.
- Importar un módulo con un test que falla: el importador lo rechaza y dice qué caso falló.
- `probar_modulo relay` por MCP: informe caso por caso.
- Exportador: el `.kicad_sch` abre en KiCad 8+ con símbolos y huellas resueltos, el ERC de KiCad
  no da errores y la BOM tiene un MPN por línea.
- Importador: reimportar la carpeta de prueba de la sección 6 conserva `parte`, `reglas`,
  `entorno`, `tests.json`, `ejemplos/` y el `.kicad_sch`; lo que no conoce lo guarda y avisa.
- Energía: con VIN en 0 V, el BME280 (con `ctx.regulador`) no tiene tensión en 3VO, y la fuente
  externa entrega la corriente que consume el sensor más la propia del regulador.
- Módulo complejo (BME280): con el entorno en 22 °C, el ejemplo de **Arduino en el Uno** imprime
  22 ± 1 (la precisión de la hoja); al mover el control a 30 °C, el valor cambia; leer antes del
  tiempo de medición devuelve el valor viejo; `tests.json` con el maestro virtual lee 0x60 en 0xD0.
  Después, lo mismo con **MicroPython en ESP32**. ESPHome, ESP-IDF y Arduino-ESP32 quedan "no
  emulables" hasta que esp-emu admita dispositivos I2C (sección 6, prueba E).
- Rendimiento: un sketch que lee el BME280 en bucle a 400 kHz no hace que el Uno corra más lento
  que el tiempo real por culpa del comportamiento.
- Formato abierto: el "medidor de nivel de agua" inventado de la sección 7 (protocolo propio de un
  cable, `ui` libre, `entorno` propio) se implementa e importa **sin cambiar código de la app**, y
  un sketch del Uno lo lee con el driver de su carpeta `ejemplos/`.
- Puerta A: el `.kicad_sch` del relé de fábrica (R, transistor, diodo, bobina) importado sin
  `model.js` da las mismas corrientes que el `model.js` de hoy dentro del 5 %.
- Puerta B: un PIR descrito solo con `pines` + `comportamiento.json` (sin código) prende su
  salida al mover el control de movimiento, la mantiene `retardo_ms` y consume lo declarado.
