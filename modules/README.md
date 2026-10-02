# Módulos: cómo tiene que ser uno

Un **módulo** es una pieza real que se cablea en el circuito: una resistencia, un LED, un relé, un
sensor en su placa, una pantalla, una placa programable. Cada uno vive en su carpeta
`modules/<tipo>/` y dice de sí mismo todo lo que hace falta para **dibujarlo, simularlo, probarlo y
fabricarlo**.

La regla de diseño: **lo único obligatorio es el `module.json` con sus pines.** Todo lo demás es
opcional y tiene un valor por defecto que la app genera sola, así un módulo inventado ayer anda
desde el primer día. Lo que se le agrega lo hace subir de nivel:

| Nivel | Qué tiene | Qué se puede hacer |
|---|---|---|
| `dibujo` | `module.json` con pines (y su `module.svg`) | Dibujarlo y cablearlo. No consume ni hace nada. |
| `simula` | + un modelo eléctrico (`model.ts` o los flags), un rol en la simulación o chips | Simularlo: consume, se prende, se quema, avisa. |
| `probado` | + `tests.json` con casos de su hoja de datos, que pasan | Confiar en lo que simula: lo verifica el motor real en cada cambio. |
| `fabricable` | + `parte` (qué se compra) y `esquematico` con su huella | Exportarlo para fabricar: símbolo, huella, BOM. |

Los módulos de fábrica tienen que llegar a **`fabricable`**: lo exige
`app/server/src/sim/catalogoModulos.test.ts`. El nivel de cada módulo y lo que le falta se ven en su
panel (sección **Pieza real**), en `GET /api/modules` (`nivel`) y en las herramientas MCP `catalogo`
y `probar_modulo`.

## La carpeta

```
modules/relay/
├── module.json   # obligatorio: qué es, pines, props, simulación, parte, esquemático, reglas
├── module.svg    # el dibujo (sin él: una caja con su nombre)
├── model.ts      # su circuito interno en TypeScript, para el motor eléctrico (ver ../docs/modulos-y-su-codigo.md)
└── tests.json    # sus pruebas, con valores de la hoja de datos
```

Si el módulo tiene **lógica digital** (un sensor que habla I2C, una pantalla, un reloj), esa lógica
es un **chip** y vive aparte, en `chips/<id>/` (ver [`../chips/README.md`](../chips/README.md)). El
módulo lo usa con `chips` y le agrega lo que es de la placa: regulador, pull-ups, LED, conector.
Así varias placas comerciales con el mismo chip comparten lo difícil.

No hace falta tocar el código de la app para agregar un módulo: se importa desde la UI
(**+ Importar**), por la API (`POST /api/modules/import`) o por MCP (`importar_modulo`), o se copia la
carpeta acá y se reinicia el server. Antes de instalarlo, el importador **corre su banco de
pruebas**: si algo falla, no se instala y dice qué se midió.

## module.json

### Qué es y cómo se ve

```json
{
  "type": "zumbador",
  "name": "Zumbador",
  "category": "Salidas",
  "description": "Suena cuando el pin está en 1. Activo de 5 V, 30 mA.",
  "width": 60,
  "height": 60,
  "pins": [
    { "name": "SIG", "x": 20, "y": 60, "kind": "digital-in" },
    { "name": "GND", "x": 40, "y": 60, "kind": "ground" }
  ],
  "bridge": { "role": "output", "pin": "SIG" },
  "controls": [],
  "props": { "etiqueta": { "type": "string", "default": "BZ", "label": "Rótulo" } },
  "model": "model.ts"
}
```

