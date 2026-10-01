# SDD: Circuito Libre (Free-Circuit Solver)

**Versión**: 1.0  
**Fecha**: 2026-09-30  
**Autor**: Marcos  
**Estado**: Integrado (2026-10-01). Sus ideas —la topología sale de los cables, un GPIO en
bajo hunde corriente, el programa decide quién maneja un pin, las entradas leen el voltaje del
circuito— se llevaron al motor ngspice de la app (`app/server/src/sim/`, ver
[docs/motor-electrico.md](./docs/motor-electrico.md)). Este solver quedó como verificador
independiente: `sim/comparacion.test.ts` resuelve los mismos circuitos con los dos. La revisión
le sumó fuentes entre dos bornes con límite CV/CC, el Vf del LED a 20 mA, los rieles por nombre,
la placa sin alimentar y los pull internos (commit "solver de circuito libre: arreglar lo que la
revisión encontró"). El flag `EMU_FREE_CIRCUIT` de §9 ya no cambia nada.

---

## 1. Objetivo

Permitir topologías de circuito **arbitrarias** en el emulador, donde los pines de los módulos pueden ser:

- **Conducidos por firmware** (comportamiento actual: `bridge.role = input|output`).
- **Pasivos** (sin firmware; el solver resuelve la red eléctrica completa).

Esto habilita maquetar circuitos "protoboard-style" antes de escribir código: botón → LED directo, divisores de tensión, puentes H pasivos, tiras de LEDs en serie, etc., y añadir firmware solo donde se necesite control/lectura.

---

## 2. Alcance y Fuera de Alcance

### Incluye
- Nuevo modelo eléctrico por pin en `module.json` (`electrical.model`).
- `bridge` opcional por pin (legacy: obligatorio).
- Solver MNA (Modified Nodal Analysis) que resuelve voltajes/corrientes en **todos** los nodos del circuito unificado.
- Puente firmware: pines con `bridge.role` imponen/leen voltaje en el nodo; sin bridge → nodo pasivo.
- API `/api/emulator` expone `nodes[]` con voltaje, corriente, pines miembro.
- UI: sonda de voltaje en cualquier nodo; muestra corriente en cables.
- Migración automática de `module.json` legacy (sin `electrical.model`) → comportamiento actual preservado.
- Tests de regresión: 239 unit + 10 e2e pasan sin cambios.

### No incluye (fase 1)
- Simulación transitoria de capacitores/inductores (solo DC steady-state).
- Modelos térmicos avanzados (solo `burnCurrentMa` actual).
- Editor de esquemáticos (la UI sigue siendo drag-and-drop de módulos + cables).

---

## 3. Modelo de Datos

### 3.1 `module.json` – Nuevo campo por pin

```json
{
  "pins": [
    {
      "name": "IN",
      "x": 16,
      "y": 74,
      "kind": "digital-in",
      "electrical": {
        "model": "diode",
        "params": { "vf": 2.0, "rs": 15, "reverseLeakage": 1e-9 }
      },
      "bridge": { "role": "output", "pin": "IN" }   // OPCIONAL
    },
    {
      "name": "GND",
      "x": 34,
      "y": 74,
      "kind": "ground",
      "electrical": { "model": "ground" },
      "bridge": null
    }
  ]
}
```

#### `electrical.model` válidos
| Modelo | Parámetros (`params`) | Uso típico |
|---|---|---|
| `ground` | — | Referencia 0 V (pin GND). |
| `voltage_source` | `voltage` (V), `r_series` (Ω) | Fuente ideal + resistencia serie. |
| `resistor` | `ohms` (Ω) | Resistencia pasiva. |
| `diode` | `vf` (V), `rs` (Ω), `reverseLeakage` (A) | LED, diodo Schottky, etc. |
| `switch` | `ron` (Ω), `roff` (Ω), `state` (0|1) | Botón, relé, MOSFET ideal. |
| `gpio_driver` | `v_low` (V), `v_high` (V), `r_out` (Ω) | Pin GPIO en modo salida (firmware impone voltaje). |
| `gpio_sensor` | `r_in` (Ω), `threshold` (V) | Pin GPIO en modo entrada (firmware lee voltaje). |
| `passive` | — | Nodo sin modelo (wire, jumper). |

> **Regla**: `ground` y `voltage_source` son **fuentes de voltaje ideales** en el MNA. `gpio_driver` se comporta como `voltage_source` cuyo valor impone el firmware cada step. `gpio_sensor` es alta impedancia (no afecta la red).

#### `bridge` (opcional)
```json
"bridge": { "role": "output" | "input", "pin": "NOMBRE_PIN_FIRMWARE" }
```
- `output`: firmware escribe → nodo se convierte en `gpio_driver` con voltaje 0/3.3 V.
- `input`: firmware lee → nodo expone voltaje al firmware (`gpio_sensor`).
- **Ausente**: pin puramente pasivo; el firmware no lo toca ni lo lee.

#### Migración legacy (automática al cargar)
| `module.json` original | Resultado migrado |
|---|---|
| Pin con `bridge` pero sin `electrical` | `electrical.model` inferido: `output` → `gpio_driver`, `input` → `gpio_sensor`, `ground` → `ground`. |
| Pin sin `bridge` y sin `electrical` | `electrical.model = "passive"` (wire). |
| Módulo sin `electrical` en ningún pin | Se añade `electrical` a todos los pines según regla arriba. |

---

### 3.2 Catálogo de modelos base (builtin)

```ts
type ElectricalModel =
  | { model: 'ground' }
  | { model: 'voltage_source'; voltage: number; r_series?: number }
  | { model: 'resistor'; ohms: number }
  | { model: 'diode'; vf: number; rs?: number; reverseLeakage?: number }
  | { model: 'switch'; ron: number; roff: number; state: 0 | 1 }
  | { model: 'gpio_driver'; v_low: number; v_high: number; r_out?: number }
  | { model: 'gpio_sensor'; r_in?: number; threshold?: number }
  | { model: 'passive' };
```

---

## 4. Solver: Modified Nodal Analysis (MNA)

### 4.1 Por qué MNA
- Maneja fuentes de voltaje ideales (`ground`, `voltage_source`, `gpio_driver`) sin divisiones por cero.
- Extensible a no-lineales (diodo, switch) vía Newton-Raphson.
- Matriz dispersa → performance O(N) típico para circuitos < 200 nodos.

### 4.2 Variables
- **Nodos**: cada unión de pines conectados por wires = 1 nodo (potencial `V`).
- **Corrientes extra**: una por fuente de voltaje ideal (`ground`, `voltage_source`, `gpio_driver`) → variable `I`.

### 4.3 Ecuaciones (por step de emulación)

Para cada nodo `k` (KCL):
```
Σ I_resistivas(k) + Σ I_diodo(k) + Σ I_switch(k) + Σ I_fuentes(k) = 0
```

Para cada fuente de voltaje ideal `s` entre nodos `p` (positivo) y `n` (negativo):
```
V_p - V_n = V_s (valor impuesto por firmware o parámetro)
```

### 4.4 No-lineales (diodo, switch)
- Diodo: Shockley simplificado `I = Is * (exp(Vd / (n*Vt)) - 1) + Vd/Rs` → linealizado por Newton.
- Switch: `R = state ? ron : roff` (cambio discreto; si cambia de estado, reinicia iteración).

### 4.5 Algoritmo por step
```ts
function solveStep(circuit: Circuit, fwOutputs: Map<string, 0|1>): Solution {
  // 1. Construir matriz MNA (sparse)
  //    - Nodos = unión de pins conectados (union-find sobre wires)
  //    - Variables = V[nodos] + I[fuentes_ideales]
  // 2. Aplicar valores de firmware: para cada pin con bridge.output,
  //    fijar V_fuente = fwOutputs[pin] ? 3.3 : 0
  // 3. Newton-Raphson:
  //    while (maxIter && residuo > tol) { J * dx = -F; x += damping*dx; }
  // 4. Devolver { nodeVoltages, branchCurrents, pinCurrents }
```

### 4.6 Parámetros de convergencia
| Parámetro | Valor por defecto |
|---|---|
| `maxIter` | 25 |
| `tolVoltage` | 1 µV |
| `tolCurrent` | 1 nA |
| `damping` | 0.5 (reducir si diverge) |

### 4.7 Detección de errores
- Nodo flotante sin camino a ground → warning, se fija en 0 V.
- Bucle de fuentes de voltaje ideales sin resistencia → error (topología inválida).
- Corriente > `burnCurrentMa` en pin → evento `burn`.

---

## 5. Integración con Firmware (Puente)

### 5.1 Ciclo de emulación (actual → nuevo)

**Actual (step)**:
```
1. firmware.step()
2. bridge.pushOutputs()  // setea voltajes en pines bridge.output
3. solver.resuelve()     // solo nodos con bridge
4. bridge.pullInputs()   // lee voltajes en pines bridge.input
```

**Nuevo (step)**:
```
1. firmware.step()
2. Recolectar fwOutputs = { pinFirmware: 0|1 } para cada bridge.output
3. MNA.solve(fwOutputs)  // resuelve TODA la red
4. fwInputs = { pinFirmware: V_nodo > threshold ? 1 : 0 } para cada bridge.input
5. firmware.recvInputs(fwInputs)
```

### 5.2 `bridge.role: "output"` → `gpio_driver`
- El pin **impone** voltaje en su nodo (`V = 3.3` o `0`).
- `r_out` modela la impedancia de salida del GPIO (default 50 Ω).

### 5.3 `bridge.role: "input"` → `gpio_sensor`
- El pin **no afecta** la red (alta impedancia `r_in` ≈ 1 MΩ).
- El firmware lee `V_nodo > threshold ? 1 : 0` (threshold default 1.65 V).

### 5.4 Sin `bridge`
- El pin es pasivo (`electrical.model` define su comportamiento).
- El firmware **no ve** ese pin.

---

## 6. API – `/api/emulator` (extendida)

```ts
interface EmulatorStatus {
  state: EmulatorState;
  running: boolean;
  project: string | null;
  ports: EmuPorts | null;
  ip: string | null;
  startedAt: number | null;
  exitInfo: string | null;
  nodes: NodeInfo[];          // NUEVO
}

interface NodeInfo {
  id: string;                 // hash del nodo (union-find)
  voltage: number;            // V
  current: number;            // A (corriente neta saliendo del nodo)
  pins: PinRef[];             // pines que caen en este nodo
  powerMw: number;            // V * I disipado en el nodo
}

interface PinRef {
  moduleId: string;           // id de instancia en el proyecto
  pinName: string;            // nombre del pin en module.json
  kind: 'digital-in' | 'digital-out' | 'ground' | 'power' | 'analog';
  bridgeRole?: 'input' | 'output' | null;
}
```

- UI usa `nodes[]` para sonda: hover en cable → muestra voltaje/corriente del nodo.
- `recentLog` incluye eventos `node:voltage` / `node:overcurrent` opcionales.

---

## 7. UI – Cambios Mínimos

| Componente | Cambio |
|---|---|
| `canvas.ts` | Al hover en wire, muestra tooltip con `voltage`/`current` del nodo (desde `emulator.nodes`). |
| `depuracion.ts` | Panel "Nodos" opcional: lista `nodes[]` con voltaje/corriente, filtro por módulo. |
| `app.ts` | Sin cambios funcionales; solo pasa `nodes` al frontend via WS. |

---

## 7 bis. Relación con el PR #4 (fuente regulable / interruptores)

El PR #4 de Brian Padilla ataca el mismo problema desde `circuitPhysics.ts` (recorrido de
caminos fuente → GND) y ya resuelve los casos más pedidos sin tocar el solver:

- **Interruptores eléctricos**: un pulsador o una llave cerrada une sus dos pines, así un LED
  prende por corriente directa sin firmware (el caso "botón → LED" del objetivo).
- **Fuente regulable** como módulo del catálogo (CV/CC, límite de corriente) y **alimentación de
  la placa** declarada en su `module.json`: ya existe una fuente de voltaje de verdad que no es
  un GPIO.
- Plantilla `projects/_template/circuito-continuo/` con el circuito continuo armado.

Este SDD **no lo reemplaza**: `circuitPhysics.ts` recorre caminos en serie (una fuente, una
cadena hasta GND) y por eso no resuelve ramas en paralelo, divisores con carga ni mallas. El
solver MNA de `solver.ts` es la base general para eso y es la que debería absorber a
`circuitPhysics.ts` cuando esté completa. Orden de trabajo acordado: primero entra el PR #4,
después el solver crece sobre esa base.

---

## 8. Tests (TDD – Orden de Implementación)

| # | Test | Qué valida |
|---|---|---|
| 1 ✅ | `solver: pin pasivo (resistor a GND)` | Nodo sin bridge se resuelve; V = 0 en GND, V = 3.3 * R2/(R1+R2) en divisor. |
| 2 ✅ | `solver: dos LEDs en serie` | Con 5 V fuente → ambos conducen (~10 mA); con 3.3 V → corriente < 1 µA (no encienden). |
| 3 | `solver: bridge.output opcional` (se expresa con las primitivas actuales: nodo `voltage_source` + resistor de `pinOutputOhm` como Thevenin del GPIO) | Mismo LED: test A con `bridge.output` en IN (firmware impone 3.3 V) → V_IN = 3.3 V; test B sin bridge → V_IN resuelto por red. |
| 4 | `integracion: botón → LED directo` (cubierto por el PR #4 en `circuitPhysics`; pendiente a nivel solver: rama `switch`) | Proyecto sin firmware: botón momentáneo + LED + R a GND. Apretar → LED enciende (corriente > 5 mA). Soltar → apaga. |
| 5 | `regresion: modulo legacy (LED actual)` | Cargar `modules/led/module.json` SIN `electrical` → migración automática crea `gpio_driver` en IN, `ground` en GND; test e2e `quemado.spec.ts` pasa igual. |
| 6 | `regresion: suite completa` | `npm test` (239) + `npx playwright test` (10) pasan sin tocar tests existentes. |

---

## 9. Plan de Migración (Cero Downtime)

1. **Feature flag** `EMU_FREE_CIRCUIT=1` (default OFF en prod).
2. Loader de módulos: si flag OFF → comportamiento legacy (ignora `electrical`, exige `bridge`).
3. Flag ON → usa MNA completo, migración automática de `module.json`.
4. Rollout: dev → staging (flag ON) → prod (flag ON tras validación e2e).
5. Cleanup: quitar flag, eliminar código legacy de puentes obligatorios.

---

## 10. Riesgos y Mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| No convergencia del Newton en circuitos grandes | Emulador se cuelga / step > 100 ms | Límite de iteraciones + damping adaptativo; fallback a solución anterior + warning. |
| Performance: MNA cada step (200 Hz) | CPU ↑ | Matriz dispersa (SuiteSparse / `sprs` en Rust via WASM o `ml-matrix` en TS); cachear patrón de matriz (topología no cambia entre steps). |
| Regressión silenciosa en proyectos legacy | Firmware se comporta distinto | Suite e2e obligatoria antes de merge; comparar logs de `quemado`, `rotacion`, `inicio` paso a paso. |
| Complejidad de `module.json` para usuarios | Curva de aprendizaje | Documentación + UI que sugiere `electrical.model` al crear pin; plantillas por categoría. |

---

## 11. Próximos Pasos (tras aprobación)

1. **Aprobar SDD** (este doc) → crear branch `feat/free-circuit`.
2. **Test 1 (TDD)**: `solver: pin pasivo` en `server/src/solver.test.ts` (rojo).
3. **Implementar MNA core** (`server/src/solver.ts`) → verde.
4. Tests 2–4.
5. Migración loader + flag.
6. Tests 5–6.
7. UI sonda + flag ON en dev.
8. PR único con SDD adjunto.

---

## 12. Referencias

- `server/src/emulator.ts` – ciclo actual de emulación (líneas 87–200).
- `server/src/ports.ts` – reserva de puertos UART/TCP (bridge actual).
- `modules/*/module.json` – catálogo actual (100+ módulos a migrar).
- `app/server/src/emulator.test.ts` – tests de REPL/consola (patrón de mocks).
- Libro: *"Modified Nodal Analysis"* (Ho, Ruehli, Brennan) – base teórica.