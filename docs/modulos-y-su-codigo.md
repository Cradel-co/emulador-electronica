# Módulos y su código: cómo funcionan y cómo crear uno

> Pedido del usuario el 2026-09-30: "cada módulo debe tener en el json un punto de entrada
> al código del módulo, y que el motor respete las reglas del módulo pero no rompa las de
> la vida real. El objetivo es que si alguien quiere crear un módulo completo tenga las
> herramientas para hacerlo. Me imagino el código del módulo como una caja negra de
> funciones."

## La idea en una frase

Un módulo **describe con qué está hecho** (resistencias, diodos, fuentes, interruptores) y
el motor eléctrico ([ngspice](motor-electrico.md)) **calcula qué pasa**. El módulo
nunca dice "por mí pasan 20 mA" ni "mi pin tiene 3 V": eso sale de resolver todo el
circuito junto, con Ohm, Kirchhoff y la conservación de la energía. Por eso un módulo
puede tener las reglas que quiera (un relé que pega con 3,75 V, un LED que se daña con
5 V al revés) sin poder romper las de la física.

## Las piezas de un módulo

```
modules/
└── buzzer/
    ├── module.json   # qué es: nombre, pines, props, dibujo, y "model": "model.js"
    ├── module.svg    # cómo se ve
    └── model.js      # qué tiene adentro (eléctricamente) y qué hace con lo que le pasa
```

