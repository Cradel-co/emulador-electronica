# Lecciones MDX y biblioteca educativa

La sección Aprender separa temas, rutas y lecciones. El catálogo editorial conserva títulos y descripciones de los recorridos pendientes. La ruta `ohm-kirchhoff-tellegen` dispone de seis lecciones MDX y cuatro prácticas resistivas DC. La lección anterior `encender-un-led` conserva sus enlaces y progreso.

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

`Formula` incluye una expresión y descripción accesible, `Aviso` un título y explicación, `Ejemplo` un cálculo resuelto, `Circuito` un esquema del ejemplo, `Pregunta` una pregunta y respuesta desplegable, y `Actividad` las predicciones y la apertura de la práctica de la lección actual.

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