| Campo | Qué es |
|---|---|
| `type` | Id del módulo y nombre de la carpeta: `[a-z0-9-]`, hasta 40. |
| `name`, `category`, `description` | Lo que se ve en el catálogo. Las categorías nuevas aparecen solas. La descripción dice para qué sirve y cómo se conecta. |
| `width`, `height` | Tamaño del dibujo, en las mismas unidades que el SVG. |
| `pins` | `name` (único, `[A-Za-z0-9_+-]`, **el mismo que está serigrafiado en la placa real**), posición `x`,`y` dentro del módulo (normalmente en el borde) y `kind`: `digital-in`, `digital-out`, `digital-io`, `power`, `ground`, `analog-in`, `other`. **En el orden físico del conector**: ese orden es el de la huella por defecto. |
| `controls` | Qué se puede tocar: `momentary` (mientras se mantiene), `toggle` (alterna), `button`. |
| `props` | Propiedades editables en el panel: `type` `string`/`number`/`boolean`, `default`, `label`, `enum`, `min`, `max`. |
| `vars` | Valores para el SVG que dependen de una propiedad (ver [module.svg](#modulesvg)). |

### Cómo se simula

| Campo | Qué es |
|---|---|
| `model` | Su código, en **TypeScript** (`"model": "model.ts"`): un archivo de la carpeta que describe su circuito interno con elementos físicos (resistencias, diodos, fuentes, reguladores...) y lo que muestra. Cómo se escribe: [Código del módulo en TypeScript](#código-del-módulo-en-typescript) y [`../docs/modulos-y-su-codigo.md`](../docs/modulos-y-su-codigo.md). |
| `passthrough` + `ohmsProp`, `diode`, `switch`, `source` | Sin `model`: flags que le arman un modelo básico (resistencia, diodo, contacto, fuente). |
| `electrical` | Datos de hoja de datos de un LED: `maxCurrentMa` (recomendado) y `burnCurrentMa` (se quema). |
| `bridge` | Cómo participa en la simulación del firmware: `role` `input` (maneja un pin del micro, como un botón; `activeLevel` 0 o 1), `output` (muestra el nivel de un pin, como un LED), `rf-rx` / `rf-tx` (radio 433 MHz), `air` (inalámbrico, sin cables); `pin`: cuál de sus pines. |
| `chips` | Los chips con lógica de la placa: `id` (de `chips/`), `pines` (pin del módulo → pin del chip), `porCableado` (props que salen del cableado: SDO a GND → dirección 0x76) y `pullUps`. |
| `drivers` | Librerías del código para este módulo: `{ "arduino": { "librerias": ["RTClib@2.1.4"] } }`. Se instalan solas al compilar. |
| `programmable` + `board` | Es una **placa**: corre el código del proyecto. Esquema del bloque `board`: `GET /api/boards/schema`; ejemplos en `arduino-uno/` y `esp32-*/`. |

### `parte`: qué se compra

Para la lista de materiales (BOM) y para encontrarlo en un proveedor.

```json
"parte": {
  "fabricante": "Kingbright",
  "mpn": { "prop": "color", "map": { "red": "WP7113ID", "blue": "WP7113QBC/D" }, "default": "WP7113ID" },
  "descripcion": "LED de 5 mm (T-1 3/4), 20 mA",
  "datasheet": "https://...",
  "proveedores": [{ "nombre": "Adafruit", "sku": "2652", "url": "https://www.adafruit.com/product/2652" }]
}
```

| Campo | Qué es |
|---|---|
| `fabricante` | Quién lo hace. En una placa genérica, `"genérico (Bosch BME280)"`: el fabricante del chip entre paréntesis. |
| `mpn` | Número de parte del fabricante. Si depende de una prop: una plantilla (`"CFR-25JB-52-{{props.ohms\|codigoR}}"` → `CFR-25JB-52-4K7`) o un mapa por valor (como el LED de arriba). Filtros: `ohms` (4k7) y `codigoR` (4K7, 220R). |
| `generico` | `true` para placas sin un número de parte único (ZS-042, GY-521, el relé de un canal): se compran por nombre. El exportador lo marca. |
| `descripcion`, `datasheet`, `proveedores` | Opcionales. Las URLs tienen que ser `https://`. |

**Un número de parte se verifica antes de escribirlo** (en el sitio del fabricante o de un
distribuidor). Si no se sabe, mejor `generico: true` con una descripción clara que un MPN inventado.

### `esquematico`: símbolo, huella y despiece

Para exportar el proyecto a KiCad y mandarlo a fabricar.

```json
"esquematico": {
  "referencia": "A",
  "valor": "Relé 5 V {{props.label}}",
  "huella": "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical",
  "pines": { "IN": "1", "VCC": "2", "GND": "3" },
  "fabricacion": "modulo",
  "notas": ["Los contactos (COM, NA, NC) van en la bornera del módulo."],
  "discreto": [
    { "ref": "R", "valor": "1k", "simbolo": "Device:R", "huella": "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal",
      "elemento": "rbase", "nodos": { "1": "IN", "2": "base" } },
    { "ref": "Q", "valor": "S8050", "simbolo": "Transistor_BJT:S8050", "huella": "Package_TO_SOT_THT:TO-92_Inline",
      "elemento": "transistor", "nodos": { "1": "GND", "2": "base", "3": "bobina" } }
  ]
}
```

| Campo | Qué es | Si no está |
|---|---|---|
| `fabricacion` | `modulo`: se compra la placa y se enchufa en su conector (un breakout). `discreto`: la pieza va soldada (una resistencia, un LED). `externo`: no va en la placa (una fuente de laboratorio, un control remoto): solo en la BOM, y un conector si tiene cables. | `modulo` |
| `referencia` | Prefijo: `R`, `C`, `D`, `Q`, `K`, `SW`, `J`, `U`, `A` (un módulo armado). | `U` (`A` en una placa) |
| `valor` | Lo que se escribe al lado del símbolo. Admite `{{props.x}}`. | El nombre del módulo |
| `simbolo` | Símbolo de las librerías oficiales de KiCad: `"Biblioteca:Nombre"`. | Una caja con los pines del módulo |
| `huella` | Huella de KiCad. | Una tira de pines de 2,54 mm con tantos pines como el módulo, en su orden |
| `pines` | Pin del módulo → número de pin del símbolo y la huella. **Obligatorio con `simbolo`**, y tiene que nombrar todos los pines. | 1, 2, 3... en el orden de `pins` |
| `conectores` | En vez de `huella`: varios conectores, cada uno con sus pines en orden (un DevKit con dos tiras). Cada pin del módulo en uno solo. | — |
| `discreto` | El despiece real, para fabricar el módulo en vez de comprarlo: cada pieza con `ref`, `valor`, `simbolo`, `huella` y `nodos` (número de pin → pin del módulo **o nodo interno del `model.ts`**). `elemento` dice qué elemento del modelo la representa. | — |
| `notas` | Lo que hay que saber al armarlo ("SDO a GND = 0x76"). | — |

Lo que se valida (y si no, no se instala):

- los pines de `pines` y `conectores` existen, y no queda ninguno afuera;
- cada `nodos` del despiece es un pin del módulo o un nodo de su `model.ts` (`ctx.nodo('base')` →
  `"base"`), y cada `elemento` existe en el modelo: **el esquemático no puede mentir respecto de lo
  que se simula**;
- en los de fábrica, cada símbolo y huella está en
  [`../app/server/src/fixtures/kicad-verificados.txt`](../app/server/src/fixtures/kicad-verificados.txt),
  la lista verificada contra las librerías oficiales de KiCad
  ([símbolos](https://gitlab.com/kicad/libraries/kicad-symbols), [huellas](https://gitlab.com/kicad/libraries/kicad-footprints)).
  Para usar uno nuevo: buscarlo ahí, mirar la numeración de sus pines en el archivo del símbolo, y
  sumarlo a la lista.

La numeración de pines sale del símbolo de KiCad, no de la intuición: en `Device:LED` el 1 es el
cátodo (K) y el 2 el ánodo (A); en `Transistor_BJT:S8050` (EBC) 1 = E, 2 = B, 3 = C; en
`Relay:SANYOU_SRD_Form_C` la bobina es 2-5.

### `reglas`: los límites de la hoja de datos

Los máximos y mínimos de la hoja de datos, dichos como datos. El motor eléctrico los evalúa en cada
cálculo con los mismos valores que ve el modelo, y los avisos salen en el circuito, en Problemas y
en el MCP con el nombre del módulo adelante.

```json
"reglas": [
  { "tipo": "tensionMax", "entre": ["VCC", "GND"], "max": 6, "severidad": "peligro", "mensaje": "VCC en {v} V: el máximo es 5,5 V, se daña." },
  { "tipo": "tensionMin", "entre": ["VCC", "GND"], "min": 3.3, "mensaje": "VCC en {v} V: necesita al menos 3,3 V." },
  { "tipo": "potenciaMax", "elemento": "r", "maxMw": 250, "severidad": "advertencia" },
  { "tipo": "corrienteMax", "elemento": "bobina", "maxMa": 90 },
  { "tipo": "conectado", "pines": ["GND"] }
]
```

| Tipo | Avisa cuando | Severidad por defecto |
|---|---|---|
| `tensionMax` | V(`entre[0]`) − V(`entre[1]`) pasa `max`. Con `entre` al revés sirve para la tensión inversa (un LED: `["GND", "IN"]`). | `peligro` |
| `tensionMin` | Está por debajo de `min`, pero solo si hay algo aplicado (más de `desde`, 0,5 V por defecto): sin alimentar no molesta. | `advertencia` |
| `corrienteMax` | \|I\| de un elemento del `model.ts` pasa `maxMa`. | `peligro` |
| `potenciaMax` | \|P\| de un elemento pasa `maxMw`. | `peligro` |
| `conectado` | Alguno de esos pines no tiene cable (no hace falta simular). | `advertencia` |

- `mensaje` puede llevar el valor medido: `{v}` (V), `{ma}` (mA), `{mw}` (mW), `{w}` (W con 2
  decimales). Sin `mensaje`, la app arma uno con el límite.
- **De varias reglas que miran lo mismo, sale solo la más grave**: con 0,25 W (advertencia) y 0,5 W
  (peligro) sobre la misma resistencia, a 0,77 W sale solo "se quema".
- **Cuándo una regla y cuándo `observar()`**: un límite fijo de la hoja de datos es una regla. Lo que
  depende de varias cosas a la vez (el relé que no pega con menos del 75 % de su corriente, el
  regulador en caída, una pila que no es recargable recibiendo carga) va en `observar()` del
  `model.ts`. Nunca los dos para lo mismo: el aviso saldría repetido.

## Código del módulo en TypeScript

**Todo el código de un módulo está en TypeScript**: `model.ts`. El server le quita los tipos al
cargarlo (con `typescript`, sin resolver imports ni ejecutar nada) y corre el JavaScript resultante en
su sandbox. Se escribe siempre igual, con los tipos de `@emu/shared`:

```ts
import type { AvisoModelo, ModeloModulo } from '@emu/shared';

export default {
  circuito(ctx) {
    ctx.resistencia(ctx.pin('VCC'), ctx.pin('GND'), 167, 'bobina');
  },
  observar(l) {
    const avisos: AvisoModelo[] = [];
    if (l.vEntre('VCC', 'GND') > 6) avisos.push({ severidad: 'peligro', mensaje: 'Se daña.' });
    return { ui: { on: l.i('bobina') > 0.005 }, avisos };
  },
} satisfies ModeloModulo;
```

- **`export default { ... } satisfies ModeloModulo`**: así `ctx` y `l` ya vienen tipados (el editor
  autocompleta `ctx.regulador(...)`, `l.vEntre(...)`) y un error de nombre o de argumentos se ve al
  escribir, no al correr.
- **Solo `import type`**: un módulo no puede importar nada en tiempo de ejecución (el sandbox no tiene
  `require`). Los tipos se borran al transpilar. Un `import` de verdad se rechaza al importar, con
  ese motivo.
- **Los tipos se verifican de verdad**, en modo estricto, con `modules/tsconfig.json`:

  ```bash
  cd app && npm run typecheck:modulos
  ```

  El test del catálogo (`sim/catalogoModulos.test.ts`) lo corre, así que un `model.ts` de fábrica que
  no compila rompe los tests. Con `strict`, `const avisos = []` falla (se ensancha a `any[]`): hay que
  escribir `const avisos: AvisoModelo[] = []`; y `l.estado` es `Record<string, unknown>`, por lo que un
  contador se lee `Number(l.estado.veces ?? 0)`.
- **Un error de sintaxis se informa con su línea**: `model.ts (línea 12): ...`. El importador no
  chequea los tipos (eso es del editor y de `typecheck:modulos`): solo exige que transpile, cargue y
  arme su circuito.
- Los módulos importados de antes, con `model.js` (`module.exports = {...}`), siguen cargando. Los de
  fábrica tienen que ser `.ts` (lo exige el test del catálogo) y todo módulo nuevo debería serlo.

Los **chips** (`chips/<id>/comportamiento.js`) siguen en JavaScript: corren en otro sandbox con otra API
(`ctx.publicar`, `ctx.despertarEn`...) y no son un módulo.

## tests.json: el módulo se prueba a sí mismo

Cada caso arma un **banco** alrededor del módulo con piezas de fábrica, lo resuelve con el motor
eléctrico real (ngspice) y compara con lo que dice la hoja de datos. **Siempre con rangos**: las
piezas reales tienen tolerancia.

```json
[
  {
    "nombre": "con 5 V e IN en 3,3 V: la bobina (70 Ω) toma ~70 mA y pega",
    "banco": { "VCC": { "fuente": 5 }, "GND": "tierra", "IN": { "fuente": 3.3 } },
    "espera": { "corrienteMa": { "bobina": [65, 72] }, "ui": { "on": true }, "sinAvisos": true }
  },
  {
    "nombre": "con 3 V en VCC no alcanza para cerrar el contacto",
    "banco": { "VCC": { "fuente": 3 }, "GND": "tierra", "IN": { "fuente": 3.3 } },
    "espera": { "ui": { "on": false }, "avisos": [{ "severidad": "advertencia", "contiene": "no alcanza" }] }
  }
]
```

| Campo | Qué es |
|---|---|
| `nombre` | Qué se prueba y qué tiene que pasar, en una frase. Es lo que se lee cuando falla. |
| `props` | Props del módulo para este caso (`{ "color": "blue" }`). Las demás, las de por defecto. |
| `control` | `true`: su control activo (pulsador apretado, llave encendida). |
| `banco` | Qué se conecta a cada pin (los que no aparecen quedan sueltos). |
| `espera` | Lo que se tiene que cumplir (todo junto). |

Lo que se le puede conectar a un pin en el `banco`:

| Conexión | Qué es |
|---|---|
| `"tierra"` | GND del banco. |
| `{ "fuente": 5 }` | Una fuente de 5 V (de −24 a 24) contra tierra; `"limiteMa"` (por defecto 1000) la pasa a corriente constante si la carga pide más: sirve para "un LED a 10 mA" o "un pull-up de 10 kΩ" (3,3 V con 0,33 mA). |
| `{ "resistencia": 4700 }` | Una resistencia del pin a tierra; con `"a": "VCC"`, a otro pin del módulo. |
| `"sonda"` | Un multímetro: 10 MΩ a tierra, para medir un pin que maneja el módulo (3VO). Los pines que se miden en `espera.tension` y no están en el banco llevan una sola. |
| `"abierto"` | Nada (es lo mismo que no ponerlo). |

Lo que se puede esperar:

| Campo | Qué compara |
|---|---|
| `tension` | `{ "3VO": [3.28, 3.32] }` respecto de tierra, o `{ "VCC:GND": [...] }` entre dos pines, en V. |
| `corrienteMa` | \|I\| de un elemento del `model.ts`, en mA. |
| `potenciaMw` | \|P\| de un elemento, en mW. |
| `ui` | Lo que devuelve `observar()` en `ui`: un valor (`"on": true`) o un rango (`"brillo": [0.45, 0.55]`). |
| `sinAvisos` | Ningún aviso de este módulo (ni de `observar` ni de `reglas`). |
| `avisos` | Avisos que tienen que aparecer: `{ "severidad": "peligro", "contiene": "se daña" }`. |

**Qué casos escribir** (con valores de la hoja de datos o del esquemático, no "lo que dio"):

1. El caso típico de la hoja: tensión nominal, consumo nominal, sin avisos.
2. Cada límite que importa: por debajo del mínimo, por encima del máximo (tiene que avisar).
3. Lo que hace la placa y no el chip: a qué tensión van los pull-ups, cuánto da el regulador, la
   corriente de carga de una pila.
4. Cada prop que cambia la electricidad (el color de un LED, la pila del RTC).

Además de los casos del `tests.json`, siempre corre una **prueba de humo**: con 3,3 V en sus pines de
alimentación, el modelo resuelve sin NaN. Un módulo sin pines (un control remoto inalámbrico) no
tiene nada eléctrico que probar y no necesita `tests.json`.

La lógica de un chip (registros, protocolo, tiempos) **no** se prueba acá: tiene sus pruebas con el
maestro virtual y con firmware real en `app/server/src/bus/` (ver [`../chips/README.md`](../chips/README.md)).

## Cómo se valida y se prueba

| Dónde | Cómo |
|---|---|
| Al importar | El importador valida el formato, carga el modelo, revisa que el esquemático, las reglas y las pruebas nombren pines y elementos que existen, y corre las pruebas. Si algo falla, no se instala: dice qué y con qué valor medido. **Solo validar** hace todo eso sin instalar. |
| Por MCP | `probar_modulo { "tipo": "relay" }`: el informe caso por caso, su nivel, lo que le falta y cómo sale en el esquemático. |
| Por la API | `POST /api/modules/<tipo>/probar` (el mismo informe). `GET /api/modules` trae el `nivel` de cada uno. |
| En los tests | `npx vitest run server/src/sim/catalogoModulos.test.ts` (desde `app/`): todos los de fábrica, con todo lo anterior y en `fabricable`. |

## Crear un módulo real, paso a paso

Hay dos puertas, según lo que se tenga:

- **Con el esquemático de la placa** (Adafruit, SparkFun y la mayoría de los fabricantes lo publican):
  el `model.ts` copia sus piezas una por una (regulador, pull-ups, LED, diodos) y el `discreto` del
  esquemático las nombra igual. Ejemplos: [`bme280-adafruit/`](bme280-adafruit/), [`relay/`](relay/).
- **Sabiendo cómo se comporta** (la hoja de datos, o medido en la mesa): el modelo es su consumo y sus
  umbrales, las reglas son sus máximos, y el esquemático puede quedar en "módulo con su conector".
  Ejemplos: [`rxb6/`](rxb6/), [`stx882/`](stx882/).

1. **Carpeta y `module.json`**: copiá uno parecido. Los pines con los nombres serigrafiados y en el
   orden del conector.
2. **`module.svg`**: el dibujo (ver abajo).
3. **`model.ts`**: su circuito interno (empezá por el consumo) y su `ui`. Ver
   [`../docs/modulos-y-su-codigo.md`](../docs/modulos-y-su-codigo.md).
4. **`reglas`**: los máximos y mínimos absolutos de la hoja de datos.
5. **`tests.json`**: los casos de arriba, con los valores de la hoja.
6. **`parte`** y **`esquematico`**: el número de parte verificado, la huella (y el símbolo si existe en
   KiCad), la numeración de pines leída del símbolo.
7. Si tiene lógica digital: el chip en `chips/` (ver [`../chips/README.md`](../chips/README.md)) y `chips`
   en el module.json.
8. **Probalo**: `importar_modulo` con `solo_validar` (o, si es de fábrica, el test del catálogo). Mirá
   el informe: lo medido tiene que tener sentido físico, no solo "pasar".

### Lista de verificación

- [ ] Los pines se llaman como en la placa real y están en el orden del conector.
- [ ] La descripción dice qué es, con qué tensión anda y cómo se conecta.
- [ ] El modelo usa valores de la hoja de datos o del esquemático, y lo dice en un comentario (con la sección).
- [ ] Los límites absolutos están en `reglas`, no repetidos en `observar()`.
- [ ] `tests.json` cubre el caso típico, cada límite, lo que es de la placa y cada prop eléctrica.
- [ ] El número de parte está verificado (o es `generico` con descripción).
- [ ] Símbolo y huella existen en KiCad y la numeración de pines salió del símbolo.
- [ ] Si tiene `discreto`, cada pieza nombra los mismos nodos que el `model.ts`.
- [ ] `probar_modulo` (o el test del catálogo) da `ok` y el nivel esperado.

## module.svg

Un SVG normal con `viewBox="0 0 <width> <height>"`, dibujado con origen en la esquina superior izquierda del módulo. Los textos pueden usar las clases de la app (`txt-mini`, `txt-chico`, `txt-pin`, `claro`, `oscuro`), pero no hace falta.

Para que el dibujo reaccione a la simulación se marcan partes con atributos:

| Atributo | Efecto |
|---|---|
| `data-si="on"` / `data-si="!on"` | La parte se ve solo si el estado vale (o no vale). |
| `data-ctrl="momentary"` / `"toggle"` / `"boton"` (+ `data-indice="0"`) | La parte es un control que se puede tocar durante la simulación. |
| `{{props.etiqueta}}` | Se reemplaza por el valor de la propiedad. |
| `data-pantalla` | En un `rect`: ahí la app dibuja la imagen que publica el chip del módulo (una pantalla). El SVG del módulo no puede traer imágenes: la pone la app. |
| `{{vars.claro}}` | Se reemplaza por el valor de `vars` (ver abajo). |

Estados para `data-si`:

| Estado | Cuándo vale |
|---|---|
| `on` | Módulos `output`: el pin conectado está en 1 (LED prendido). |
| `presionado` / `activo` | Módulos `input`: el control está apretado / encendido. |
| `flash` | Parpadeo breve: el módulo transmitió o recibió por radio. |
| `sonando` | Módulos inalámbricos que reaccionan a un código RF (sirena). |
| `boton0` … `boton3` | Controles remotos: ese botón se está apretando. |

`vars` sirve para colores que dependen de una propiedad, como el LED:

```json
"props": { "color": { "type": "string", "default": "red", "enum": ["red", "green"] } },
"vars": {
  "claro": { "prop": "color", "map": { "red": "#ff4d3d", "green": "#4dff7a" }, "default": "#ff4d3d" }
}
```

y en el SVG: `<path data-si="on" fill="{{vars.claro}}" .../>`.

Ejemplos completos: [`led/`](led/), [`button/`](button/), [`remote-433/`](remote-433/).

## Importar

| Desde | Cómo |
|---|---|
| Carpeta | Una carpeta con `module.json` + `module.svg` (+ su `model.ts` y su `tests.json`), o una colección con una subcarpeta por módulo. |
| Zip | Lo mismo, comprimido. Límites: 512 KB por archivo y 8 MB en total. |
| Chip de Wokwi | El `.chip.json` de un [chip custom](https://docs.wokwi.com/chips-api/chip-json). Se importan los pines con un dibujo genérico (pines a los costados, como Wokwi). La lógica del chip (WASM) **no** se ejecuta; se le puede asignar un rol (`input`, `output`, `rf-rx`, `rf-tx`). |
| URL | `https://` a un zip, un `module.json` (su SVG, su modelo y su `tests.json` se buscan al lado), un `.chip.json`, o un repo de GitHub: `https://github.com/dueño/repo` o `…/tree/rama/carpeta`. |

Antes de instalar cada módulo se corre su banco de pruebas (ver [Cómo se valida y se prueba](#cómo-se-valida-y-se-prueba)). Una colección puede mezclar módulos y chips de Wokwi. Si uno falla, los demás entran igual y el resultado dice qué pasó con cada uno. **Solo validar** revisa todo sin instalar nada. Los módulos de fábrica no se pueden reemplazar ni quitar; los importados sí, con **Reemplazar** o con la × de su tarjeta. Si se quita un módulo que un circuito usa, el circuito lo muestra como desconocido hasta que se vuelva a importar o se borre.

## Seguridad

El `model.ts` corre aislado en un sandbox (sin acceso al server, con tiempo límite, y lo que devuelve se revisa entero); al importar se lo carga y se lo prueba, y si falla no se instala. Detalle en [`../docs/modulos-y-su-codigo.md`](../docs/modulos-y-su-codigo.md#seguridad-por-qué-se-puede-importar-código-de-otros).

El SVG termina dentro de la página, así que al importar se **rechaza** (no se "arregla") si trae:

- elementos fuera de la lista permitida: `<script>`, `<foreignObject>`, `<iframe>`, `<a>`, `<style>`, `<image>`, etc.;
- atributos de eventos (`onclick`, `onload`, …);
- referencias externas: `href` o `url(...)` que no empiecen con `#`, o `javascript:`;
- `DOCTYPE` o entidades XML.

Los enlaces de `parte` (`datasheet`, `proveedores[].url`) tienen que ser `https://`.

Los elementos permitidos son `svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`, `tspan`, `title`, `desc`, `defs`, `linearGradient`, `radialGradient`, `stop`, `clipPath`, `mask`, `pattern`, `use` y `symbol`. Además, el navegador vuelve a filtrar con la misma lista antes de dibujar. Las descargas por URL solo aceptan `https://`, con un máximo de 15 MB y 20 s.
