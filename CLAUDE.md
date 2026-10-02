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

# Para entrar desde la tailnet (http://100.64.0.1:5180): el server escucha en 127.0.0.1
# y además valida el Host contra DNS rebinding, así que hacen falta las dos variables.
# El package.json está en app/, no en la raíz del repo.
cd /home/marcos/marcos/emulador-electronica/app && HOST=0.0.0.0 EMU_ALLOWED_HOSTS=100.64.0.1:5180 npm run dev

# Tests unitarios (vitest) y e2e (playwright)
cd /home/marcos/marcos/emulador-electronica/app && npx vitest run
cd /home/marcos/marcos/emulador-electronica/app && npx playwright test

# Los e2e usan el Chrome instalado en la PC. En una máquina sin Chrome (instalarlo pide root):
#   npx playwright install chromium        # baja el Chromium de Playwright, sin sudo
#   EMU_E2E_CHANNEL=chromium npx playwright test

# Typecheck por workspace (el CI no perdona un any implícito)
cd /home/marcos/marcos/emulador-electronica/app/server && npx tsc -p tsconfig.json --noEmit

# Build de producción
cd /home/marcos/marcos/emulador-electronica/app && npm run build
```

Hay un solo motor eléctrico y no hace falta ningún flag: `npm run dev` ya resuelve el circuito
entero (ngspice, ver [docs/motor-electrico.md](./docs/motor-electrico.md)). Si algo "no prende"
en la UI, lo primero es ver contra qué servidor estás mirando y qué calcula:

```bash
curl -s localhost:5180/api/projects/<proyecto>/pins | python3 -m json.tool | grep -A4 leds
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
- Física eléctrica: `app/server/src/sim/` (motor ngspice: el que usa la app, ver
  [docs/motor-electrico.md](./docs/motor-electrico.md)) y `app/server/src/solver.ts` +
  `circuitNetwork.ts` (MNA escrito a mano, ver [SDD-CIRCUITO-LIBRE.md](./SDD-CIRCUITO-LIBRE.md)):
  hoy es el verificador independiente — `sim/comparacion.test.ts` resuelve los mismos circuitos
  con los dos y exige que coincidan.
- Qué es salida y qué entrada lo decide el código del programa (`pinScan.direccionesDeCodigo`),
  no lo que tenga enchufado el pin. Lo que lee una entrada sale del motor (pull interno y
  umbrales VIL/VIH de la placa: `board.inputThresholds`).
- Cambios en el solver o en la física: TDD. Primero el test que falla por la razón correcta.

## Documentación

- [README.md](./README.md) — puesta en marcha paso a paso y requisitos.
- [docs/](./docs/) — alcance, placas, módulos, fuentes de alimentación, troubleshooting.
- [SDD-CIRCUITO-LIBRE.md](./SDD-CIRCUITO-LIBRE.md) — diseño del solver de circuito libre y su plan de tests.
- [SDD-MODULOS.md](./SDD-MODULOS.md) — diseño de módulos completos (esquemático exportable, reglas y tests
  propios, comportamiento digital, entorno y salidas); la sección 8 dice qué ya está hecho y qué se aprendió.
- [chips/README.md](./chips/README.md) — chips con lógica (I2C en el Uno): cómo se escriben y se prueban.
  Los sketches de prueba se compilan con `sh app/server/src/fixtures/chips/compilar.sh` (Docker) y los
  `.hex` se versionan: los tests corren sin Docker.
