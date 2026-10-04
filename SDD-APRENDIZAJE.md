# Módulo de aprendizaje y enrutamiento

> Fecha: 2026-10-03. Estado: **implementación parcial; consultar las etapas y brechas pendientes**.
> Pedido: aprovechar Aprender, incorporar TanStack Router y preparar el módulo de aprendizaje.
> La base de enrutamiento está en la PR #49 y la primera entrega de Aprender en la PR #50.
> Este documento conserva los criterios acordados y registra qué falta para completarlos.
> Cada etapa se entrega en una rama y un PR, siguiendo `CLAUDE.md`.

## 1. Problema y resultado esperado

Antes de las PR #49 y #50, el botón Aprender (`bienvenida-acerca`) abría el diálogo de atajos
y acerca de. La selección de proyectos vivía en `location.hash`, con efectos de apertura y
guardado en `app.ts`. React se monta en islas desde `react/montar.ts`; `react/App.tsx` no es el
montaje principal. La PR #49 incorpora un adaptador de TanStack Router sobre historial hash;
la PR #50 agrega el índice, la primera lección, progreso local y una plantilla práctica.

La primera entrega permitirá entrar a Aprender, leer **Encender un LED**, crear una práctica
independiente desde una plantilla, volver a la lección y marcarla como completada. Las URLs
deberán funcionar al compartirlas, recargarlas y recorrer el historial del navegador.
El editor mantendrá su comportamiento y sus cambios pendientes durante la navegación.

## 2. Alcance

### Primera versión

- Navegación con TanStack Router para inicio, aprendizaje y proyectos.
- Índice de lecciones publicadas, con título, resumen, nivel, duración estimada y progreso.
- Una lección completa, con objetivos, requisitos, materiales, explicación, pasos,
  resultado esperado, errores frecuentes y práctica.
- Creación de un proyecto nuevo mediante la API de plantillas existente.
- Progreso local: último paso visitado y finalización declarada por el usuario.
- Compatibilidad de entrada con enlaces antiguos `/#nombre`.
- Estados de carga, errores recuperables y páginas no encontradas; navegación por teclado.

### Evolución posterior

Rutas de cursos, búsqueda y filtros, cuestionarios y evaluación automática con el motor,
guía visible junto al circuito, progreso sincronizado entre dispositivos y edición de contenido.
No se agregan cuentas, CMS, otra física, una API de aprendizaje ni una migración completa del
editor a React en esta primera versión. Las próximas lecciones pueden cubrir ley de Ohm,
polaridad, botón y LED, GPIO y programación; solo se publican cuando tengan contenido y
práctica verificados. No se muestran tarjetas de lecciones vacías.

## 3. Decisión de enrutamiento

Usar `@tanstack/react-router`, con rutas definidas en TypeScript y el adaptador propio de
`app/web/navigation.ts`. La integración actual usa historial hash: el servidor siempre recibe
la ruta raíz y no hace falta un fallback de servidor para recargar una subruta. Se elige
routing en código para conservar el build de Vite en modo librería. No hace falta TanStack
Start ni TanStack Query para este alcance. La versión compatible está fijada en el lockfile.

| Ruta | Pantalla | Contrato |
|---|---|---|
| `/#/` | Inicio y proyectos | No abre automáticamente un proyecto previo. |
| `/#/aprender` | Índice | Solo lecciones publicadas, en orden editorial explícito. |
| `/#/aprender/$leccion?paso=<id>` | Lección | ID estable; paso desconocido se normaliza al primero. |
| `/#/projects/$project?board=<id>&file=<ruta>&leccion=<id>` | Editor | `leccion` conserva el vínculo de una práctica con su lección. |
| Hash desconocido o inválido | Inicio o salida de error | El adaptador conserva la aplicación operativa y normaliza rutas no válidas. |

