# P0: inventario de la plataforma de componentes

Fecha: 20 de octubre de 2026. Base de código: `53e5721`; diseño: PR #91, `01f6ed7`.
Inspección estática; no representa ejecución de pruebas, medición ni certificación de capacidades.

## Capacidades y brechas

| Área | Evidencia en el código | Capacidad existente | Trabajo siguiente |
|---|---|---|---|
| Definición | `app/shared/src/module.ts` | Catálogo plano, pines, props y modelo | Definiciones inmutables por versión/digest y composición. |
| Instancias | `app/shared/src/diagram.ts` | ID, tipo, posición, rotación, props y entorno | Ruta jerárquica e identidad independiente de etiquetas y layout. |
| Proyecto | `app/shared/src/project.ts` | `schemaVersion:1`, módulos/cables y proyectos sin placa | Adaptación explícita sin campos nuevos que un lector viejo elimine silenciosamente. |
| Modelo eléctrico | `app/shared/src/modelo.ts` | R/C/L/D/V/I/S/SV/REG, observación y estado por instancia | Hoja legada; composición conecta sus puertos sin reescribir ecuaciones. |
| Transistor | Unión `Primitiva` del SDK | `SV` es un interruptor controlado; no hay primitiva BJT/MOSFET en esa unión | No afirmar transistor físico detallado; capacidad nueva si el piloto lo requiere. |
| Regulación | `modules/bme280-adafruit/model.ts` | REG con entrada/salida/tierra, caída, límite e iq | Reutilizar como hoja de referencia; no reconstruir su interior como supuesto esquema real. |
| Catálogo | `app/server/src/catalog.ts` | Carga módulo/SVG/código/pruebas; invalidación de caché | Snapshot inmutable del paquete completo; el tipo solo no fija contenido. |
| Modelos | `app/server/src/sim/modelos.ts` | Caché por hash y fallback por flags con diagnóstico | Adaptador nuevo debe conservar diagnóstico; nunca acreditar fallback como modelo verificado. |
| Aislamiento | `app/server/src/sim/sandbox.ts` | Validación de primitivas y límites por llamada | Mantener límite por hoja y añadir presupuesto total de composición. |
| Conectividad | `app/server/src/sim/analisis.ts` | Unión de referencias del proyecto y armado de circuito | Elaboración jerárquica con origen, independiente de GPIO y placa. |
| Solver | `app/server/src/sim/netlist.ts`, `nombresSpice.ts` | Elementos con dueño/local, mediciones y nombres SPICE asignados | Reutilizar asignación por identidad, nunca concatenar rutas sin escape. |
| Chips | `app/shared/src/chip.ts`, `app/server/src/bus/` | Chip lógico reutilizado por módulos, mapeo, buses y entorno | Adaptar instancias y reloj; no duplicar el chip cuando se abre una hoja. |
| Fabricación | `app/shared/src/fabricacion.ts` | Parte, símbolo, huella, conectores, despiece y vínculo con elementos | Conservar trazabilidad; no confundir metadatos con exportador jerárquico funcionando. |
| Importación | `app/server/src/moduleImporter.ts` | Paquetes propios, zip, URL/GitHub y conversión Wokwi | No se identificó importador `.kicad_sch` o netlist KiCad en fuentes inspeccionadas. |
| Exportación | `SDD-EXPORTACION.md`, `app/shared/src/informe.ts` | Informe JSON/HTML de prototipo; no paquete KiCad | Exportación física jerárquica es una brecha P3, con su propio contrato. |
| Guardado | `projectStore.ts`, `revisionGuardado.ts`, `escrituraAtomica.ts`, `colaProyectos.ts` | Cola, revisión fuerte y escritura atómica | Una transacción debe abarcar esquema, dependencias y selección, no varios archivos parcialmente guardados. |
| Editor | `app/web/canvas.ts`, `guardado-diagrama.ts` | Canvas plano, coordinación de guardado y revisión de edición | No se identificó editor de subhojas ni undo/redo de composición; el historial del editor de código no los acredita. |

Las búsquedas se realizaron en fuentes de `app/` y archivos del repositorio; una capacidad no
identificada se registra como brecha, no como prueba de que sea imposible incorporarla.

## Límites actuales comprobados

- Sandbox: 200 primitivas por llamada, 200.000 caracteres de salida, 300 ms por llamada y
  1.000 ms de carga. Son límites actuales, no presupuestos de composición ni garantías de rendimiento.
- `esquematico.discreto`: máximo 40 piezas; no es el límite general de una futura hoja.
- Importador: JSON/SVG 256 KiB cada uno, modelo 128 KiB, zip total 8 MiB y 2.000 entradas,
  hasta 100 módulos por importación. No ampliar esos límites para introducir jerarquía implícitamente.
- La referencia SPICE común y las resistencias de regularización numérica no representan un
  cable de tierra entre dos hojas. Debe conservarse el diagnóstico de flotante.

