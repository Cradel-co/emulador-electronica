# Análisis temporal, ADC, térmica y evidencia

Registro de la primera tanda temporal. La implementación posterior de adquisición ADC,
ADC1 MicroPython, comprobaciones I2C, térmica acoplada y presupuesto RF se describe en
[Perfiles físicos](PERFILES-FISICOS.md); sus dominios actualizan las limitaciones de esta fotografía histórica.

Continuación del [plan de fidelidad](PLAN-FIDELIDAD-FISICA.md), 4 de octubre de 2026. Esta entrega amplía fenómenos concretos; no declara equivalencia total con el hardware. El circuito que acompaña al firmware sigue usando instantáneas DC. La nueva traza transitoria es un **análisis de diseño independiente**, con topología y GPIO fijos.

## Transitorios del equivalente eléctrico

`analizarTransitorioCircuito` reutiliza la topología, alias, catálogo y armado de placa de `analizarCircuito`. `Netlist.textoTransitorio` genera `.tran`, y el adaptador devuelve muestras adaptativas de tensión, corriente y potencia. `.op` conserva su contrato. No se sustituye la traza por su último punto ni se interpolan puntos para aparentar mayor resolución.

Leyes comprobadas con oráculos analíticos:

- RC: `i=C·dv/dt`, descarga `v=V0·exp(−t/RC)` y carga mediante fuente/rampa.
- RL: `v=L·di/dt`, descarga `i=I0·exp(−Rt/L)`.
- RLC subamortiguado: ecuación diferencial de segundo orden con frecuencia natural `1/sqrt(LC)` y amortiguamiento `R/(2L)`.
- Energía: `EC=C·v²/2`, `EL=L·i²/2`; se compara la energía inicial con la almacenada final más la integral de potencia resistiva. El presupuesto de regresión es 0,5 % para estos fixtures, no tolerancia de un componente físico.

Además, cada muestra debe cumplir KCL y balance de potencia instantánea antes de publicarse: tolerancia de 1 µA más 0,1 % de la corriente total incidente, y 1 nW más 0,1 % de la potencia absoluta total. El balance incluye almacenamiento en C/L y fuentes; no confunde potencia absorbida con disipación térmica. Estos controles verifican coherencia del equivalente matemático, no fidelidad de parámetros físicos.

La inicialización es obligatoria:

| Opción | Contrato |
|---|---|
| `equilibrio` | Obtiene el punto DC previo; no aplica cargas/corrientes iniciales declaradas en C/L. |
| `explicita` | Usa UIC y exige estado inicial para cada C/L, desde el modelo o un override `dueño.elemento`. No inventa cero para una condición ausente. |

Las fuentes V admiten estímulos lineales por tramos `{t,valor}`: tiempo inicial cero, tiempos estrictamente crecientes y valores finitos. Una fuente limitada CV/CC conserva su polaridad estructural; se rechaza un estímulo que requiera invertirla. Las fuentes V sin limitación pueden ser bipolares. No hay scripts SPICE libres en la API.

El catálogo incluye **capacitor e inductor ideales**, con valores en F/H y condiciones iniciales en V/A. No se les atribuyen ESR, fugas, saturación, pérdidas del núcleo, ruptura ni dependencia de temperatura. Esas extensiones necesitan modelos/partes identificados. La resistencia conserva el equivalente `V=IR`, permite declarar potencia nominal y avisa riesgo sin afirmar que ya se quemó.

### API

`POST /api/projects/:name/analysis/transient`

Ejemplo sobre un proyecto con `c` (capacitor) y `r` (resistor), con la fuente energizada:

```json
{
  "parametros": {
    "pasoS": 0.00001,
    "duracionS": 0.005,
    "inicializacion": "explicita",
    "condicionesIniciales": { "c.c": 0 }
  }
}
```