Las rutas visibles son hashes: `/#/aprender/encender-un-led?paso=identificar` y
`/#/projects/$project?board=<id>&file=<ruta>&leccion=<id>`. La PR #50 guarda y restaura el
paso local cuando no viene en la URL. Al crear una práctica se guarda localmente la asociación,
la URL del proyecto incluye `leccion`, y desde el editor se puede volver a la guía y continuar
la práctica existente. Los nombres de proyecto se codifican como un único segmento usando las
utilidades del router; no se concatenan URLs a mano.

Elegir otra pantalla o lección agrega una entrada de historial. Cambiar de paso usa `replace`
para que Atrás vuelva a la pantalla anterior sin recorrer cada paso. La URL válida prevalece
sobre el paso local; si no hay paso en la URL se recupera el último paso válido guardado.

### Enlaces anteriores

Un hash antiguo `/#nombre` se interpreta como nombre de proyecto y se normaliza a
`/#/projects/$project` sin agregar una entrada de historial. Un fragmento mal codificado o un
proyecto inexistente conserva una ruta segura. Un hash que ya contiene `#/aprender` nunca se
interpreta como nombre de proyecto. La navegación se centraliza en el adaptador; no deben
coexistir controladores independientes de URL.

### Servidor y recarga directa

Como el router usa historial hash, el navegador solicita `GET /` tanto para `/#/aprender`
como para `/#/projects/...`; el fragmento no llega al servidor. No se agrega un fallback SPA.
Los endpoints `/api/*`, `/mcp` y los assets mantienen sus respuestas actuales. Probar recarga
y enlaces directos desde el navegador; las rutas inválidas se resuelven en el cliente.

## 4. Integración con la arquitectura actual

El router es dueño de la ubicación; `app.ts` sigue siendo dueño de los efectos del editor.
El estado del proyecto refleja una apertura exitosa, no funciona como otro router.
El router se consume a través del adaptador; el índice y la lección son una isla React montada
en `#pantalla-aprender`. Los componentes usan acciones tipadas del puente para navegar y no
dependen de `RouterProvider`, `Link` ni hooks del router.

El adaptador de navegación registra acciones tipadas en `react/puente.ts`; ningún componente
importa `app.ts`. El layout de rutas controla qué pantalla se muestra mediante ese adaptador.
El host del editor y sus islas conservan sus IDs y jerarquía, y se montan una sola vez.
Entrar a Aprender no desmonta y vuelve a crear el lienzo, el editor o la consola. No se
coloca un `Outlet` que reemplace accidentalmente los nodos que usa el código imperativo.
Caracterizar montaje, dimensiones y render antes de tocar el layout.

### Salida del editor y concurrencia

En el código actual, `guardar()` devuelve `false` al fallar, pero `irAInicio()` y
`cambiarDeProyecto()` no comprueban ese resultado. `guardarDiagramaYa()` despacha un fetch
sin esperar la respuesta y absorbe su rechazo. Por eso la caracterización debe distinguir
el comportamiento existente del contrato nuevo de conservación de datos: primero registrar
lo actual y luego agregar pruebas rojas para impedir la salida ante cualquiera de esos fallos.

Una única transición coordina enlaces, menú, selector de proyectos y Atrás/Adelante:

1. Captura proyecto de origen y destino; vacía el debounce del diagrama.
2. Espera el guardado de diagrama y archivo sucio. Revisar los contratos actuales:
   si `guardarDiagramaYa()` no retorna una promesa, se adapta para poder esperar su resultado.
3. Ante un fallo, conserva editor y cambios, informa el error y permite reintentar o cancelar.
   No da por guardado un archivo solo porque se despachó una petición.
4. Solo después de guardar confirma la salida y aplica los efectos de la pantalla destino.