## Corpus inicial decidido

Se especifican escenarios reproducibles para implementar en P1/P2; no se agregan fixtures
ejecutables ni se presenta ninguno como probado en esta entrega.

| ID | Composición y observación | Referencia independiente |
|---|---|---|
| J01 | Divisor de dos resistores de 1 kΩ, puertos VIN/VOUT/GND; 5 V de entrada | VOUT=2,5 V e I=2,5 mA para el modelo ideal; comparar también con plano usando las mismas primitivas del solver. |
| J02 | Dos instancias de J01; en una cambiar resistor inferior a 2 kΩ | Solo esa salida pasa a 10/3 V ideal; estados, IDs y mediciones independientes. |
| J03 | J01 dentro de una hoja repetida tres niveles | Misma conectividad y resultados que el plano; ruta de diagnóstico conserva los tres niveles. |
| J04 | Dos GND de hojas sin unión explícita; luego cablearlos | Mismo nombre no crea unión. Comparar clases de conectividad; no usar exclusivamente voltaje regularizado para decidir aislamiento. |
| J05 | Fuente → hoja REG con parámetros del modelo MIC5225 existente → carga resistiva | Comparar con REG plano y rangos ya documentados por `modules/bme280-adafruit/tests.json`; es modelo equivalente, no nuevo esquema físico del regulador. |
| J06 | Selección interno/equivalente del mismo divisor y expansión visual | Una sola contribución eléctrica por efecto; expansión visual no cambia el resultado. |
| J07 | Puertos/instancias duplicados, referencias ausentes, versiones distintas y ciclo entre definiciones | Diagnósticos deterministas antes de ejecutar; no confundir ciclo de definiciones con lazo eléctrico. |
| J08 | Abrir, editar una instancia, undo/redo, guardar/recargar y exportar | Identidades y conexiones conservadas; BOM solo de piezas físicas elegidas; pendiente P3. |

J01/J02 usan resistores y fuente disponibles. J05 reutiliza una primitiva REG, sin prometer que
exista hoy un módulo de regulador separado. BJT/MOSFET y RF no bloquean el primer corpus.
Las tolerancias ideales y de solver son distintas: P2 registrará residuo numérico y fijará rangos
antes de aceptar resultados; no se usará el propio resultado como expectativa.

## Presupuestos iniciales de diseño

Objetivos por medir, no resultados. P1 aplica máximos antes de expandir; P2 registra tiempos y
memoria en una máquina identificada con versión Node/OS/CPU/RAM y commit.

| Recurso | Límite u objetivo inicial |
|---|---|
| Definición | 64 puertos, 200 hijos directos, 1.000 redes y 64 terminales por red. |
| Elaboración global | Profundidad 16, 2.000 instancias expandidas, 20.000 terminales y 10.000 redes; cancelar antes de reservar por encima. |
| Casos de coste | Pequeño: 10 instancias; medio: 200; grande: 2.000. Registrar primitivas efectivas además de instancias. |
| Elaboración | Objetivo p95 ≤ 500 ms en caso medio y ≤ 2 s en grande; sin ejecución de solver. |
| Memoria adicional | Objetivo ≤ 128 MiB en caso grande, excluyendo proceso ngspice; medir por separado. |
| Diagnóstico | Orden estable y máximo 100 problemas publicados con contador total; evitar respuestas sin límite. |
| Solver y editor | Mantener límites existentes; medir antes de ampliar y definir en P2/P3 sus presupuestos específicos. |

Si un límite impide el corpus, modificarlo mediante evidencia y decisión registrada. No declarar
que 2.000 instancias pueden simularse en tiempo real por haber podido validar sus contratos.

## Estado de salida P0

- Inventario y corpus de plataforma documentados.
- Decisiones iniciales de identidad/fuente de verdad en `ADR-001-COMPOSICION.md`.
- Primer contrato TypeScript añadido en `app/shared/src/componentes/contratos.ts`.
- Avance P1: catálogo en memoria por versión/hash, ciclos, parámetros, elaboración de redes y
  presupuestos globales bajo pruebas; ver [elaboracion.md](elaboracion.md).
- Avance siguiente: [verificación de paquetes e integración DC](electrico.md), con pines/props,
  medidas de divisores anidados y comparación con plano usando ngspice real.
- Pendientes P2/P3: representaciones, agenda común, editor, importación y fabricación.
- No se acredita H0–H3, compatibilidad ESP32 ni rendimiento. Las decisiones se revisan si la
  implementación o las mediciones contradicen el inventario.

## Selección de representaciones

El piloto permite elegir interior o equivalente completo por instancia, con propiedad exclusiva
de efectos y trazabilidad. Ver [contrato y evidencia](representaciones.md). La selección es por
consulta DC; los modelos complementarios por dominio y la agenda temporal siguen pendientes.
