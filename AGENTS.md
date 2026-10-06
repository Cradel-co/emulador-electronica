# Reglas del proyecto

## TypeScript obligatorio

- Todo código fuente nuevo o modificado se escribe en TypeScript: `.ts`, o `.tsx` para componentes React con JSX.
- No crear archivos fuente `.js`, `.mjs` ni `.cjs`, incluidos tests, fixtures ejecutables, scripts y configuraciones.
- Si se modifica código JavaScript existente, convertirlo a TypeScript como parte del cambio.
- Los archivos JavaScript generados por compilación no se editan a mano. Los imports con sufijo `.js` que resuelven fuentes `.ts` se conservan cuando lo requiere la configuración de módulos.
- **Los modelos de módulo cuentan**: el `model` de un `modules/<id>/module.json` nuevo se escribe en `model.ts`, no en `model.js`, aunque un módulo más viejo del catálogo todavía use `.js`. Los que faltan migrar los trackea el issue #41, y `catalogoModulos.test.ts` tiene la lista: un módulo nuevo en `.js` pone ese test en rojo.

## Convenciones y flujo de trabajo

Seguir también las convenciones, verificaciones y el flujo de rama + PR documentados en `CLAUDE.md`.

## Agregar un módulo o componente

Antes de crear un componente nuevo, leer [`docs/agregar-un-modulo.md`](docs/agregar-un-modulo.md):
son ocho pasos con el error que originó cada uno. Los dos que más caro salieron:

- **Clasificarlo primero.** "Agregar hardware no pide código nuevo" vale solo si usa mecanismos que
  ya existen; el primero de su clase es trabajo de plataforma.
- **Probarlo en la app con el firmware corriendo** antes de darlo por cerrado. Los tests por
  separado pueden pasar todos con el módulo sin funcionar.
