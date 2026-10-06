# Agregar un módulo o componente

Los pasos a seguir, **con el error que originó cada uno**. Todos pasaron de verdad agregando el
buzzer, el potenciómetro, el sonómetro y el buzzer pasivo; varios los encontró el usuario usando
la app, no la suite de tests.

El formato del `module.json` está en [`../modules/README.md`](../modules/README.md) y el SDK del
modelo en [`modulos-y-su-codigo.md`](modulos-y-su-codigo.md). Esto es el **proceso**, no el
formato.

Buena parte de estas reglas las verifica solo `app/server/src/catalogoModulos.test.ts`: un módulo
nuevo que se olvide de una pone un test en rojo. Lo que ese test **no** puede comprobar es el
paso 7, que es justo el que más bugs encontró.

## 0. Primero clasificá el módulo: ¿datos o plataforma?

La promesa del repo es que "agregar hardware no debería pedir código nuevo", y es cierta **solo si
el módulo usa mecanismos que ya existen**. Preguntate:

- ¿Hay otro módulo que haga algo *de la misma clase*? → es datos: `module.json` + SVG + `model`.
- ¿Es el **primero** de su clase (la primera salida de sonido, la primera entrada analógica, el
  primer consumidor de PWM)? → el trabajo real está en la plataforma, y ahí van a estar los bugs.

**El error:** el buzzer activo parecía "un módulo más" y necesitó un contrato nuevo (`salidas`),
publicarlo desde el server y cablearlo en el navegador. Estimarlo como datos llevó a tres PRs en
vez de uno.

## 1. Buscá el análogo más cercano antes de diseñar nada

`grep` primero. Dos veces anoté en un SDD que hacía falta infraestructura nueva y las dos veces
**la respuesta ya estaba en el repo**:

- "hace falta `entorno` a nivel de módulo" → no: el nivel del ambiente es una **prop**, igual que
  la posición de un potenciómetro.
- "hace falta declarar el perfil de ADC en el descriptor de la placa" → no: va en el
  `project.json`, en `sim.analogicoEsp`.

Si el análogo existe, copiá su forma: convención de `model.ts`, validación de props, potencia
nominal como dato declarado, el aviso que escala a peligro al doble.