Devuelve `perfil: "transitorio-diseno-gpio-fijos"`, parámetros, unidades, `t`, `pines`, `elementos` y advertencias. `elementos[id]` contiene `tipo`, `v`, `i`, `p`; `p` positiva significa potencia eléctrica absorbida, **no siempre calor**. Los instantes están en segundos. El resultado no cambia el firmware, el estado guardado ni el punto DC vivo. Tampoco ejecuta el callback `observar` de un módulo a cada instante: sus estados, consumo y controles permanecen fijos en esta solicitud.

La ruta toma los niveles/controles disponibles al cargar el proyecto. No energiza fuentes que estaban apagadas. No hay todavía una ventana de osciloscopio en la UI: esta entrega expone la API y los contratos reutilizables. Las medidas sin ecuación se omiten y se explican; una referencia puramente numérica no acredita una tensión absoluta física.

La referencia se comprueba por isla: una fuente con masa en otra parte del proyecto no referencia un RC desconectado. Se recorren caminos verificables desde el nodo cero por R/S menores de 100 MΩ y por C/L/V; se omiten tensiones absolutas sin ese camino, conservando diferencias de potencial, corrientes y potencias de elementos. Diodos, bloques X y controles REG/SV no se presuponen conductores durante todo el barrido. Esta política conservadora puede omitir tensiones de una topología físicamente referenciada que todavía no sabemos acreditar; las advertencias lo indican.

Errores de estructura devuelven 400; solicitudes que el modelo/solver no puede resolver, 422 con `resuelto:false`. Un resultado numérico no acredita el hardware. Se rechazan vectores ausentes, complejos, no finitos, dispersos, de distinta longitud, tiempos no crecientes y trazas incompletas.

### Coste acotado

Se limita la cantidad de elementos, vectores, muestras y valores agregados de entrada/salida. El detalle vigente se mantiene en `sim/transitorio.ts`, `sim/netlist.ts` y `sim/validacionSpice.ts`: 256 elementos del netlist, 1024 vectores, 20.000 muestras estimadas, 50.000 muestras adaptativas y un millón de valores agregados. La expansión de alias también cuenta para la respuesta.

El worker sigue siendo único, con cola acotada y plazo de cálculo de cinco segundos. El presupuesto previo y la validación posterior reducen el coste; **no son una cuota total de memoria del sistema operativo**. Los arrays internos de ngspice/WASM pueden existir antes de validar la respuesta. No se abren múltiples simuladores pesados para probar estos límites.

## ADC conectado al circuito

`analogicoAvr.ts` convierte el snapshot eléctrico a los canales del Uno y adapta `AVRADC` sin exponer internals de avr8js al servidor. El estado se entrega antes de ejecutar firmware y se actualiza junto a las entradas del circuito. El arranque recalcula después de retirar los GPIO de la corrida anterior. El worker y el modo local reciben el mismo contrato.

`VigenciaElectrica` invalida consultas anteriores a una recarga con relanzamiento y bloquea su aplicación durante stop/análisis/start. El guard acompaña todas las fases asíncronas, incluidas alimentación, cámaras y parada por placa. Al terminar se solicita una lectura fresca. La revisión eléctrica es global porque una solución incluye todas las placas; es independiente de la generación que cancela una corrida completa.

Se usan VCC/AVCC del riel resuelto, tensiones respecto de GND local y alias del pad. La unión AVCC–5V está limitada al modelo de Arduino Uno, no a cualquier placa con ATmega328P. La transferencia ideal es `floor(1024·VIN/VREF)`, saturada a 0…1023 dentro del dominio de alimentación/entrada admitido. Se verifican referencias AVCC, AREF externa y bandgap nominal de 1,1 V, además de registros ADMUX/ADCL/ADCH mediante instrucciones AVR.

Una entrada flotante, circuito sin solución o referencia ausente no se convierte en cero ni conserva una muestra anterior como nueva. Produce un error de ADC y detiene la ejecución afectada por política del emulador. Esto **no afirma que el chip real se detenga**: el hardware puede dar una lectura indeterminada. Selecciones MUX reservadas, auto-trigger ADATE y temperatura sin calibración tampoco se presentan como resultados válidos. El perfil implementado admite conversiones individuales.