El blocker del router protege también el historial; el adaptador no debe volver a bloquear
su propia continuación. Las cargas llevan un identificador de transición: una respuesta vieja
no puede reemplazar el proyecto de un destino más reciente. No se ejecutan escrituras desde
loaders ni preloads; precargar una ruta nunca crea una práctica ni inicia una simulación.
Al salir del editor se conserva la política existente de ejecución, caracterizada primero:
ocultar el editor no agrega un stop/run implícito. La guía no inicia la simulación automáticamente.
Para cerrar o recargar la pestaña con cambios pendientes se usa la protección `beforeunload`;
no se promete un guardado asíncrono garantizado durante el cierre.

## 5. Contenido y separación de responsabilidades

Ubicaciones vigentes y siguientes extensiones:

| Responsabilidad | Ubicación | Prueba |
|---|---|---|
| Contrato y normalización de rutas | `app/web/navigation-route.ts` | Vitest; incluye `leccion` en proyectos asociados. |
| Adaptador de TanStack Router e historial | `app/web/navigation.ts` | Vitest/E2E de navegación; entregado en #49. |
| Catálogo y primera lección | `app/web/aprendizaje/contenido.ts` | Vitest; base entregada en #50. |
| Persistencia local de progreso | `app/web/aprendizaje/progreso.ts` | Vitest; base entregada en #50. |
| Índice y vista de lección | `app/web/react/Aprendizaje.tsx` | Playwright; base entregada en #50. |
| Acciones entre React y efectos | `app/web/react/puente.ts`, `app/web/app.ts` | E2E; regreso y continuación de práctica implementados. |
| Plantilla práctica | `projects/_template/aprender-led/` | E2E de estructura; falta validar el recorrido eléctrico real. |

Todo código fuente nuevo o modificado será `.ts` o `.tsx`; se conservan imports `.js` cuando
resuelven fuentes TS. La plantilla contiene datos y se mantiene dentro de `_template`;
la primera práctica será un circuito sin placa y no necesita código ejecutable.

### Contrato de una lección

`Leccion` contiene `id`, `revision`, `titulo`, `resumen`, `nivel`, `duracionMinutos`, `orden`,
`objetivos`, `requisitos`, `materiales`, `pasos`, `erroresFrecuentes` y `practica` opcional.
`Paso` contiene `id`, `titulo`, bloques de contenido y resultado esperado. Los bloques se
modelan como unión discriminada de párrafo, lista, aviso, código y figura; se renderizan
con React, sin HTML arbitrario ni `dangerouslySetInnerHTML`. Las figuras necesitan texto
alternativo. `Practica` referencia un `templateId` estable y sus instrucciones de observación.

La definición vigente de la lección en #50 ya incluye objetivos, requisitos, materiales y
errores frecuentes, además de metadatos, pasos, bloques y plantilla. El catálogo valida los
campos requeridos antes de publicar las lecciones. IDs de lección y paso son únicos y estables;
`revision` es un entero positivo. No se guardan
índices de array como identidad. La validación exige pasos no vacíos, duración positiva,
orden determinista y referencias de plantilla existentes. No se publica contenido inválido.
El catálogo inicial se compila con el frontend; no necesita acceso al servidor para leer
una lección ya descargada. La práctica sí requiere servidor y catálogo de módulos disponibles.

## 6. Primera lección: Encender un LED

ID propuesto: `encender-un-led`; plantilla nueva: `aprender-led`.
Nivel inicial, aproximadamente 10 minutos, sin programación ni placa requerida.
Objetivos: reconocer ánodo/cátodo, cerrar un circuito y comprender la resistencia limitadora.

Materiales: fuente continua de 5 V, LED rojo y resistencia de 330 Ω, usando IDs y pines reales
del catálogo al implementar. Circuito: positivo → resistencia → ánodo; cátodo → negativo.
La plantilla abre con el circuito conectado y la fuente apagada. No se copia como lección una
plantilla actual que alimente una placa, porque introduce requisitos innecesarios.

