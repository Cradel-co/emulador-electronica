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

## Frontend (`app/web`)

Reglas para la UI y para partir `app.ts`. El porqué de cada una, con los errores que las
originaron: [docs/arquitectura-web.md](./docs/arquitectura-web.md).

1. **Lógica pura → su propio módulo, con tests** (`geometria.ts`, `consultas.ts`, `paleta.ts`,
   `formato.ts`). Sin DOM ni estado global: recibe los datos por parámetro. Tests en `app/tests/unit/`.
2. **UI que genera HTML → componente de React**, montado con una isla (`react/montar.ts`) **sobre
   el nodo que ya existe** en `index.html`, nunca en un `div` nuevo adentro: el CSS cuenta con la
   jerarquía. Reproducir el comportamiento, no mejorarlo de paso.
3. **Lo que se repinta muy seguido se queda imperativo** (dibujo del circuito, editor, consola):
   React monta el contenedor y se corre. Medir antes de decir que algo es de alta frecuencia.
4. **`app.ts` es para efectos**: server, WebSocket, guardar, conectar piezas. Ni cálculo ni HTML.
5. **Los componentes no importan `app.ts`**: se hablan por `react/puente.ts`. El puente lleva
   efectos (`acciones()`), no preguntas: un cálculo sobre el diagrama va a `consultas.ts`.
6. **Estado** (`react/estado.ts`): escribir un campo avisa solo; mutar un `Map` o array por dentro
   necesita `notificar()`, y el componente lee con `useVersion()`. Si después de cambiar el estado
   hay que tocar el DOM que pinta React (p. ej. el `value` de un `<select>`), `ahora()`.
7. **Antes de mover código, tests de caracterización contra el código viejo**, y que pasen. Al
   extraer lógica, comparar la versión nueva con la vieja sobre casos al azar. Un test que pasa sin
   el arreglo no prueba el arreglo.

No hay límite de líneas por archivo: se separa por responsabilidad.

**Criterio permanente del producto:** desarrollo custom y escalable. Los componentes y contratos
son propios, reutilizables y configurables; las bibliotecas se integran mediante adaptadores.
Su estado interno no debe convertirse en el modelo de dominio ni propagarse por toda la aplicación.
Ver [arquitectura-web.md](./docs/arquitectura-web.md#componentes-propios-y-adaptadores).

## Documentación

- [README.md](./README.md) — puesta en marcha paso a paso y requisitos.
- [docs/](./docs/) — alcance, placas, módulos, fuentes de alimentación, troubleshooting.
- [SDD-CIRCUITO-LIBRE.md](./SDD-CIRCUITO-LIBRE.md) — diseño del solver de circuito libre y su plan de tests.
- [docs/audio.md](./docs/audio.md) — módulos que suenan: el contrato `salidas.sonido`, de la tensión
  a la amplitud, y qué falta para que el navegador reproduzca.
- [docs/arquitectura-web.md](./docs/arquitectura-web.md) — capas de la UI, cómo se hablan `app.ts` y los
  componentes de React, y las reglas de modularización con el error que originó cada una.
- [SDD-MODULOS.md](./SDD-MODULOS.md) — diseño de módulos completos (esquemático exportable, reglas y tests
  propios, comportamiento digital, entorno y salidas); la sección 8 dice qué ya está hecho y qué se aprendió.
- [SDD-EDITOR.md](./SDD-EDITOR.md) — diseño y alcance del editor CodeMirror 6 para MicroPython,
  con autocompletado, diagnóstico sintáctico local y pruebas de regresión.
- [SDD-AUDIO.md](./SDD-AUDIO.md) — diseño de los módulos que suenan y del micrófono: un contrato
  (`salidas.sonido`) con tres niveles de fidelidad (nivel de pin, PWM, I2S) y por qué el tono se
  declara en vez de calcularse.
- [SDD-ESP-CAMERA.md](./SDD-ESP-CAMERA.md) — diseño de la cámara OV2640 por DVP en ESP32-S3,
  compatibilidad del driver físico y frontera de fidelidad de la emulación.
- [chips/README.md](./chips/README.md) — chips con lógica (I2C/SPI en el Uno y puente MicroPython en ESP32): cómo se escriben y se prueban.
  Los sketches de prueba se compilan con `sh app/server/src/fixtures/chips/compilar.sh` (Docker) y los
  `.hex` se versionan: los tests corren sin Docker.
