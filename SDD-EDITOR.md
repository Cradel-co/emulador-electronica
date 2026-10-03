# Editor de código: diseño e implementación (foco en MicroPython)

> Pedido del usuario el 2026-10-01: pensar cómo mejorar el editor de código de la app. Aclaración
> directa del usuario: **la optimización tiene que enfocarse solo en MicroPython**, no repartirse
> pareja entre C/C++, YAML y Python. Encaja con lo ya decidido para el proyecto: ESPHome/YAML se va
> a borrar del emulador y para ESP32 se va por MicroPython (C/C++ queda como algo secundario, "si
> hace falta").
>
> El análisis original comparaba caminos y dejaba una recomendación tentativa. El pedido del
> 2026-10-03 adopta el camino B; el alcance y los límites implementados están en la sección final.

## Qué hay hoy

El editor es un motor propio, sin ninguna librería (no hay CodeMirror, Monaco ni Ace en
`app/web/package.json`): un `<textarea>` transparente superpuesto a un `<pre>` que se repinta con
**una sola regex por lenguaje** (YAML, C/C++, Python, CMake), con grupos con nombre que mapean a
clases CSS (`app/web/editor.ts:1-66`). No hay parser real: es resaltado heurístico de una pasada.

La integración vive en `app/web/app.ts` (sección "Editor", desde la línea 433): gutter de números
de línea que solo se recalcula si cambia el total de líneas (`app.ts:446-451`), repintado
diferido a `requestAnimationFrame` para no repintar por cada tecla (`app.ts:452-456`), y
sincronización de scroll entre el `<pre>` y el gutter (`app.ts:468-477`).

### Lo que funciona bien (no perder esto en ningún cambio)

- **Pestañas de archivos múltiples**, guardado automático 1 s después de dejar de escribir, y
  `Ctrl+S` (`app.ts:550-595`).
- **Indentación automática**: Tab inserta 2 espacios (4 en Python); Enter mantiene la sangría de
  la línea y la aumenta tras `:`/`{`/`(`/`[` (`app.ts:2146-2169`).
- **Errores inline post-build**: franja roja por línea con tooltip, más la pestaña "Problemas"
  con la lista completa y click para saltar a la línea (`app.ts:491-517`, `242-267`).
- **Breakpoints** clicleables en el gutter, con resaltado de la línea donde se pausó el programa,
  integrado con el protocolo DAP del depurador (`app/web/depuracion.ts:223-296`).
- Barra de estado con "Ln:Col" y el lenguaje detectado por extensión de archivo (`app.ts:479-489`).
- **Atajos estilo Android Studio/IntelliJ** (doble Shift, `Ctrl+Shift+P`, `Ctrl+K`) que abren una
  paleta de comandos (`app.ts:2732-2846`) — aunque hoy busca *acciones, proyectos, archivos y
  módulos*, no texto dentro del archivo abierto.
- Tema visual ya alineado a IDE: fuente JetBrains Mono, paleta de colores tipo Darcula
  (`app/web/style.css:298-324`).

### Huecos frente a un editor de código moderno

- **Sin buscar/reemplazar dentro del archivo** (la paleta de comandos no busca texto del código).
- Sin autocompletado — ni de palabras clave, ni de símbolos, ni de la API de MicroPython.
- Sin chequeo de sintaxis mientras se tipea: los errores solo llegan después de un build completo
  en Docker (`app.ts` dispara `mostrarErrores()` recién cuando vuelve `build.done` por WebSocket).
- Sin plegado de código, sin multi-cursor, sin formateo automático (equivalente a `black`/`autopep8`
  para Python).
- Sin panel de preferencias: el botón "Ajustes" (`act-ajustes`) solo abre un diálogo "Acerca de"
  con la lista de atajos — no hay forma de cambiar tema, tamaño de fuente o tab size.
- Resaltado por regex de una sola pasada: frágil en casos límite (strings con comillas escapadas
  anidadas, comentarios dentro de strings, f-strings complejos en Python).

## El plan original pedía otra cosa

`GUIA-IMPLEMENTACION.md` especificaba desde el principio **CodeMirror 6** como editor
(`@codemirror/lang-yaml`, `lang-cpp`, `lang-python` — línea 136), y la sección 11.4 pedía
explícitamente "numeración de líneas, **búsqueda**" (línea 681) y marcas de error por línea que
se limpian al editar (línea 686). El checklist final también lo daba por sentado
(líneas 949-954). La implementación actual se desvió de ese plan hacia el motor artesanal descrito
arriba — "búsqueda" en particular nunca se llegó a construir, ni en el plan original ni en el
camino que se tomó.

Esto no es necesariamente un error: el camino artesanal es liviano y ya resolvió bastante (tabs,
autoguardado, breakpoints, errores inline). Pero es un dato relevante al decidir si conviene volver
al plan original o seguir invirtiendo en lo propio.

## Por qué el foco pasa a ser solo MicroPython

El usuario fue explícito: no quiere un documento que mejore C/C++, YAML y Python por igual. El
editor debe optimizarse **para MicroPython**. Esto cambia el criterio de evaluación de cualquier
camino: lo que importa es qué tan bien resuelve *indentado significativo de Python*,
*autocompletado de la API de MicroPython para ESP32* y *detección de errores de sintaxis Python*
— no soporte parejo de los otros lenguajes, que pueden seguir con el resaltado regex actual tal
cual está, sin inversión nueva.

## Tres caminos, comparados para Python/MicroPython

| Camino | Qué gana (para Python) | Esfuerzo | Qué hay que portar / riesgo |
|---|---|---|---|
| **A. Seguir artesanal, sumar features** | Indentado más estricto (auto-dedent tras `return`/`pass`/`break`/`continue`, avisar mezcla de tabs/espacios), buscar/reemplazar propio, autocompletar de palabras clave + API de MicroPython desde una lista armada a mano | Bajo por feature, pero cada una se reinventa desde cero (parser propio para folding, para multi-cursor, etc.) | Ninguno — no se toca la base. Riesgo: cada feature nueva es más regex/estado a mano, cada vez más fragil |
| **B. Migrar a CodeMirror 6** | Parser real de Python (Lezer): indentado consciente del lenguaje de fábrica, + `@codemirror/search` (buscar/reemplazar), `@codemirror/autocomplete`, `@codemirror/lint`, `@codemirror/fold` — y es el plan original del proyecto | Medio: una migración de base, pero son paquetes ya hechos, no construir cada feature | Portar a extensiones de CM6: marcas de error de build, breakpoints del gutter, tema Darcula/JetBrains Mono |
| **C. Migrar a Monaco** | Soporte de Python decente, y es *literalmente* el editor de VS Code — encaje 1:1 con el pedido de que la UI se parezca a VS Code; IntelliSense real si algún día se conecta un language server (pyright/pylsp) | Alto: API bastante distinta, bundle mucho más pesado para un solo lenguaje objetivo | Mismo riesgo que B (breakpoints, marcas, tema) mas el costo de bundle/arranque |

**Mejora transversal, independiente del camino elegido — autocompletado de MicroPython**: armar
una lista de símbolos de los módulos relevantes para los ESP32 que ya emula la app (`machine`,
`network`, `time`, `esp32`, `neopixel`, `dht`, `onewire`, `umqtt`, etc.), a mano o a partir de
stubs tipo `micropython-stubs`, y ofrecerla como fuente de autocompletado en vez de autocompletar
solo palabras ya escritas en el archivo. Es probablemente la mejora de mayor impacto dado que el
foco es un solo lenguaje.

**Mejora transversal — chequeo de sintaxis en vivo**: evaluar correr `ast.parse`/`pyflakes` en un
worker (sin esperar el build completo en Docker) para avisar errores de sintaxis o símbolos
mientras se tipea, en vez de recién después de compilar.

## Recomendación tentativa

Me inclino por **B (CodeMirror 6)**: retoma el plan original del proyecto, tiene el mejor soporte
de Python "gratis" de las opciones livianas (parser dedicado en vez de regex), y un bundle mucho
más chico que Monaco. Cubre casi todos los huecos listados arriba de una sola vez.

Dejo anotadas las otras dos como alternativas válidas:

- **C (Monaco)** si el usuario prioriza que el editor se sienta y funcione 1:1 como VS Code por
  sobre el peso del bundle.
- **A (seguir artesanal)** como camino de menor riesgo si no se quiere tocar la base todavía —
  sumando primero buscar/reemplazar y autocompletado de MicroPython, que son las mejoras de mayor
  impacto y no requieren cambiar el motor.

Esto queda abierto a discusión, no es una decisión tomada.

## Riesgos y qué no perder en una migración

Cualquiera de los caminos B o C tiene que preservar, sin regresiones:

- Breakpoints del depurador en el gutter (`depuracion.ts`).
- Marcas de error de build por línea, con su tooltip y la pestaña "Problemas".
- Atajos y paleta de comandos (`Ctrl+Shift+P`, doble Shift, `Ctrl+K`).
- Tema visual (JetBrains Mono, paleta Darcula) y la barra de estado "Ln:Col".
- Pestañas de archivos múltiples y guardado automático.

El soporte actual de C/C++ y YAML en `editor.ts` puede quedar tal cual (regex, sin tocar), ya que
no es el foco de esta mejora.

## Si se decide avanzar: próximos pasos (sin implementar todavía)

Antes de migrar todo el editor, un spike chico y aislado: montar CodeMirror 6 con
`@codemirror/lang-python` en un archivo `.py` de prueba, en paralelo al editor actual, para validar
que breakpoints, marcas de error de build y un primer autocompletado de MicroPython se pueden
portar sin perder la UX de hoy. Recién con eso andando tiene sentido planear la migración completa.

## Implementación del camino B — 2026-10-03

El pedido de implementar este documento adopta CodeMirror 6 para los archivos `.py`.
El análisis anterior se conserva como registro de la decisión; las referencias a líneas
corresponden a la versión del editor anterior a la migración.

El alcance de esta implementación es:

- Parser Python, resaltado Darcula, indentación de cuatro espacios, cierre de delimitadores,
  plegado, selección múltiple y deshacer/rehacer.
- Buscar y reemplazar dentro del archivo, con `Ctrl+F` y `Ctrl+H`.
- Autocompletado de palabras clave, funciones comunes y un catálogo de APIs MicroPython
  (`machine`, `network`, `time`, `esp32`, `neopixel`, `dht`, `onewire`, `umqtt`). Se reconocen
  importaciones con alias y asignaciones directas de constructores para sugerir miembros.
- Diagnósticos de sintaxis locales y diferidos al escribir, sin compilar ni iniciar Docker.
- Formateo Python local con Ruff en WebAssembly, ejecutado en un worker bajo demanda.
  El comando es explícito, se puede deshacer y no reemplaza ediciones realizadas mientras
  el worker estaba procesando otro contenido.
- Preferencias persistentes de tema, tamaño de fuente e indentación para MicroPython.
- Integración con guardado automático, `Ctrl+S`, pestañas, posición del cursor, errores de build,
  navegación desde Problemas, breakpoints y línea de parada del depurador.
- El editor anterior continúa atendiendo C/C++, YAML, CMake y texto.

El autocompletado es un catálogo orientativo: no comprueba que un módulo esté instalado ni
que una placa emule todas sus funciones. El diagnóstico utiliza la recuperación de errores
del parser Lezer; no reemplaza `ast.parse`, un language server ni la validación del firmware.
No verifica nombres indefinidos, tipos ni errores de ejecución. Las sugerencias no constituyen
una certificación de soporte del hardware.

El formateador usa Ruff como alternativa local a Black/autopep8. Una entrada inválida
conserva el documento y muestra el error; el código del usuario no se ejecuta para formatearlo.

La cobertura de regresión del editor está en `app/tests/e2e/editor.spec.ts` y la del catálogo
MicroPython y su diagnóstico en `app/tests/unit/micropython-language.test.ts`. Las pruebas de
navegador utilizan proyectos temporales y verifican los archivos guardados mediante la API.

Para repetir la validación con carga acotada, desde `app/`:

```bash
NODE_OPTIONS=--max-old-space-size=1536 npx vitest run --maxWorkers=1 --minWorkers=1 --no-file-parallelism
npm --workspace web run typecheck
npx tsc -p server/tsconfig.json --noEmit
npm run build:web
NODE_OPTIONS=--max-old-space-size=1536 npx playwright test --workers=1
```

Ejecutar los comandos en serie. Los e2e de firmware que requieren Docker/emuladores reales
se habilitan aparte con `E2E_EMU=1`; las pruebas del editor no los necesitan. La caché de
CodeMirror retiene hasta 32 sesiones de archivos inactivos, con su historial, cursor y scroll.

Validación final del 2026-10-03: **699 tests Vitest** en 48 archivos, **88 tests Playwright**
(incluidas 17 pruebas del editor), typecheck de web y server y build web aprobados. Se omitieron
10 pruebas de firmware que requieren `E2E_EMU=1`. Se ejecutó todo en serie y con un worker.
El proyecto quedó levantado mediante `pnpm run dev` en `http://127.0.0.1:5180`.

## Archivos y ejecución por placa — 2026-10-03

El explorador se muestra exclusivamente en el lateral izquierdo. La placa cuyo código se
edita se elige haciendo click sobre ella en el circuito. El árbol de archivos y las pestañas
pertenecen a esa placa. El botón `+` solicita un nombre y crea un `.py` junto al archivo activo,
añadiendo la extensión si falta; no sobrescribe archivos existentes. El historial de edición,
el cursor y el scroll se conservan por proyecto, instancia de placa y ruta.

La interfaz usa componentes reutilizables: `FileTreeView` recibe rutas, archivo activo y callback,
`FileExplorer` conecta ese árbol con el estado de la aplicación y `FileNameForm` presenta el
formulario de creación. La construcción del árbol y la resolución de GPIO están en módulos
puros independientes de React.

Los proyectos admiten `boards: [{ id, board, language }]`. Los proyectos históricos sin ese
campo siguen funcionando sin mover sus archivos: la instancia `board` conserva el código en
la raíz y las adicionales lo guardan en `boards/<id>/`. Los campos históricos `board` y
`language` reflejan la primera instancia sobreviviente. Quitar una placa elimina su módulo y
sus cables, conservando el código en disco. La API de archivos valida el contexto `boardId`
antes de leer o escribir y bloquea rutas hacia carpetas de otras placas.

Compilar inicia en paralelo el toolchain de cada placa y mantiene resultados y directorios
separados. Ejecutar inicia todas las placas dentro de un mismo circuito eléctrico; seleccionar
una placa cambia el contexto de edición. Los GPIO, puentes y depuradores pertenecen a cada
instancia. El motor eléctrico resuelve el circuito completo con rieles independientes y entrega
las entradas según los voltajes y umbrales de cada placa. MicroPython sube todos los `.py` de
su instancia, incluyendo módulos importables en subcarpetas.

Las pruebas de interfaz están en `app/tests/e2e/multiplaca-explorer.spec.ts`. Las pruebas de
física en `app/server/src/sim/multiplaca.test.ts` verifican comunicación entre placas, niveles y
alimentación independientes y mediciones referidas a la tierra de cada placa. Las pruebas se
ejecutan en serie, con un worker y memoria limitada, conservando `pnpm run dev` en el puerto 5180.

Validación final de esta ampliación: **731 tests Vitest** en 53 archivos; **92 tests Playwright**
de interfaz y una prueba adicional con dos ESP32 reales y firmware MicroPython cacheado.
La prueba real verifica imports dentro de `lib/`, comunicación por GPIO, puertos independientes,
recarga de la placa editada sin reiniciar la otra, contexto de depuración y cancelación segura.
La suite de interfaz omite 11 pruebas optativas de firmware; una de ellas se ejecutó después
por separado, y las otras 10 no se habilitaron. Typecheck de web y server y build web aprobados.

La recarga de MicroPython interrumpe el programa con `Ctrl+C` antes de entrar al REPL crudo y
crea las carpetas necesarias al subir archivos. El botón `+` queda visible al desplazar las
pestañas; seleccionar una placa conserva su historial y dirige consola y breakpoints a ella.

### Ventanas de herramientas independientes

Explorador y Componentes tienen apertura, cierre y posición propios. Cada icono controla
solamente su ventana; pueden quedar abiertas juntas o por separado. El agarre de la cabecera
permite cambiar su ubicación, y la preferencia de ubicación y apertura se conserva por proyecto.
La búsqueda del catálogo no se pierde al mover Componentes.

`ToolWindow` recibe el título, icono, acciones y contenido como propiedades React. `ToolWindows`
registra e inyecta `FileExplorer` y `Catalogo` en esa estructura mediante
portales; agregar otro contenido no requiere mezclar su interfaz con la de estas herramientas.
La normalización de preferencias vive en `docking-layout.ts`, separada de los efectos de `app.ts`.
Las pruebas de movimiento y persistencia están en `app/tests/e2e/tool-window.spec.ts`.

### Acoplamiento por arrastre y distribución por proyecto

Las cinco ventanas —Explorador, Componentes, Circuito, Código/propiedades y Consola— tienen
un botón de agarre `⠿`. Mantenerlo presionado y arrastrar muestra una vista previa: soltar en
un borde divide ese grupo, y soltar en el centro agrupa ventanas en pestañas. Escape o soltar
fuera de un destino válido cancela el movimiento. Los separadores ajustan las proporciones.

`docking-layout.ts` representa la distribución como un árbol de grupos y divisiones, con
operaciones puras de movimiento, activación, apertura y redimensionamiento. La normalización
rechaza árboles incompletos, duplicados, profundos o con tamaños inválidos. `DockWorkspace`
integra el adaptador propio `docking-engine.ts`, que encapsula Dockview 8.4 (MIT) para gestionar
las divisiones, pestañas y gestos. El formato de Dockview no se guarda como modelo del proyecto:
el adaptador traduce hacia y desde el contrato propio y aplica el tema del emulador.
Reubica los nodos originales en sus slots; conserva las raíces React,
el editor CodeMirror, el SVG del circuito y los controles de consola sin reiniciar su estado.
Los cambios de distribución no llaman al backend de compilación o de ejecución.

`docking-storage.ts` guarda la distribución y el filtro de Componentes en el almacenamiento
local del navegador, con claves distintas por proyecto. Un proyecto sin distribución propia
recibe una copia del predeterminado al abrirse. Cambiar el predeterminado no modifica los
proyectos que ya guardaron su distribución. Borrar un proyecto desde la interfaz limpia esa
preferencia para que recrear su nombre reciba el predeterminado.

Configuración → Distribución de ventanas permite guardar el diseño actual como predeterminado,
restaurar el proyecto al predeterminado y restablecer el predeterminado original. El editor
conserva su entrada separada en Configuración. Las pruebas puras de modelo y almacenamiento
están en `docking-layout.test.ts`, `docking-storage.test.ts` y `docking-engine.test.ts`;
las de navegador en `docking.spec.ts`.

Validación del adaptador Dockview: **766 pruebas Vitest** en 56 archivos; typechecks web/server
y build web aprobados. La regresión completa de Playwright aprobó **103 casos** y omitió
11 optativos de firmware. Incluye arrastre, pestañas, Escape, cierre y apertura de las cinco
ventanas, persistencia por proyecto, predeterminado configurable, historial del editor y
selección del circuito. Las pruebas se ejecutaron con un único worker y navegador.
El servidor sigue activo con `pnpm run dev` en el puerto 5180.
