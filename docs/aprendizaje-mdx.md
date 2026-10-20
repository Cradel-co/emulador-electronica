# Lecciones MDX y biblioteca educativa

La sección Aprender separa temas, rutas y lecciones. El catálogo editorial conserva títulos y descripciones de los recorridos pendientes. La ruta `ohm-kirchhoff-tellegen` dispone de seis lecciones MDX y ocho prácticas resistivas DC (cuatro circuitos base y cuatro variantes). La lección anterior `encender-un-led` conserva sus enlaces y progreso.

## Carpetas y contratos

- `app/web/aprendizaje-catalogo.ts`: temas y rutas editoriales.
- `app/web/aprendizaje/piloto.ts`: metadatos propios de las lecciones publicadas, revisión, requisitos, duración, ejemplo y predicciones.
- `app/web/aprendizaje/lecciones/*.mdx`: contenido desarrollado.
- `app/web/aprendizaje/_template/leccion.mdx`: modelo de autoría que se copia para crear contenido.
- `app/web/react/LeccionMdx.tsx`: adaptador MDX, componentes y registro explícito de documentos cargados bajo demanda.
- `app/web/aprendizaje/progreso.ts`: progreso local versionado y asociación con una práctica. Conserva el respaldo en memoria si el almacenamiento falla y actualiza otras pestañas.
- `projects/_learning/<id>/`: ejemplos compartidos, al lado de `projects/_template/`. Nunca se editan desde la práctica: se copia el ejemplo a un proyecto personal.

MDX se compila con Vite antes del plugin React, siguiendo la [integración oficial](https://mdxjs.com/docs/getting-started/). Las tablas usan `remark-gfm`. Se compila solamente contenido del repositorio; no hay evaluación de MDX recibido desde usuarios o servidores.

## Componentes disponibles

`Formula` incluye una expresión y descripción accesible, `Aviso` un título y explicación, `Ejemplo` un cálculo resuelto, `Circuito` un esquema del ejemplo, `Pregunta` una pregunta y respuesta desplegable, y `Actividad` las predicciones y la apertura de la práctica de la lección actual. El atributo `ejemplo` permite abrir una variante con su propia tabla de predicciones. Los esquemas identifican nodos, corrientes convencionales y valores ideales, derivados del contrato `aprendizaje/ejemplos.ts`.

Las fórmulas se representan como texto matemático con símbolos Unicode. Para fórmulas más complejas se puede ampliar el componente sin cambiar el contrato editorial. Las predicciones son ideales. El modelo CV/CC de la fuente suaviza la transición y puede dar pequeñas diferencias numéricas; las pruebas contra valores ideales admiten 0,5 %, mientras el balance de potencia usa la salida medida. Las predicciones se comparan manualmente con las medidas del emulador; completar una lección es una acción del estudiante.

## Agregar una lección

1. Copiar `_template/leccion.mdx` a `lecciones/<id>.mdx` y desarrollar el contenido con fuentes primarias.
2. Registrar los metadatos en `piloto.ts` (o separar un catálogo para la nueva ruta), manteniendo IDs únicos y referencias válidas.
3. Agregar el import diferido al registro `documentos` del adaptador. Vincular la lección con su ruta.
4. Para una práctica nueva, crear `projects/_learning/<id>/project.json` y `README.md`. Verificar el esquema, los terminales y las predicciones con el motor.
5. Ejecutar las pruebas de aprendizaje, navegación y API, los typechecks y el build web.

## Direcciones y API

`#/aprender`, `#/aprender/temas/<id>` y `#/aprender/rutas/<id>` abren el catálogo. `#/aprender/<leccion>?paso=contenido` abre una lección MDX. La consulta `leccion` en una dirección de proyecto permite volver a la lectura sin perder la práctica.

`GET /api/learning/examples` lista la biblioteca distribuida incluso si `EMU_PROJECTS_DIR` apunta a otra carpeta. `POST /api/learning/examples/:id/projects` con `{ "name": "mi-practica" }` crea una copia. Valida nombres, rechaza enlaces simbólicos y devuelve 409 si ya existe el proyecto. No mezcla ejemplos con `/api/templates`.

El piloto trabaja con resistores y una fuente en régimen DC. Los recorridos de transitorios, electromagnetismo y otros fenómenos del catálogo siguen en preparación: su presencia editorial no afirma que el motor los simule.

## Integración con el motor actual

La rama de Aprender incorpora `main` sin sustituir sus implementaciones de ADC, PWM,
transitorios ni los contratos de observación eléctrica. El editor y la vista compartida
consumen el mismo resultado de `avisosDelProyecto`: una observación obsoleta o no resuelta
retira las medidas, en lugar de presentar ceros o salidas encendidas por un GPIO alto.
Los controles USB pertenecen a cada instancia de placa y los tests usan esos controles.
La resolución conserva la actualización incremental del lienzo y la invalidación inmediata
al modificar el circuito, incorporadas por los PR #72 y #73.

La identidad de la sesión compartida se conserva si la ejecución se detiene por pérdida de
alimentación. En ese caso solo se permite liberar un pulsador momentáneo iniciado por esa
misma sesión. Cambiar la ejecución, recargar el código o guardar el proyecto invalida la
identidad anterior: el enlace viejo no puede alterar los controles del contexto nuevo.
El visor libera las pulsaciones pendientes al recibir un estado inactivo, perder foco o cerrarse.

La integración incorpora `main` hasta `9e50897`, incluido el PR #90. Conserva sus transacciones,
escrituras atómicas, registro único de rutas y reglas para rechazar simulaciones sin resolver.
El lockfile conserva las versiones de las dependencias de `main` y añade las necesarias para MDX.
Las pruebas del visor y de la biblioteca educativa están bajo `app/tests/unit/server/`, donde
las descubre la suite actual. La creación concurrente de prácticas con el mismo nombre se serializa.

Validación de esta integración con Node 24.21.0:

- `npm ci`, `npm run build`, typechecks de servidor/frontend y `npm run typecheck:modulos`: correctos.
- `npx vitest run`: 1742 pruebas aprobadas y una omitida; 165 archivos aprobados y uno omitido.
- `EMU_E2E_CHANNEL=chromium npx playwright test`: corrida completa finalizada, 167 casos aprobados
  y 14 omisiones condicionales del entorno, sin fallos. Incluye la liberación del pulsador mientras
  el mouse sigue abajo, el aislamiento LAN, los flujos de Aprender y los módulos del PR #90.
- Regresiones del servidor: libera la pulsación tras detenerse; rechaza nuevas pulsaciones con
  la sesión inactiva y rechaza liberaciones desde enlaces de otra ejecución o diagrama.
- Circuito de 100 LEDs: 5255 nodos, 40 cambios eléctricos y cero nodos creados o destruidos.