| Archivo | Para qué | Obligatorio |
|---|---|---|
| `module.json` | Identidad, pines, propiedades, rol en la simulación del firmware (`bridge`), y el punto de entrada al código (`model`). Formato completo en [`../modules/README.md`](../modules/README.md). | Sí |
| `module.svg` | El dibujo. Las partes con `data-si="on"` se ven cuando el módulo está "prendido". | No (sin él se ve una caja) |
| `model.js` | El modelo eléctrico: una caja negra con dos funciones. | No (ver [sin código](#sin-código-los-flags)) |

## El modelo: una caja negra de dos funciones

```js
module.exports = {
  // 1. Con qué está hecho. Se llama antes de cada cálculo.
  circuito(ctx) { /* declara elementos físicos */ },

  // 2. Qué hace con lo que le pasó. Se llama después de cada cálculo (opcional).
  observar(lectura) { return { ui, avisos, estado }; },
};
```

```
props, control, estado ──► circuito(ctx) ──► elementos físicos ──┐
                                                                  ▼
                                                  motor (ngspice, todo el circuito)
                                                                  │
          ui, avisos, estado ◄── observar(lectura) ◄── tensiones y corrientes reales
```

### `circuito(ctx)`: con qué está hecho

Lo que el modelo recibe:

| Campo | Qué es |
|---|---|
| `ctx.props` | Las propiedades de esta instancia (las del panel), con los `default` del module.json ya aplicados. Solo lectura. |
| `ctx.control` | `true` si su control está activo: el pulsador apretado, la llave encendida; en una fuente, que el circuito está energizado. |
| `ctx.estado` | Lo que `observar` devolvió como `estado` la vez anterior (memoria del módulo). |
| `ctx.vars` | Los `vars` del module.json ya resueltos (p. ej. el Vf del LED según el color). |
| `ctx.pin('IN')` | El nodo de un pin del module.json. Si el pin no existe, es un error. |
| `ctx.nodo('base')` | Un nodo **interno** del módulo (no se ve desde afuera ni se puede cablear). |

Los elementos que puede declarar (todas las unidades en SI: ohms, voltios, amperios,
faradios, henrios). El último argumento, `nombre`, es opcional pero conviene ponerlo:
es como después se lo lee en `observar`.

| Función | Elemento | Notas |
|---|---|---|
| `resistencia(a, b, ohms, nombre)` | Resistencia | `ohms > 0`. |
| `diodo(anodo, catodo, { is, n, rs?, bv?, ibv? }, nombre)` | Diodo (ecuación de Shockley) | Sirve para LEDs, rectificadores, zeners (`bv`), la juntura base-emisor de un transistor. |
| `fuenteTension(pos, neg, voltios, { rSerie?, limiteA?, soloEntrega? }, nombre)` | Fuente de tensión | Nunca es ideal: mínimo 1 mΩ en serie. Con `limiteA`, es CV/CC como una de laboratorio. Con `soloEntrega`, no absorbe corriente (regulador, USB). Puede ser negativa. |
| `fuenteCorriente(desde, hacia, amperios, nombre)` | Fuente de corriente | La corriente circula por adentro de `desde` a `hacia` (sale al circuito por `hacia`). |
| `interruptor(a, b, cerrado, { ron?, roff? }, nombre)` | Contacto mecánico | Cerrado: 50 mΩ; abierto: 1 GΩ (configurables). |
| `interruptorControlado(a, b, ctrlPos, ctrlNeg, { umbral, histeresis?, ron?, roff? }, nombre)` | Interruptor por tensión | Se cierra cuando V(ctrlPos) − V(ctrlNeg) > umbral. Para transistores de salida, osciladores que arrancan, comparadores. |
| `capacitor(a, b, faradios, { v0? }, nombre)` | Capacitor | En el análisis actual (continua) es un abierto; queda listo para el transitorio. |
| `inductor(a, b, henrios, { i0? }, nombre)` | Bobina | En continua es un cable. |

Límites: hasta 200 elementos por módulo, nombres `[A-Za-z0-9_.-]` de hasta 40 y sin
repetir, números finitos (y positivos donde corresponde).

### `observar(lectura)`: qué hace con lo que le pasó

| Campo | Qué es |
|---|---|
| `lectura.v('VCC')` | Tensión de un pin respecto de la tierra del circuito (V). |
| `lectura.vEntre('VCC', 'GND')` | Tensión entre dos pines (V). |
| `lectura.i('bobina')` | Corriente por un elemento propio, en el sentido en que se declaró (de `a` a `b`), en A. |
| `lectura.p('bobina')` | Potencia que disipa un elemento propio (W); negativa si entrega. |
| `lectura.props`, `.control`, `.estado`, `.vars` | Lo mismo que en `circuito`. |

Lo que puede devolver (todo opcional):

| Campo | Efecto |
|---|---|
| `ui: { on: true }` | El módulo se ve "prendido": se muestran las partes del SVG con `data-si="on"`. Se aplica con el circuito vivo (simulación corriendo o energizado). |
| `ui: { brillo: 0..1 }` | Intensidad (la API la expone; el dibujo todavía no la usa). |
| `avisos: [{ severidad: 'peligro' \| 'advertencia', mensaje }]` | Aparecen en el panel de avisos y en el MCP, con el nombre del módulo adelante. Hasta 10, de hasta 300 caracteres. |
| `estado: { ... }` | Memoria: vuelve como `ctx.estado` / `lectura.estado` en el próximo cálculo. JSON, hasta 4000 caracteres. Se borra al energizar o apagar. |

## Ejemplos

Los módulos de fábrica tienen todos su `model.js`: son el mejor punto de partida.

| Módulo | Qué muestra |
|---|---|
| [`resistor`](../modules/resistor/model.js) | Lo mínimo: un elemento, y un aviso por potencia (1/4 W). |
| [`led`](../modules/led/model.js) | Un diodo real calibrado por color (`vars.vf`), `ui.on`/`brillo` por corriente, aviso por tensión inversa. |
| [`button`](../modules/button/model.js) / [`switch`](../modules/switch/model.js) | `ctx.control` → un contacto. |
| [`fuente-regulable`](../modules/fuente-regulable/model.js) | Una fuente CV/CC con las props de tensión y límite; apagada, no declara nada. |
| [`relay`](../modules/relay/model.js) | Nodos internos, un transistor (diodo base-emisor + interruptor controlado), la bobina, el diodo de rueda libre, y una regla propia: pega con el 75 % de la corriente nominal. |
| [`rxb6`](../modules/rxb6/model.js) / [`stx882`](../modules/stx882/model.js) | Consumo de hoja de datos como resistencia equivalente; el transmisor consume solo mientras DATA está en alto. |

### Ejemplo 1: un potenciómetro (props y divisor)

```js
// Potenciómetro: una resistencia con un cursor. Entre A y B siempre está el total; el cursor
// (W) la divide en dos según la posición (0 = pegado a A, 100 = pegado a B).
module.exports = {
  circuito(ctx) {
    const total = Number(ctx.props.ohms);
    const x = Math.min(100, Math.max(0, Number(ctx.props.posicion))) / 100;
    // Ninguna parte llega a 0 Ω: un potenciómetro real tiene resistencia de contacto.
    ctx.resistencia(ctx.pin('A'), ctx.pin('W'), Math.max(1, total * x), 'tramoA');
    ctx.resistencia(ctx.pin('W'), ctx.pin('B'), Math.max(1, total * (1 - x)), 'tramoB');
  },
  observar(l) {
    const p = Math.max(Math.abs(l.p('tramoA')), Math.abs(l.p('tramoB')));
    if (p > 0.1) return { avisos: [{ severidad: 'peligro', mensaje: `Uno de sus tramos disipa ${p.toFixed(2).replace('.', ',')} W: aguanta 0,1 W. Se quema la pista.` }] };
    return {};
  },
};
```

Con 5 V entre A y B y la posición en 25, el cursor da 3,75 V (verificado con el motor).
Nadie escribió "V = 5 · 0,75": salió de la Ley de Ohm.

### Ejemplo 2: un buzzer activo (nodo interno, umbral, memoria)

```js
// Buzzer activo de 5 V (oscilador interno): suena entre ~3 y 5,5 V consumiendo ~30 mA a 5 V.
// Por debajo de ~2,5 V el oscilador no arranca y casi no consume.
module.exports = {
  circuito(ctx) {
    // El oscilador: un interruptor que se cierra cuando VCC − GND supera 2,5 V...
    ctx.interruptorControlado(ctx.pin('VCC'), ctx.nodo('osc'), ctx.pin('VCC'), ctx.pin('GND'),
      { umbral: 2.5, histeresis: 0.1 }, 'oscilador');
    // ...y lo que consume sonando: el equivalente de ~30 mA a 5 V.
    ctx.resistencia(ctx.nodo('osc'), ctx.pin('GND'), 166, 'bobina');
  },
  observar(l) {
    const mA = l.i('bobina') * 1000;
    const v = l.vEntre('VCC', 'GND');
    const avisos = [];
    if (v > 6) avisos.push({ severidad: 'peligro', mensaje: `Tiene ${v.toFixed(1).replace('.', ',')} V: el máximo es 6 V, se daña.` });
    if (v < 0) avisos.push({ severidad: 'advertencia', mensaje: 'Está al revés: no suena.' });
    return { ui: { on: mA > 5 }, avisos, estado: { vecesQueSono: (l.estado.vecesQueSono || 0) + (mA > 5 ? 1 : 0) } };
  },
};
```

Verificado con el motor: a 5 V consume 30,6 mA y `on: true`; a 2 V no arranca (`on:
false`); a 12 V avisa que se daña. El consumo aparece solo en la fuente que lo alimenta, y
si esa fuente no da abasto, la tensión que le llega baja: eso no lo programa el módulo.

## Cómo pasar una hoja de datos a un modelo

| Lo que dice la hoja de datos | Cómo se modela |
|---|---|
| "Consumo: 30 mA a 5 V" | Resistencia equivalente R = V / I (166 Ω). Si el consumo es constante en un rango, una fuente de corriente o un regulador interno. |
| "Tensión de trabajo: 3–5,5 V" | Un `interruptorControlado` con umbral en la tensión mínima, y avisos en `observar` por encima de la máxima. |
| "Vf = 2 V a 20 mA" | Un diodo con `is = I / exp((Vf − I·rs) / (n · 0,025865))`, como el LED de fábrica. |
| "Entrada de alta impedancia" | Una resistencia grande (100 kΩ – 1 MΩ) a GND. |
| "Salida a transistor / open collector" | Diodo base-emisor + `interruptorControlado` (ver el relé). |
| "Máximo absoluto" / "potencia máxima" | No es un elemento: es una regla en `observar` (aviso de peligro). |
| "Regulador interno de 3,3 V" | `fuenteTension(..., { limiteA, soloEntrega: true })` desde un nodo interno. |

Reglas que conviene respetar (si no, el motor igual lo resuelve, pero el resultado se
aleja de la realidad):

- **Nada ideal.** Dos fuentes de tensión sin resistencia en paralelo, o una fuente de
  corriente sin camino, no existen en la vida real. Usá `limiteA`, `rSerie`, `ron`.
- **La energía la ponen las fuentes.** Si tu módulo "entrega" energía (una batería, un
  panel solar, un regulador), declarale una fuente; si solo consume, nunca.
- **Las reglas propias van en `observar`.** "Se daña con más de 6 V" no cambia el
  circuito: es un aviso. "Pega con el 75 % de la corriente" es lo que el módulo muestra
  (`ui.on`), y si además cambia el circuito (cierra un contacto), es un elemento.

## Sin código: los flags

Un módulo sin `model` (por ejemplo, uno importado de antes) igual participa del cálculo
si declara alguno de estos flags en su module.json; el motor le arma el modelo:

| Flag | Modelo |
|---|---|
| `source: { voltageProp, currentProp? }` | Fuente CV/CC entre su pin `power` y su pin `ground`. |
| `passthrough` + `ohmsProp` | Resistencia entre sus 2 pines. |
| `diode` (+ `vars.vf` o `diodeVfDefault`) | Diodo calibrado como el LED. |
| `switch` | Contacto entre sus 2 pines según su control. |

Sin `model` ni flags, el módulo se cablea pero eléctricamente no está (no consume nada).

## Crear un módulo nuevo, paso a paso

1. **Copiá uno parecido** de `modules/` a una carpeta nueva con el nombre del tipo
   (`[a-z0-9-]`, p. ej. `modules/buzzer/`).
2. **`module.json`**: cambiá `type`, `name`, `category`, `pins` (nombres y posiciones) y
   `props`. Agregá `"model": "model.js"`. Si el firmware lo maneja (un LED, un relé), su
   `bridge` (`role: "output"` y el pin).
3. **`module.svg`**: el dibujo, con las partes que se prenden marcadas `data-si="on"`.
4. **`model.js`**: `circuito` con sus elementos (empezá por el consumo) y `observar` con
   sus reglas y su `ui.on`.
5. **Probalo**: reiniciá el server (o importalo, ver abajo), armá un circuito con una
   fuente regulable sin placa, energizá (▶) y mirá:
   - la píldora "Energizado · N mA" y la ventana Debug → Alimentación (consumo);
   - el panel de avisos: si tu modelo tiene un error, aparece como advertencia
     ("su modelo tiene un error... se usa el comportamiento básico" o "su modelo
     falló...");
   - la instantánea de depuración (`GET /api/debug/snapshot`, bloque `electrico`): la
     tensión de cada pin y la corriente de cada uno de tus elementos (`<id>.<nombre>`).
6. **Variá las condiciones**: tensión baja, alta, al revés, fuente con poco límite. Tiene
   que pasar lo que pasaría en la mesa.
7. Si es de fábrica, sumalo a los tests: `app/server/src/sim/motor.test.ts` tiene casos
   de módulos activos para copiar (comparan con la hoja de datos y exigen Kirchhoff y la
   energía en todo el circuito).

### Importarlo (sin tocar la carpeta `modules/`)

**+ Importar** en el catálogo, `POST /api/modules/import` o la tool MCP `importar_modulo`
aceptan el módulo con su código desde una carpeta, un zip, una URL a su `module.json`
(el `model.js` se busca al lado) o un repo de GitHub. Antes de instalarlo, el importador
**carga el modelo en el sandbox y arma su circuito** (suelto y accionado, con las props
por defecto): si no carga, se cuelga, usa un pin que no tiene o devuelve algo inválido,
se rechaza con el motivo. Máximo 128 KB de código.

## Seguridad: por qué se puede importar código de otros

El `model.js` de un módulo importado es código de terceros. No corre en el server: corre
en un sandbox (`app/server/src/sim/sandbox.ts`, contexto `node:vm`) con estas reglas:

- **Sin nada del server adentro**: ni `process`, ni `require`, ni `import()`, ni red, ni
  disco, ni timers. El contexto no tiene prototipo y no se le pasa ningún objeto: entre el
  server y el modelo solo viajan **strings** (JSON). El truco clásico de escape
  (`this.constructor.constructor('return process')()`) no encuentra nada.
- **Sin generar código**: `eval`, `new Function` y WebAssembly están deshabilitados.
- **Con tiempo límite**: 1 s para cargar, 300 ms por llamada, contando las promesas (holgado: con el server cargado, un modelo sano no queda afuera por tardar unos ms de más).
  Un bucle infinito corta con "tardó demasiado"; el modelo se puede volver a llamar.
- **La barrera real está en el server**: el código del módulo puede pisar las ayudas del
  sandbox, así que todo lo que devuelve se revisa de nuevo afuera — solo se acepta un
  string de hasta 200 KB; cada elemento se vuelve a armar campo por campo (tipos, números
  finitos, positivos donde corresponde, nodos `pin:` que el módulo realmente tiene, nombres
  únicos, hasta 200). Los errores también se convierten a texto adentro del sandbox: un
  error con un `get message()` colgado no traba el server.
- **Un modelo roto no rompe el circuito**: si no carga, se usa el de sus flags; si falla al
  calcular, el módulo queda afuera (abierto) y se avisa; el resto se calcula igual.

Es un aislamiento de lenguaje, no de sistema operativo: alcanza para módulos de la
comunidad, no para código diseñado para explotar fallas de V8. Todo esto está probado en
`sim/sandbox.test.ts` (intentos de escape, cuelgues, inyección de SPICE en nodos y
nombres, valores inválidos, salida gigante, prototipos ensuciados).

## Documentos relacionados

- [`motor-electrico.md`](motor-electrico.md) — el motor, las leyes que respeta y cómo se
  verificó.
- [`../modules/README.md`](../modules/README.md) — formato completo del module.json y del
  SVG, importación.
- `app/shared/src/modelo.ts` — los tipos del SDK (para autocompletar en un editor).
