# Reglas del proyecto

## TypeScript obligatorio

- Todo código fuente nuevo o modificado se escribe en TypeScript: `.ts`, o `.tsx` para componentes React con JSX.
- No crear archivos fuente `.js`, `.mjs` ni `.cjs`, incluidos tests, fixtures ejecutables, scripts y configuraciones.
- Si se modifica código JavaScript existente, convertirlo a TypeScript como parte del cambio.
- Los archivos JavaScript generados por compilación no se editan a mano. Los imports con sufijo `.js` que resuelven fuentes `.ts` se conservan cuando lo requiere la configuración de módulos.

## Convenciones y flujo de trabajo

Seguir también las convenciones, verificaciones y el flujo de rama + PR documentados en `CLAUDE.md`.
