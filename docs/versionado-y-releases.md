# Política de versionado y releases

## Alcance y estado

La aplicación usa una versión de producto común con formato `MAJOR.MINOR.PATCH`, siguiendo
[SemVer 2.0.0](https://semver.org/lang/es/) y la convención de desarrollo inicial definida aquí.
`shared`, `server` y `web` se distribuyen juntos y deben declarar la misma versión.
La raíz `app/package.json` es un contenedor privado de workspaces sin versión propia.

Al incorporar esta especificación, los tres paquetes declaran `0.1.0`; no hay releases ni
etiquetas publicadas. Ese valor es metadato de desarrollo, no evidencia de una release validada.
Ya existen los fragmentos por PR y el generador de changelog. La coordinación de versiones,
etiquetas y publicaciones es manual; su automatización queda pendiente.
Agregar esta política no cambia las versiones ni publica una release.

## Elegir la siguiente versión

| Cambio acumulado desde la última release | Incremento | Ejemplo |
|---|---|---|
| Correcciones compatibles, ajustes internos o documentación | PATCH | `0.2.0` → `0.2.1` |
| Nuevas funcionalidades o un bloque completo del roadmap | MINOR; PATCH vuelve a cero | `0.2.1` → `0.3.0` |
| Cambio incompatible durante el desarrollo inicial | MINOR; documentar migración | `0.3.2` → `0.4.0` |
| Primer contrato público estable | MAJOR; MINOR y PATCH vuelven a cero | `0.x.y` → `1.0.0` |
| Cambio incompatible después de `1.0.0` | MAJOR | `1.4.2` → `2.0.0` |

En `0.x.x`, SemVer considera la API en desarrollo y no garantiza estabilidad. Reservar PATCH
para cambios compatibles y usar MINOR para incompatibilidades es nuestra convención adicional.
Después de `1.0.0`, MINOR agrega funcionalidad compatible y PATCH corrige errores compatibles.
Si una release reúne varios tipos de cambios, se aplica el incremento de mayor alcance.
Las versiones no siguen automáticamente el número de etapa del roadmap.

Una PR o un commit no obliga a publicar una versión. Cada PR aporta su fragmento de changelog;
una release reúne los cambios integrados, probados y listos para distribuir. Una corrección
urgente puede justificar una release propia. No se modifica el contenido de una versión ya
publicada: cualquier corrección se publica con otro número.

## Compatibilidad y paso a 1.0.0

Se consideran contratos públicos la API REST y WebSocket, los formatos de proyectos e informes
exportados y los contratos de placas, módulos y plantillas usados por terceros. La versión del
producto no reemplaza las versiones de esquema ni las revisiones de guardado de proyectos.
Cambiar resultados físicos exige explicar la corrección, su validez y sus efectos sobre los
informes; si rompe un contrato documentado, se trata como incompatibilidad.

Antes de declarar `1.0.0` se debe:

- Inventariar y documentar esos contratos, sus límites y la política de deprecación y migración.
- Verificar instalación, arranque y recorridos principales con firmware y hardware emulado.
- Validar lectura de proyectos existentes y migraciones, sin pérdida silenciosa de datos.
- Tener pruebas de regresión de contratos y criterios de aceptación cumplidos para la release.
- Documentar limitaciones conocidas y el procedimiento reproducible de distribución.

No se exige terminar todo el roadmap para llegar a `1.0.0`; se exige estabilidad del alcance
que se declara público. Marcos aprueba el alcance y autoriza la publicación.

## Procedimiento de release

1. Partir de `origin/main` actualizado y abrir una rama `codex/chore-release-X.Y.Z`.
   Revisar los fragmentos integrados y decidir el número según la tabla. Para la primera release,
   evaluar el contenido completo: no asumir que el metadato `0.1.0` ya fue publicado.
2. Actualizar juntos `app/shared/package.json`, `app/server/package.json` y
   `app/web/package.json`. Regenerar `app/package-lock.json` con npm y revisar las versiones
   de los workspaces; no cambiar dependencias ajenas al cierre.
3. Agregar el único fragmento `changelog.d/chore-release-X.Y.Z.md` de la rama, indicando la
   versión y el alcance. Ejecutar desde `app/` primero `npm run changelog -- X.Y.Z` para revisar
   el bloque y luego `npm run changelog -- X.Y.Z --escribir` para consolidar `CHANGELOG.md`.
   El segundo comando consume todos los fragmentos, incluido el de esta rama: esa eliminación
   es la excepción de cierre de release a la conservación habitual del fragmento por PR.
   Agregar instrucciones de migración y límites cuando corresponda.
4. Ejecutar desde `app/` la suite completa de Vitest, los typechecks de server y web, el build
   de producción y los e2e correspondientes a las funcionalidades incluidas. Probar el arranque
   y los recorridos principales de la distribución preparada. Registrar resultados en la PR.
5. Abrir la PR contra `main`, con alcance, compatibilidad, migraciones y validación. Resolver
   observaciones y repetir las verificaciones afectadas. El merge requiere autorización expresa
   cuando lo realiza un agente, según `CLAUDE.md`.
6. Tras el merge, verificar el commit exacto integrado y crear la etiqueta anotada `vX.Y.Z`
   sobre ese commit. Publicar una GitHub Release con esa etiqueta, las notas de `CHANGELOG.md`,
   requisitos, límites e instrucciones de instalación; incluir los artefactos que se hayan
   construido y probado cuando la distribución los requiera. Publicar requiere autorización
   expresa; mergear una PR de funcionalidad no autoriza una release.
7. Comprobar que etiqueta, commit, versiones de paquetes y notas corresponden a la misma
   entrega. Conservar las versiones y etiquetas publicadas sin sobrescribirlas ni moverlas.

El comando de changelog solo reúne fragmentos: no valida SemVer, no actualiza paquetes,
no ejecuta pruebas y no crea etiquetas ni GitHub Releases.

## Automatización pendiente

Una implementación futura podrá validar el formato y el incremento, comprobar que los paquetes
y el lockfile coinciden, y preparar notas y artefactos desde el commit de release. Debe mantener
la aprobación de publicación y comprobar etiquetas existentes para impedir sobrescrituras.
Esta especificación establece el proceso manual; no afirma que esos controles ya existan.