Límites: se mantiene el refresco DC agrupado de 50 ms y no hay reloj analógico compartido. No están modelados la impedancia de fuente y el capacitor sample-and-hold, INL/DNL, ruido, error/tolerancia de referencia, asentamiento, temperatura, aliasing ni sincronización exacta del instante de adquisición. Este adaptador es para Uno/avr8js; **no acredita ADC ESP32**.

## Térmica RC explícita

`sim/termica.ts` representa un cuerpo isotermo con ambiente fijo:

`Cθ·dT/dt = P − (T−Tamb)/Rθ`, con `τ=Rθ·Cθ`.

Resuelve exactamente cada intervalo suponiendo que la potencia es lineal entre muestras. Comprueba calentamiento, enfriamiento, rampas, equilibrio y estabilidad para pasos pequeños. Informa temperatura, energía disipada, cambio de energía almacenada y energía evacuada; el balance se obtiene de la misma ecuación y **no constituye una segunda medición independiente**.

La petición puede añadir `termica["r.r"]` con `id`, `fuente`, `condiciones`, `resistenciaKPorW`, `capacidadJPorK`, `ambienteC`, `inicialC` y `rangoDeclaradoC:[min,max]`. Los números deben proceder de un equivalente elegido explícitamente; no se incluyen valores térmicos universales para el catálogo. El estado inicial se refiere a la primera muestra de la traza.

Sólo se acepta potencia de R o contactos resistivos S en esta integración. La potencia de C/L representa intercambio energético y no se transforma automáticamente en calor. Se rechazan potencias negativas, no finitas y temperaturas fuera del dominio declarado. El resultado conserva `caracterizadoEnLaboratorio:false`, aunque el usuario escriba una referencia bibliográfica.

Es un acoplamiento de una sola dirección: las temperaturas no modifican R, diodos o reguladores, ni disparan una avería inventada. No representa varios cuerpos, convección/radiación explícita, PCB/encapsulado completo, PPTC ni runaway. TI documenta que las métricas térmicas dependen de las condiciones del montaje; un dato θJA no identifica por sí solo un modelo transitorio de una pieza en cualquier placa.

## Medición y evidencia de laboratorio

`evidencia/mediciones.ts` valida registros con identidad del modelo/solver/firmware/hardware/fixture, procedimiento, instrumento, dominio, unidades y condiciones. Exige incertidumbres estándar justificadas, correlación y una regla de decisión declarada previamente. Diferencia uso de ajuste y validación.

Para una diferencia escalar se calcula `uΔ²=uM²+uP²−2ρuMuP`. La regla explícita del caso usa `|Δ|±k·uΔ`: acepta si el intervalo queda dentro del límite, rechaza si queda fuera y devuelve indeterminado cuando se solapan. Datos incompletos, unidades incompatibles o fenómeno fuera de dominio impiden aceptar. El software no elige un límite universal ni asume que `k=2` implica una cobertura particular.

Desde `app/`, con Node 24:

```sh
node --import tsx server/src/evidencia/verificarMediciones.ts --sintetico
node --import tsx server/src/evidencia/verificarMediciones.ts medicion.json
```

La primera orden usa datos **inventados para probar el contrato**. La segunda evalúa datos declarados; no verifica autenticidad, calibración ni independencia por leer metadatos. Ambas mantienen `certificacion:false`. Salidas: 0 aceptado, 1 rechazado/indeterminado, 2 no evaluable/fuera de dominio. Una fecha anterior de la regla es una declaración comprobable en estructura, no evidencia de que realmente se decidió antes de medir.

No se realizaron mediciones físicas en esta entrega. Sigue pendiente el banco, las revisiones de piezas, los instrumentos y la campaña reservada descrita en el plan.

