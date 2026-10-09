# changelog.d — una entrada por cambio

Cada rama que entra por PR deja acá **un archivo** con lo que cambia. Al cerrar una versión se
juntan todos en `CHANGELOG.md`.

## Por qué un archivo por cambio y no un CHANGELOG.md único

Porque un archivo único **da conflicto en cada merge**: todas las ramas agregan su línea arriba,
en las mismas líneas. Con varias ramas abiertas en paralelo —acá es lo normal— eso significa
resolver un conflicto por PR, en un archivo donde el conflicto es puro ruido.

Un archivo por cambio no choca con nada. Es el mismo patrón de `changesets` o `towncrier`.

## Cómo se escribe

Un archivo `changelog.d/<tipo>-<descripcion-corta>.md`, con el **mismo tipo que el prefijo de la
rama**:

| Tipo | Para |
|---|---|
| `feat` | algo nuevo que antes no se podía hacer |
| `fix` | algo que estaba mal |
| `docs` | documentación |
| `refactor` | el código se movió, el comportamiento no cambió |
| `chore` | herramientas, dependencias, andamiaje |

El contenido:

```markdown
El buzzer pasivo ya suena: el motor no sabía que el pin era una salida.

El escáner de pines no reconocía `machine.PWM`, así que el pin quedaba sin manejar y medía 0 V.
```

- **La primera línea es el resumen**, en una sola línea y hasta 160 caracteres. Que diga **qué
  cambia para quien usa la app**, no qué archivo se tocó. Mismo criterio que el mensaje del commit.
- **Lo que sigue es opcional**: el por qué, o el límite que conviene saber.
- Si el cambio ya tiene PR, agregá la referencia al final del resumen: `(#68)`.

## Qué se valida solo

`app/server/src/changelog.test.ts` revisa **todos** los fragmentos del repo en cada corrida de la
suite, así que un archivo mal nombrado o con un resumen de relleno pone un test en rojo en vez de
llegar al changelog. Rechaza:

- un tipo que no existe, diciendo cuáles valen;
- nombres sin descripción, con mayúsculas o con espacios;
- fragmentos vacíos;
- resúmenes de relleno (`TODO`, `wip`, `cambios varios`…);
- resúmenes de más de 160 caracteres.

## Cerrar una versión

```bash
cd app
npm run changelog -- 0.2.0              # ver el bloque que saldría
npm run changelog -- 0.2.0 --escribir   # escribirlo en CHANGELOG.md y limpiar los fragmentos
```
