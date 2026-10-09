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

Validación de la integración (Node 24.21.0): `npm ci`, build general y typechecks de
servidor/frontend correctos; Vitest completo: 1602 pruebas aprobadas y una omisión
existente. Los siete E2E focalizados de MDX y vista compartida pasaron.
La primera corrida amplia detectó siete fallos de helpers/aislamiento; se corrigieron
sin retirar comprobaciones. La segunda completó 156 de 158 casos sin fallos (143
aprobados y 13 omisiones condicionales existentes), antes de terminar externamente
con código 143. El archivo final de ventanas se verifica por separado para completar
la cobertura; esto no equivale a una corrida completa finalizada en un solo proceso.
El archivo `tool-window.spec.ts` pasó sus cuatro casos en un servidor nuevo. La unión
de ambas corridas cubre los 145 casos aprobados y las 13 omisiones del listado final,
sin nuevos skips. El circuito de 100 LEDs mantuvo cero nodos creados/destruidos en
40 cambios eléctricos.