Pasos: identificar componentes; seguir la polaridad y el retorno; estimar corriente con
`I ≈ (5 V − Vf) / 330 Ω` usando el valor del modelo; abrir la práctica y encender la fuente;
observar el LED y la corriente; apagarla e invertir el LED para comparar y restaurar el circuito.
Explicar circuito abierto, LED invertido y resistencia ausente sin exigir provocar daño.
Las cifras de resultado deben verificarse con el motor existente y una tolerancia razonada;
no fijar corriente exacta ni confundir el umbral visual con una medición eléctrica.

La práctica incluye instrucciones para cambiar el circuito ya conectado. Un circuito para
armar desde cero y la evaluación automática quedan para una etapa posterior. Completar
significa que la persona declara haber terminado: encender el LED no otorga certificación.

## 7. Crear y volver de una práctica

La PR #50 implementa “Abrir práctica” con nombre editable y reutiliza `POST /api/projects`
con `{ name, template }`; la plantilla `aprender-led` contiene fuente, resistencia y LED.
La lista de plantillas se sirve desde el catálogo existente. La integración evita crear otra
práctica al continuar la existente y conserva mensajes de error recuperables.
La API conserva su validación y sus errores; el frontend no necesita conocer rutas de disco.
Cada creación produce un proyecto independiente, sin sobrescribir proyectos ni modificar
la plantilla. Un nombre ocupado permite corregirlo. Mientras se crea, el botón queda deshabilitado.

La creación abre un proyecto independiente, guarda localmente la asociación lección/proyecto,
agrega `?leccion=<id>` a la ruta y ofrece “Volver a la lección” bajo la misma protección de
guardado. “Continuar práctica” abre la asociación existente sin crear otra. Si el proyecto fue
borrado, se quita la asociación y se ofrece crear otra práctica desde el último paso. Si la
respuesta de creación se pierde, consultar el proyecto por el nombre solicitado antes de
reintentar; no inventar otro nombre y duplicar la práctica automáticamente.

Una plantilla ausente o módulos faltantes dejan la lectura disponible, explican por qué la
práctica no puede abrirse y permiten reintentar. Los proyectos siguen usando su formato actual:
la asociación educativa es local, no agrega campos públicos a `project.json` en esta versión.

## 8. Progreso local

Clave propuesta: `emu.aprendizaje.v1`. Documento con versión de esquema y un mapa por ID de
lección: `revision`, `ultimoPasoId`, `completada`, `completadaEn` opcional y `proyectoNombre`
opcional. Estados visibles derivados: pendiente, en curso y completada. Abrir una lección
marca en curso; solo “Marcar como completada” finaliza. Se puede desmarcar sin borrar la práctica.

El adaptador inyecta almacenamiento y reloj para pruebas. Datos ausentes, JSON corrupto,
versión futura, IDs eliminados y errores de almacenamiento no impiden leer: se usa progreso
en memoria y se informa si no puede persistirse. Validar los campos antes de usarlos.
Si cambia la revisión del contenido, conservar la asociación a la práctica, reiniciar el paso
si ya no existe y mostrar pendiente de revisión; la finalización anterior no cuenta como
finalización de la revisión nueva. En otras pestañas, el evento `storage` actualiza la vista;
se usa el último documento persistido, sin prometer resolución colaborativa de conflictos.

El progreso pertenece a este navegador y origen. No es un registro del servidor, no se
sincroniza entre dispositivos y no debe bloquear ni restringir el acceso a las lecciones.

## 9. Experiencia y accesibilidad

Aprender aparece como sección activa en la navegación de bienvenida; Atajos y acerca de
sigue accesible en Ayuda. Índice con tarjetas y una lección con navegación de pasos, contenido
central, resultado esperado y acceso a práctica. Usar los estilos actuales y sus tokens.
En pantallas estrechas los pasos pasan arriba del contenido y no generan scroll horizontal.

Los enlaces son enlaces reales, los botones ejecutan acciones y los estados activos usan
`aria-current`. Cada pantalla tiene título y encabezado principal. Al cambiar de pantalla se
lleva el foco al encabezado; al cambiar de paso se enfoca su título. Los errores se anuncian
sin robar el foco de un campo que se está corrigiendo. Los ejemplos de código tienen contraste,
las figuras texto alternativo y todos los controles funcionan con teclado.

