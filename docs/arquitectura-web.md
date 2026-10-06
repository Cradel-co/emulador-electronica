# Arquitectura de la UI (`app/web`)

> Pedido del usuario el 2026-10-02, al terminar la migración a React (#9): dejar escritas las reglas
> de modularización antes de empezar a partir `app.ts`, para que todos los módulos nuevos sigan el
> mismo criterio.

Las reglas cortas están en [`CLAUDE.md`](../CLAUDE.md#frontend-appweb). Este documento cuenta **de
dónde sale cada una**: casi todas vienen de algo que salió bien o de un error que costó encontrar.

## Las cuatro capas

| Capa | Qué va | Dónde | Cómo se prueba |
|---|---|---|---|
| **Lógica pura** | cálculo sin DOM ni estado global: recibe los datos por parámetro | `geometria.ts`, `consultas.ts`, `paleta.ts`, `formato.ts`, `constantes.ts` | tests unitarios en `app/tests/unit/` |
| **Componentes React** | la UI que genera HTML: paneles, listas, menús, diálogos | `react/*.tsx` | e2e (Playwright) |
| **Dibujo imperativo** | lo que se repinta muy seguido | `canvas.ts`, `modulos.ts` (SVG de los módulos), el editor y la consola en `app.ts` | e2e + tests de costo (`render.spec.ts`) |
| **Efectos** | hablar con el server, el WebSocket, guardar, conectar las piezas | `app.ts` | e2e |

`modulos.ts` no es puro aunque no tenga estado: crea nodos SVG. Es el código de dibujo que comparten
el canvas y las miniaturas del catálogo.

## Regla 1: la lógica pura va aparte, con tests

Si una función no toca el DOM ni lee el estado global, va a su propio módulo y **recibe lo que
necesita por parámetro**. Ejemplo (`consultas.ts`):

```ts
// En vez de leer state.diagrama.wires adentro:
export function cablesDe(ref: string, wires: readonly Cable[]): Cable[]
```

`app.ts` la envuelve en una línea con el estado actual
(`const cablesDe = (ref) => cablesDePuro(ref, state.diagrama.wires)`).

**Por qué:** así se prueba sin navegador, la pueden usar los componentes sin pasar por el puente, y
sirve igual si un día cambia la capa de dibujo. `geometria.ts` (#16) es lo que habilitaría pasar el
canvas a Canvas2D o WebGL: solo habría que reescribir quién pinta.

Las consultas de GPIO (`gpioDeRef`, `nombrePinGpio`, `gpioDe`) también viven en
`consultas.ts`: reciben el descriptor de placa, el diagrama y la búsqueda en el catálogo.
`gpioDe` sigue cables y componentes `passthrough` de dos pines, corta ciclos y conserva
el primer GPIO alcanzable según el orden del cableado. Es conectividad digital; las
corrientes y caídas de tensión siguen a cargo del motor eléctrico del servidor.
Su extracción se caracterizó contra `app.ts` y se comparó con la versión original
sobre 3.000 circuitos deterministas (`tests/unit/gpio.test.ts`).

## Regla 2: los componentes se montan sobre el nodo que ya existe

Cada pedazo de React es una **isla** (`react/montar.ts`): una raíz montada con `createRoot` sobre un
nodo de `index.html`. Ese nodo es **el que ya existía** (`#lista-modulos`, `#panel-modulo`…), no un
`div` nuevo adentro. El componente rinde solo los hijos.

**Por qué:** el CSS cuenta con la jerarquía. `.lista-modulos` es un `flex: 1` con `overflow: auto`
que tiene que ser hijo directo de su panel. Al principio las islas se montaban en un `div`
envoltorio, la lista perdió la altura y **el catálogo dejó de scrollear** (#28). Ningún test lo vio,
porque verificaban el contenido por descendiente (`#lista-modulos .cat-header`), que funciona igual
con un `div` en el medio. `react.spec.ts` ahora chequea la jerarquía.

Migrar un panel es reproducir **su lugar en el árbol**, no solo su HTML. Y reproducir su
comportamiento, no mejorarlo: un desempate alfabético "de paso" en el catálogo cambió el orden visible
y rompió un test.

## Regla 3: lo que se repinta muy seguido se queda imperativo

El dibujo del circuito, el editor y la consola **no** pasan por el ciclo de render de React.

| Qué | Frecuencia | Cómo se hace hoy |
|---|---|---|
| Niveles de pin en el circuito | hasta 60 por segundo | `pedirRender()` toca atributos de nodos que ya existen (#18) |
| Consola | ráfagas de miles de líneas | append incremental al `<pre>`, con cache |
| Editor | cada tecla | resaltado por `innerHTML`, gutter y marcas a mano |

React monta el contenedor y se corre del camino (`react/Lienzo.tsx`). Medido en #18: 0 nodos creados
por pulso de `pin.out` y 16,6 ms por pulso con 201 módulos, el techo de `requestAnimationFrame`.

**Ojo con aplicar esta regla sin medir.** El panel Debug (`depuracion.ts`) se había dejado afuera
"por frecuencia" y no era así: las variables se refrescan una vez por segundo y el resto por eventos.
Antes de decir que algo es de alta frecuencia, mirar si tiene un `setInterval`, un
`requestAnimationFrame` o si recibe eventos en ráfaga.

## Regla 4: `app.ts` es para efectos

`app.ts` habla con el server, maneja el WebSocket, guarda el diagrama y conecta las piezas. Ni
cálculo (va a la capa pura) ni HTML (va a un componente).

## Regla 5: los componentes no importan `app.ts`

`app.ts` y los componentes se necesitan mutuamente (los componentes disparan acciones, `app.ts`
necesita la instancia del lienzo). Importarse sería un ciclo, así que se hablan por
`react/puente.ts`:

| Qué | `app.ts` registra | El componente usa |
|---|---|---|
| El estado | `registrarEstado(state)` | `estado()` |
| Efectos (agregar módulo, girar, guardar…) | `registrarAcciones({…})` | `acciones()` |
| Consultas de presentación que leen el estado global | `registrarVistas({…})` | `vistas()` |
| El menú y la paleta | `registrarMenu`, `registrarPaleta` | `menu()`, `paleta()` |
| El lienzo | `registrarCtx`, `alLienzoListo` | `tomarCtx`, `entregarLienzo` |

El puente lleva **efectos**, no preguntas. Si un componente necesita calcular algo sobre el
diagrama, eso va a la capa pura (`consultas.ts`) y lo importa directo. Así se evitó que el puente se
volviera un cajón de sastre con el panel de propiedades (#25).

## Regla 6: las tres trampas del estado

El estado de `app.ts` está envuelto en un `Proxy` (`react/estado.ts`) y los componentes lo leen con
`useSyncExternalStore`. Tres cosas que no son obvias:

**a) Escribir un campo avisa solo; modificarlo por dentro, no.**

```ts
state.avisosDibujo = nuevos;          // avisa a React
state.diagrama.wires.splice(i, 1);    // NO avisa: hay que llamar a notificar()
```

`guardarDiagrama()` ya llama a `notificar()`, así que todo cambio del dibujo que pase por ahí está
cubierto.

**b) `useEstado` no ve lo que se modifica en el lugar.** Devuelve la misma referencia, y React
compara con `Object.is`: no vuelve a renderizar aunque se haya avisado. Para arrays y `Map` que se
mutan, usar `useVersion()`. Lo encontraron tres e2e del panel de propiedades: se borraba el cable y la
tabla seguía mostrándolo (#26).

**c) Si después de cambiar el estado hay que tocar el DOM que pinta React, `ahora()`.** React pinta un
instante después. El caso típico: llenar las opciones de un `<select>` y fijar su `value` en la línea
siguiente. Medido en el navegador: en el mismo instante hay 0 opciones y el `value` se descarta en
silencio (#36).

```ts
ahora(() => { state.proyectos = projects; });  // las opciones ya existen
sel('proyecto').value = nombre;
```

Relacionado: no deducir del DOM lo que el usuario eligió. Con las opciones puestas desde el arranque,
el navegador selecciona una por su cuenta (#36).

## Regla 7: antes de mover código, tests contra el código viejo

1. **Tests de caracterización primero.** Escribirlos contra el código actual y verificar que pasen.
   Después de cambiar el código, los mismos tests son la prueba de que nada cambió. En la migración,
   casi ningún panel tenía e2e (menú, paleta, pestañas, selectores…): se escribieron así.
2. **Si un test falla contra el código viejo, el error está en el test.** Pasó varias veces y siempre
   enseñó algo de la app (un proyecto nuevo nace sin USB, ESPHome muestra un solo archivo…).
3. **Al extraer lógica, comparar con la versión vieja sobre casos al azar.** Los tests nuevos solo
   prueban la versión nueva; la comparación prueba que es la misma. `geometria.ts` se comparó sobre
   20.000 casos, `consultas.ts` sobre 3.000 circuitos.
4. **Un test que pasa sin el arreglo no prueba el arreglo.** Revertir el cambio y ver que el test
   falle. Con `ahora()` los tests pasaban igual, y hubo que medirlo aparte.

## Lo que no es regla

**Un límite de líneas por archivo.** Es arbitrario y lleva a cortar donde no corresponde. Un módulo
se separa por responsabilidad: si se puede describir en una frase sin "y además".

## Componentes propios y adaptadores

El criterio permanente pedido por el usuario es desarrollo **custom y escalable**: componentes
propios, reutilizables y configurables, con responsabilidades y contratos explícitos.

Una biblioteca puede resolver una capacidad especializada, como docking o edición de código.
Se integra detrás de un adaptador propio: sus tipos y eventos quedan en ese límite, mientras
el resto del emulador trabaja con modelos propios. Así se puede actualizar o reemplazar el motor
sin reescribir los componentes, la persistencia ni las acciones del producto.

En las ventanas, el modelo `docking-layout.ts` describe grupos, divisiones, pestañas y visibilidad.
`docking-storage.ts` guarda ese contrato por proyecto y como predeterminado. Los contenidos de
Explorador, Componentes, Circuito, Código, Detalle y Consola siguen siendo componentes propios: mover una
ventana conserva sus nodos, la selección del circuito y el historial del editor.

Un componente compartido recibe contenido y acciones por parámetros; no incorpora condiciones
por cada pantalla que lo utiliza. Los efectos se conectan por el puente y las decisiones puras
se prueban por separado. Agregar una ventana debe extender su registro y aportar su contenido,
sin duplicar la infraestructura de arrastre, guardado o configuración.


## Navegación del espacio de trabajo

`navigation.ts` es el adaptador de TanStack Router (historial hash). El dominio usa
`WorkspaceRoute`: proyecto, placa y archivo. `navigation-route.ts` valida y serializa el
contrato; `navigation-selection.ts` resuelve selecciones ausentes o eliminadas desde metadatos.
Las vistas y el puente no importan TanStack: sus acciones llegan a la orquestación de `app.ts`.

La dirección canónica es `/#/projects/<proyecto>?board=<instancia>&file=<ruta-relativa>`.
Los enlaces anteriores `/#<proyecto>` siguen abriendo y se normalizan. Inicio usa `/#/`.
Un proyecto inexistente vuelve a Inicio; una placa o archivo inexistente usa el contexto
válido disponible y actualiza la URL. El historial permite Atrás/Adelante entre selecciones.

Antes de navegar se guarda el circuito pendiente y el archivo. Un fallo conserva selección,
URL y contenido; la navegación se puede reintentar. El adaptador serializa cargas y favorece
la última solicitud. No monta un RouterProvider sobre la aplicación: editor, circuito y
ventanas conservan sus nodos, y el docking sigue guardándose por proyecto fuera de la URL.

El adaptador tiene su proyecto TypeScript con `strictNullChecks` habilitado, requisito de
TanStack. El typecheck del workspace compila sus declaraciones antes del frontend heredado;
Vite usa las fuentes originales. No se debilitan los tipos de la biblioteca para integrarla.

Código y Detalle son ventanas independientes. La selección del circuito abre Detalle sin
reemplazar el editor. Detalle mantiene su ubicación y visibilidad por proyecto; los diseños
anteriores incorporan la nueva ventana sin perder grupos, pestañas ni proporciones.

La distribución original abre todas las herramientas. Código sólo está disponible si el proyecto
tiene una placa; los cierres y reaperturas posteriores se conservan por proyecto. Las ventanas
se cierran con su cruz y se reabren desde el menú Ver. Los botones laterales de Circuito,
Mover, Proyectos y Código se retiraron para evitar accesos duplicados.

### Vista compartida del circuito

`preview.html` carga una entrada independiente (`preview.tsx`), reutiliza `canvas.ts` con
`readonly` y no monta el editor ni Dockview. Solo permite pulsadores e interruptores,
zoom y encuadre. El servidor entrega una instantánea del diagrama y catálogo sin
fuentes; una capacidad aleatoria identifica la sesión y limita los controles a sus
módulos. La sesión pertenece a una ejecución y caduca si cambia su revisión.
Los clientes LAN solo tienen acceso al visor, bundles y endpoints de esa capacidad;
el editor y el WebSocket de depuración mantienen acceso local por defecto.
El estado eléctrico se consulta sin solapar pedidos, comparte un caché breve por
proyecto y reduce su frecuencia cuando la pestaña está oculta.