**Pero no copies el lenguaje del archivo.** El modelo de un módulo nuevo va en **`model.ts`**, con
su tipo `ModeloModulo`, aunque el análogo que estás mirando todavía sea `model.js`. Lo pide
[`AGENTS.md`](../AGENTS.md) y lo verifica `catalogoModulos.test.ts`, que lleva la lista de los que
faltan migrar (issue #41).

**El error:** copié el `model.js` del LED para el buzzer activo porque sus hermanos del catálogo
—LED, relé, pulsador— todavía son `.js`. El paso de "copiar el análogo" induce justamente a eso.

## 2. Un hecho físico, un solo lugar

Si el modelo lo calcula, **no lo declares también** en el `module.json`, y al revés.

**El error:** el umbral del buzzer activo estaba en el `interruptorControlado` del modelo (con
histéresis, y viendo la corriente) **y** en el `umbralV` de `salidas`. Mientras colgaba de una
fuente las dos coincidían. Alimentándolo por un divisor, no: a 2,44 V el modelo conducía 14,7 mA y
el sonido decía silencio; a 2,50 V al revés. El módulo prendía su dibujo y se quedaba callado.

Hoy manda el modelo (`ui.on`) y el valor declarado es solo el respaldo de un módulo sin código.

## 3. Si una API nueva maneja o lee el pin, enseñale a `pinScan`

**Las dos funciones**, que son distintas:

| Función | Qué decide | Si falta |
|---|---|---|
| `scanPins` | qué pines usa el código | aviso falso: "hay un módulo cableado al pin X que el código no usa" |
| `direccionesDeCodigo` | si cada pin es entrada o salida | el motor deja el pin **sin manejar**: mide 0 V y el componente no hace nada |

**El error:** tres bugs vivieron acá. `PWM(Pin(GPIO_BUZZER))` no matcheaba nada —ni `OUT` ni
literal— así que el buzzer pasivo medía 0 V y **no sonaba**, con todo el resto del camino
funcionando. Y un `ADC` sin marcar como entrada hace que el motor maneje el pin *contra* el sensor
que está midiendo.

Ojo también con las **constantes**: `GPIO_BUZZER = 5` hay que resolverlo, y solo cuenta si el
nombre termina en un periférico (`duracion = 7` no es un pin).

## 4. No confíes en `GPIO_OUT` para un pin que maneja un periférico

El puente muestrea el registro de salida del GPIO. Un periférico como el LEDC maneja el pad por la
**matriz de periféricos**, así que ese registro informa 0 y el motor resuelve el pin en bajo.

**El error:** la segunda causa de que el buzzer pasivo no sonara. Se corrige poniendo en alto los
pines con PWM activo antes de resolver el circuito, en `pwmEsp.ts`. Alto es el **nivel activo** de
la onda cuadrada, no su promedio: el ciclo de trabajo se cuenta después, en la amplitud, así que
contarlo en el nivel lo contaría dos veces.

Si el módulo nuevo depende de otro periférico (I2S, RMT, DAC), **el registro va a mentir igual**.

## 5. Los números salen de la hoja de datos, y lo que no se modela se dice

Cada parámetro con su fuente. Lo que no tiene fuente va como **dato declarado del usuario** (una
prop), como `powerRatedW` en los pasivos — no como un número inventado.

Y el modelo tiene que decir **qué no modela**, en su propio comentario: la ley de rotación
logarítmica de un potenciómetro, la resonancia mecánica de un piezo, la ponderación A de un
sonómetro, el consumo a potencia constante de un regulador conmutado.

## 6. Tests en cuatro niveles, y el cuarto es el que encuentra los bugs

1. **Lógica pura**, sin DOM ni motor (`app/tests/unit/`).
2. **El modelo contra ngspice**, con los números de la hoja de datos (`app/server/src/sim/`).
3. **El contrato con el firmware**: el shim corrido en CPython, como `pwmMicropython.test.ts` y
   `analogicoEspMicropython.test.ts`.
4. **El módulo en la app, con el firmware corriendo.**

**El error:** los tests de los niveles 1 a 3 del buzzer pasivo pasaban todos y el módulo no sonaba.
El bug estaba en un tramo que no era del audio. Los niveles 1 a 3 prueban cada tramo por separado;
solo el 4 prueba que estén unidos.

Para el nivel 4 sin navegador: ejecutar el proyecto por la API (`POST /api/projects/<p>/run`),
mirar `/api/projects/<p>/pins` y escuchar el WebSocket. Ahí se ve si los eventos salen y con qué
valores.

**Y esperá al programa, no al puente.** `GET /api/emulator` pasa a `state: "bridge"` cuando el
puente conectó, que es **antes** de que `main.py` empiece a correr. Medir en ese momento da un
falso negativo: a mí me hizo creer dos veces que el buzzer no sonaba cuando el problema era que
todavía no había arrancado. Esperá a que llegue el primer evento del programa (un `pwm.changed`,
una línea de consola) antes de concluir nada.

## 7. Antes de darlo por cerrado, abrilo en la app y usalo

Armá un proyecto con el módulo, apretá ▶ y comprobá lo que promete. Si tiene código, que el
firmware corra.

Dos cosas que confunden acá:

- **Recargá la pestaña.** El navegador pide el catálogo una sola vez al cargar; un módulo nuevo en
  disco no le llega y aparece como "Módulo desconocido" ([issue #62](https://github.com/Cradel-co/emulador-electronica/issues/62)).
- **Mirá contra qué server estás.** Un server viejo en el 5180 sirve el código viejo. Si un campo
  nuevo viene `null` en vez de vacío, es eso.

## 8. Una rama por módulo, desde `main`

Si de verdad depende de otra rama abierta, ramificá **desde esa** y abrí el PR con `--base`. Y
mergeá **el hijo primero**.

**El error:** el #58 se mergeó contra una rama que ya había entrado a `main`, así que GitHub lo
marcó `MERGED` y su código **nunca llegó**. Verificar el merge **por contenido** y no por el estado
del PR: `git cat-file -e origin/main:<archivo>`.

## Plantilla, si el módulo lo necesita para probarse

Un módulo que no se puede probar sin armar el circuito a mano conviene que venga con su plantilla
en `projects/_template/` (que **sí** se versiona). El README de la plantilla es la descripción que
muestra la app, y es buen lugar para la tabla de valores medidos con el motor y para los límites.