## 10. Plan de implementación por TDD

Cada entrega sigue **rojo → verde → refactor**: primero una prueba de comportamiento que
falle por la ausencia o el defecto concreto, después la implementación mínima y finalmente
la extracción de responsabilidades con las pruebas en verde. Los tests de caracterización
deben pasar contra el código actual antes de reemplazarlo. No sirven tests que solo comprueben
la presencia de TanStack Router o reproduzcan su implementación interna.

| Etapa / PR | Primero probar | Implementación mínima y condición de salida | Estado |
|---|---|---|
| 0. Caracterización | `/#nombre`, recarga, Atrás, selector, inicio, archivo sucio, debounce del diagrama, fallo de guardado y montaje del lienzo. | Congelar el comportamiento vigente y probar pérdidas de datos antes de migrar. | Cubierta por #49; sus pruebas regresivas pasan. |
| 1. Router | Historial hash, codificación, enlaces antiguos, recarga, assets/API conservan sus respuestas. | Router tipado y rutas de inicio/proyecto estables. | Implementada en #49; no necesita fallback SPA. |
| 2. Transiciones | Guardado retardado o rechazado, diagrama pendiente, A→B→C con respuestas desordenadas y Atrás cancelado. | Una respuesta vieja no pinta otro proyecto y ningún fallo pierde cambios. | Implementada en #49; regresiones pasan. |
| 3. Catálogo y lectura | IDs duplicados, paso inválido, lección inexistente, orden y deep link a paso. | Tipos, contenido y pantallas de índice/lección. | Implementada en #50; revisar foco accesible al cambiar de pantalla/paso. |
| 4. Progreso | Primera lectura, completar, recarga, revisión nueva, JSON corrupto y fallos de almacenamiento. | Persistencia tolerante a fallos; solo acción explícita completa. | Base implementada en #50; ampliar casos de revisión/migración. |
| 5. Práctica LED | Plantilla válida y circuito eléctrico; creación, duplicado, fallo de red, volver, continuar y proyecto borrado. | Recorrido asociado, editable y sin duplicados; verificación con motor real. | Asociación, retorno, continuación, copia y borrado cubiertos por E2E; motor real verifica apagada/encendida/invertida. Falta recuperación de creación ambigua. |
| 6. Integración y publicación | Recorrido completo, historial, recarga, vista estrecha, teclado y regresiones del editor. | Lección disponible con contenido y práctica verificados. | Pendiente tras completar la etapa 5. |

Tests puros en `app/tests/unit/aprendizaje*.test.ts` y `navigation-route.test.ts`; UI en
`app/tests/e2e/aprendizaje.spec.ts` y `routing.spec.ts`. Se usa historial en memoria con
instancia nueva por test, efectos
inyectados y promesas controladas para las carreras. Evitar sleeps fijos.

Los e2e usan las carpetas temporales de `playwright.config.ts` y no proyectos personales.
La prueba eléctrica usa el motor real y los fixtures existentes; cualquier cambio de física
queda fuera de esta implementación. Si requiere ngspice, documentar ese requisito y hacer
que CI lo provea; no convertir su ausencia en una prueba eléctrica falsamente aprobada.

### Criterios de aceptación verificables

1. Desde Inicio, Aprender abre `/#/aprender`; una URL de lección recargada muestra su contenido.
2. Una lección desconocida muestra una salida útil; `/api/inexistente` no devuelve la shell.
3. Un enlace antiguo a un proyecto válido abre el mismo proyecto con URL canónica.
4. Salir del editor por link, selector o historial espera todos los guardados; un error permite
   permanecer y reintentar sin perder código ni diagrama. Cancelar restaura ubicación y pantalla.
