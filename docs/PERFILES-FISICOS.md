# Perfiles físicos explícitos y verificables

Continuación del [plan de fidelidad](PLAN-FIDELIDAD-FISICA.md) y del
[análisis temporal](ANALISIS-TEMPORAL-Y-EVIDENCIA.md). Esta entrega amplía cuatro
contratos de simulación (con adaptadores ADC distintos para Uno y ESP32). No acredita equivalencia universal con hardware ni sustituye
una campaña de medición. Los perfiles y las pruebas son TypeScript; los adaptadores
conectan los modelos propios con avr8js, ngspice y el puente de MicroPython.

| Contrato | Aplicación real en el software | Dominio pendiente |
|---|---|---|
| ADC Uno RC | Conversión de firmware local/worker, carga retenida entre canales, ganancia/offset y ruido uniforme reproducible | Carga devuelta a la red, INL/DNL, deriva, referencia dinámica y reloj analógico común |
| ADC1 ESP32 MicroPython | `machine.ADC` consulta el voltaje del circuito mediante el puente UART y un perfil por GPIO/atenuación | SAR nativo de esp-emu, Arduino/ESPHome/IDF, ADC2, eFuse y calibración de silicio |
| I2C RC declarado | Bloquea transferencias si el equivalente configurado incumple niveles, corriente o tiempos comprobados | Extracción del equivalente del esquema, arbitraje, stretching, setup/hold y trazas de cada bit |
| Electrotérmica | R(T) cambia la red ngspice en cada etapa del integrador térmico | Firmware y transitorios eléctricos simultáneos, red térmica de montaje y averías |
| RF en espacio libre | El presupuesto decide si se permite inyectar una trama por MCP o WebSocket | Demodulación, BER/PER, interferencias, multitrayecto, antenas/partes caracterizadas |

Los modelos por placa se guardan dentro de `sim` en `project.json`. Se pueden guardar
mediante `PUT /api/projects/:name` conservando el resto de `sim`. Se cargan al iniciar
una corrida: después de cambiar un perfil, detener y volver a ejecutar. En una
recarga de código MicroPython se conserva la configuración de la corrida existente.
No se añadió una pantalla de calibración; no hay parámetros comerciales inferidos.

## ADC Uno: adquisición y errores configurables

`sim.analogicoAvr[boardId]` acepta el perfil histórico `ideal-10bits` o
`rc-no-ideal`. Ausente conserva la conversión ideal existente. En el segundo perfil,
la muestra retenida sigue:

```text
tau = (Rfuente + Rinterruptor) · C
Vhold_nuevo = Vin + (Vhold_anterior − Vin) · exp(−tadq/tau)
Q = clip(floor(1024 · Vhold/Vref · ganancia + offsetLSB + ruidoLSB), 0, 1023)
```

La impedancia se declara por canal; un valor ausente o `null` es desconocido, nunca
cero ohmios. La adquisición no puede superar la ventana del modelo MCU según su
prescaler. La tensión de entrada se congela al empezar la conversión: no hay
cosimulación de la carga del condensador sobre el circuito. Un reset reinicia la
carga y la semilla. Un error de dominio no consume ninguna de las dos.

Ejemplo **sintético** para una instancia Uno `board`; los valores no caracterizan
el ADC físico del ATmega328P:

```json
{
  "analogicoAvr": {
    "board": {
      "tipo": "rc-no-ideal",
      "id": "ejemplo-rc",
      "fuente": "Escenario sintético, sin mediciones de hardware",
      "condiciones": "Entrada constante durante adquisición",
      "rangoVEntrada": { "min": 0, "max": 5 },
      "capacitanciaF": 1e-9,
      "resistenciaInterruptorOhm": 0,
      "resistenciasFuenteOhm": { "0": 10000, "1": 10000 },
      "adquisicionS": 1e-5,
      "voltajeInicialV": 0,
      "ganancia": 1,
      "offsetLsb": 0,
      "ruido": { "tipo": "uniforme", "amplitudLsb": 1, "semilla": 1 }
    }
  }
}
```

