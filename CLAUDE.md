# CLAUDE.md

Guía para Claude Code (claude.ai/code) al trabajar en este repositorio.

## Flujo de trabajo: siempre rama + PR

**Nunca commitear directo a `main`.** Todo cambio va en una rama y entra por Pull Request:

1. `git checkout -b <tipo>/<descripcion-corta>` desde `origin/main` actualizado
   (`fix/`, `feat/`, `docs/`, `refactor/`, `chore/`).
   Si el trabajo depende de otra rama abierta, ramificar **desde esa rama** y abrir el PR
   con `--base <esa-rama>`: GitHub rebasa la base sola cuando la otra se mergea.
2. Commits chicos y temáticos, mensaje en español, imperativo, que diga **qué problema resuelve**
   (no "arreglos varios"). Un commit por idea.
3. Antes de pushear: `npx vitest run` y `npx tsc -p server/tsconfig.json --noEmit` (desde `app/`) en verde.
4. `gh pr create --base <rama-base> --fill` y describir en el body: qué cambia, por qué, y cómo se probó.
5. Mergea el principal (Marcos), no el agente. El agente no mergea ni cierra PRs salvo pedido explícito.

Si hay un PR abierto que toca los mismos archivos, **revisarlo antes de escribir código**
(`gh pr view <n> --json files`) para no duplicar trabajo ni generar conflictos.

## Comandos

```bash
# Dev (server 5180 + web con recarga). Node 24 obligatorio.
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
cd /home/marcos/marcos/emulador-electronica/app && npm run dev

# Tests unitarios (vitest) y e2e (playwright)
cd /home/marcos/marcos/emulador-electronica/app && npx vitest run
cd /home/marcos/marcos/emulador-electronica/app && npx playwright test

# Typecheck por workspace (el CI no perdona un any implícito)
cd /home/marcos/marcos/emulador-electronica/app/server && npx tsc -p tsconfig.json --noEmit

# Build de producción
cd /home/marcos/marcos/emulador-electronica/app && npm run build
```

## Convenciones

- **Español** en comentarios, mensajes de commit, nombres de dominio (`conduce`, `voltajes`, `fuente`) y
  texto de UI. Los identificadores de la API pública y los campos de los `.json` quedan como están.
- TypeScript estricto con `noUncheckedIndexedAccess`: indexar un array devuelve `T | undefined`.
  Resolverlo con un chequeo explícito o un `?? 0` justificado, no con `!`.
- `projects/*` **no se versiona** (salvo `projects/_template/`): los proyectos de cada quien son locales.
  Un cambio que valga para todos va en una plantilla.
- Las placas y los módulos son **datos** (`modules/<id>/module.json`): agregar hardware no debería
  pedir código nuevo.
- Física eléctrica: `app/server/src/circuitPhysics.ts` (caminos fuente → GND, Ley de Ohm) y
  `app/server/src/solver.ts` (MNA, red completa — ver [SDD-CIRCUITO-LIBRE.md](./SDD-CIRCUITO-LIBRE.md)).
- Cambios en el solver o en la física: TDD. Primero el test que falla por la razón correcta.

## Documentación

- [README.md](./README.md) — puesta en marcha paso a paso y requisitos.
- [docs/](./docs/) — alcance, placas, módulos, fuentes de alimentación, troubleshooting.
- [SDD-CIRCUITO-LIBRE.md](./SDD-CIRCUITO-LIBRE.md) — diseño del solver de circuito libre y su plan de tests.