5. Navegación rápida termina en el último destino elegido; el editor conserva una sola instancia.
6. La lección recuerda el paso tras recarga y solo se completa mediante la acción explícita.
7. La práctica crea una copia editable, permite volver y continuar sin duplicar, y no modifica la plantilla. E2E cubre creación, vínculo, regreso, continuación y unicidad del proyecto; la copia no modifica la plantilla.
8. Fuente apagada: LED apagado. Circuito correcto encendido: LED conduce dentro de los límites
   del modelo. LED invertido: no conduce significativamente. **Verificado con ngspice sobre la
   plantilla de la práctica**; revisar tolerancias si cambia el modelo.
9. El recorrido completo funciona con teclado y en viewport estrecho; no rompe scroll del catálogo,
   edición, consola ni dibujo del circuito.

## 11. Verificación y flujo de entrega

Antes de cada push, desde `app/`, ejecutar los checks obligatorios de `CLAUDE.md`:
`npx vitest run` y `npx tsc -p server/tsconfig.json --noEmit`.
Para los PR de implementación también ejecutar `npm --workspace web run typecheck`,
`npm run build:web`, `npm --workspace server run build` y los e2e afectados (aprendizaje,
navegación, React, selector y render). El comando agregado `npm run build` actualmente falla
antes de compilar porque el workspace `@emu/shared` no define un script `build`; registrarlo
como limitación del repositorio hasta corregirlo.
La integración final ejecuta la suite e2e completa con el navegador configurado.
No agregar tests de ejecución para este PR que solo documenta el diseño.

Los PR se abren desde `origin/main` actualizado, o sobre una rama dependiente declarada.
Revisar PR abiertos que toquen los mismos archivos antes de implementar. Commits en español,
un tema por commit; el agente no mergea. En cada PR registrar pruebas, limitaciones y cambios
respecto de este SDD. Las etapas no se marcan completas hasta cumplir sus criterios.

## 12. Riesgos y decisiones pendientes al implementar

| Riesgo | Tratamiento y evidencia necesaria |
|---|---|
| React en islas y APIs de router fuera de contexto | Host único, navegación por puente y caracterización de jerarquía/montaje. |
| Guardados actuales no esperables o errores absorbidos | Revisar contratos y probar rechazo/latencia antes de permitir salidas. |
| Rutas del cliente se confunden con endpoints del servidor | Mantener historial hash; comprobar que `/api/*`, `/mcp` y assets conservan sus respuestas. |
| Nombre mal codificado o navegación concurrente | Decodificación segura, validación y pruebas con Unicode/espacios/respuestas atrasadas. |
| Plantilla o pieza no disponible | Verificar IDs reales y habilitar práctica solo si están disponibles. |
| Cambios en contenido dejan progreso inválido | Revisiones explícitas, IDs estables y validación del almacenamiento. |
| Bundle crece al agregar router y contenido | Comparar build antes/después; diferir carga de contenido si la medición lo justifica. |

Las brechas pendientes son verificar IDs/pines y tolerancia eléctrica con el motor, comprobar
el foco accesible al cambiar de pantalla y paso, y ampliar los casos de progreso de revisión y
almacenamiento. El contrato de ruta con lección asociada y el retorno/continuación ya están
implementados. El historial hash, la versión de TanStack Router y el host `#pantalla-aprender`
ya están definidos en #49/#50.

## Referencias

- [Convenciones y flujo](CLAUDE.md) y [arquitectura web](docs/arquitectura-web.md).
- [Plantillas existentes](projects/_template/README.md) y [motor eléctrico](docs/motor-electrico.md).
- TanStack Router: [rutas en código](https://tanstack.com/router/latest/docs/routing/code-based-routing),
  [historial](https://tanstack.com/router/latest/docs/guide/history-types) y
  [protección de navegación](https://tanstack.com/router/latest/docs/guide/navigation-blocking).
  Referencias consultadas al redactar; comprobar las APIs de la versión instalada durante TDD.