El ruido es una perturbación uniforme sintética, no un espectro medido ni ruido
térmico gaussiano. La referencia interna permanece nominal. Referencias:
[Microchip ATmega328P, ADC](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf)
y [TI SPNA061, impedancia de fuente y adquisición](https://www.ti.com/lit/an/spna061/spna061.pdf).
No se trasladan parámetros del MCU descrito por TI al Uno.

## I2C: comprobaciones del equivalente declarado

`sim.i2cFisico[boardId]` contiene hasta cuatro entradas `{sda, scl, perfil}`. Los
pines corresponden al MCU (Uno: A4=18 y A5=19), no al número de patilla del sensor.
El perfil se asocia sólo al par de GPIO cableado y a esa placa. Un par sin perfil
conserva el bus funcional; si la placa tiene otros perfiles, se informa del par
sin modelo. SPI no recibe estos parámetros.

Cada línea declara tensión y resistencia de pull-up, capacitancia, resistencia del
conductor en LOW, fuga constante, límite de corriente de hundimiento y umbrales del
receptor. `resistenciaPullupOhm: null` significa que falta el pull-up. No se calculan
estos parámetros sumando automáticamente los módulos del dibujo.

Las ecuaciones del equivalente concentrado son:

```text
Vhigh = Vpullup − Rpullup · Ifuga
Vlow = Vhigh · Ron/(Rpullup + Ron)
Isink = (Vpullup − Vlow)/Rpullup − Ifuga
tau_subida = Rpullup · C
tau_bajada = (Rpullup || Ron) · C
```

Se calculan cruces de umbral exponenciales, se comprueban límites de subida
y bajada (incluidos sus mínimos por modo), capacitancia, y tiempos mínimos HIGH/LOW
de SCL después de descontar el cruce RC. También
se limita la frecuencia por modo y por chip alimentado. Los límites implementados
proceden de [NXP UM10204 rev.7, tabla 11 y §7.1](https://www.nxp.com/docs/en/user-guide/UM10204.pdf).
Sin fuga, el tiempo 30–70 % es `ln(7/3)·RC`.

Un fallo impide el ACK funcional. MicroPython recibe `OSError(5)` con la causa
eléctrica; AVR detiene la corrida con diagnóstico. Esta parada es una política del
emulador ante un resultado no acreditable, no una predicción de que el chip real
se detendría. Pasar el filtro es necesario para este perfil, pero **no certifica
cumplimiento completo de I2C**: faltan fases de datos, extensores, capacitancia
distribuida, múltiples controladores, stretching y protecciones no lineales.

Un ejemplo reproducible de los campos está en
[`perfilI2c.ts`](../app/server/src/fixtures/perfilI2c.ts). Está marcado como sintético
y los tests modifican sus parámetros para verificar ausencia de pull-up, subida
lenta, sobrecorriente, sobretensión y niveles lógicos inválidos.

## Otros contratos y fuentes

- [ADC1 de MicroPython](../app/server/src/analogicoEsp.md): esquema por canal, protocolo, alcance y fuentes.
- [Acoplamiento electrotérmico](electrotermica.md): ecuaciones, API, ejemplo y control de error.
- [Canal RF](../app/server/src/rf/README.md): Friis, unidades, dominio, umbral y fuentes primarias.

En WebSocket, `rf.send` admite `canalRf` con el mismo contrato del adaptador RF. Si
el modelo no permite recibir, no se llama a `sendRf` y se informa un evento `error`.
`rf.result` conserva el presupuesto y el modo también para entregas aceptadas.
Los mensajes antiguos sin modelo conservan la inyección funcional. Las herramientas
MCP además devuelven el presupuesto; `entregado` significa aceptación del puente,
no confirmación física de recepción.

## Evidencia y trabajo restante

Las pruebas contrastan fórmulas independientes, estados de registros AVR, transporte
UART de la plantilla, API Fastify y MCP, y casos que deben rechazarse. Las pruebas
sintéticas verifican implementación; no convierten un parámetro declarado en una
medición acreditada.

Siguen pendientes el reloj compartido entre firmware y analógica, las transacciones
eléctricas completas de buses, el SAR nativo ESP32, ruido/INL/DNL y calibración por
pieza, térmica de montaje y mecanismos de fallo/envejecimiento, propagación RF fuera
del dominio declarado y la campaña de laboratorio con incertidumbre. No es correcto
usar el resultado de esta entrega para afirmar que todo circuito se comportará
exactamente igual que el hardware real.
