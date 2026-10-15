# Organización de pruebas

Las pruebas se mantienen separadas del código de la aplicación. La ubicación depende del tipo y
del área que prueban:

- Unitarias de servidor: `app/tests/unit/server/`.
- Unitarias de contratos compartidos: `app/tests/unit/shared/`.
- Unitarias de frontend y de coordinación entre áreas: `app/tests/unit/`.
- De extremo a extremo: `app/tests/e2e/`.
- Fixtures y utilidades exclusivas de pruebas: `app/tests/fixtures/`, agrupadas por área.

Para las pruebas unitarias de `server` y `shared`, conservar bajo `unit/<área>/` la ruta relativa
que el módulo probado tenía bajo `src/`. Así se puede ubicar una prueba por el mismo concepto sin
ponerla junto al archivo de producción. Importar el código bajo prueba con rutas relativas o los
aliases ya configurados; resolver los fixtures desde su nueva ubicación.

## Regla al implementar o modificar

Cada cambio de comportamiento debe actualizar la prueba existente que lo cubre o agregar una
prueba en la carpeta correspondiente. Antes de crearla, buscar si ya existe una prueba relacionada
y ampliarla cuando corresponda. No crear archivos `*.test.ts` o `*.spec.ts` dentro de `src/`; tampoco
guardar helpers o datos exclusivos de pruebas allí. El código de producción permanece en sus
carpetas de área y los recursos que la app usa en producción permanecen con ese código.

Al mover una prueba, actualizar sus imports y las referencias a fixtures, proyectos o módulos, de
modo que sigan apuntando al mismo recurso. No cambiar la cobertura ni el alcance de la prueba como
parte de un movimiento de ubicación.

## Comandos

Desde `app/`:

```bash
npx vitest run
npx playwright test
```

Vitest descubre los `*.test.ts` bajo `tests/unit/`; Playwright descubre los `*.spec.ts` bajo
`tests/e2e/`. Los `tsconfig` de servidor y shared incluyen también sus pruebas unitarias para que
los cambios en tests se revisen con el typecheck correspondiente.