## Buses y RF pendientes

La detección de respuestas SPI incompatibles aborda contención digital en el bus funcional; no estima tensión/corriente de pelea entre drivers ni tiempos por bit. Una respuesta ausente no conduce; `0xFF` explícito sí conduce unos. Dos respuestas con bits opuestos producen `ErrorContencionSpi`: MicroPython recibe `OSError(5)` recuperable al liberar CS; AVR detiene su corrida y registra el diagnóstico. La ausencia de respuesta conserva el fallback funcional `0xFF`, no una tensión de pull-up verificada. I2C requiere comprobaciones de pull-up, corriente de hundimiento, capacitancia, umbrales y tiempo de subida; después arbitraje/stretching y un reloj común. UART interplaca también necesita esa coordinación. Un ACK funcional sigue sin certificar esas condiciones.

Para RF, el próximo contrato debe identificar transmisor/receptor, frecuencia, potencia, ganancias/polarización de antenas, pérdidas, geometría, ruido e interferencia y criterio de recepción. ITU-R P.525 describe atenuación de espacio libre; no representa por sí sola paredes, multitrayecto, campo cercano ni el RXB6/STX882 del catálogo. No se trasladará una sensibilidad del CC1101 a otro receptor por semejanza comercial. La RF actual conserva su alcance funcional.

## Fuentes primarias

Consultadas el 4 de octubre de 2026. Son referencias de ecuaciones/contratos; no resultados de medición del emulador.

- [ngspice manual](https://ngspice.sourceforge.io/docs/ngspice-manual.pdf): `.tran`, UIC y dispositivos. La edición consultada es 47+ de desarrollo; no identifica la versión del binario WASM de `eecircuit-engine`.
- [ATmega328P, Microchip](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf): ADC, referencias, conversión y dominios del MCU. Las limitaciones del adaptador se registran aparte de las especificaciones de la pieza.
- [TI SPRA953D](https://www.ti.com/lit/an/spra953d/spra953d.pdf) y [dinámica térmica de TI](https://www.ti.com/video/6243719539001): significado/condiciones de métricas térmicas y circuitos equivalentes.
- [JCGM 100:2008](https://www.bipm.org/documents/20126/2071204/JCGM_100_2008_E.pdf), [JCGM 106:2012](https://www.bipm.org/en/doi/10.59161/jcgm106-2012), [guías ILAC, G8](https://ilac.org/publications-and-resources/ilac-guidance-series/): incertidumbre, correlación y decisiones de conformidad. La regla del código está elegida explícitamente, no se presenta como certificación ILAC.
- [NXP UM10204](https://www.nxp.com/docs/en/user-guide/UM10204.pdf): requisitos I2C. [Microchip, SPI cliente](https://onlinedocs.microchip.com/oxy/GUID-4B32B28F-63FC-4320-842D-ECC5E5164A23-en-US-3/GUID-51EF51B0-5163-44CF-B266-0C27F50C715C.html): selección de cliente y MISO tri-state.
- [ITU-R P.525](https://www.itu.int/rec/R-REC-P.525/en) y [TI CC1101](https://www.ti.com/lit/ds/symlink/cc1101.pdf): separación entre propagación ideal y un receptor identificado. No son parámetros acreditados de los módulos RF del catálogo.

## Verificación de la entrega

Las pruebas están en `sim/transitorio.test.ts`, `sim/validacionTransitorio.test.ts`, `analisisTemporal.integration.test.ts`, `rutasAnalisisFisico.test.ts`, `sim/termica.test.ts`, `analogicoAvr.test.ts`, `analogicoDesdeCircuito.test.ts` y `evidencia/mediciones.test.ts`, además de regresiones de buses y DC. El registro de cierre y los totales de la suite completa se añaden al §12 del plan de fidelidad. La validación visual permanece pendiente y no reemplaza estas comprobaciones numéricas.
