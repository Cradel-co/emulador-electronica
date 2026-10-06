# Auditoría de fidelidad electrónica del emulador

Fecha: **4 de octubre de 2026**. Estado: **investigación y diagnóstico; las correcciones propuestas no están implementadas por este documento**.

Seguimiento: el [plan de fidelidad física](docs/PLAN-FIDELIDAD-FISICA.md) registra las leyes, condiciones de validez, correcciones posteriores y pruebas de implementación. Este archivo conserva el diagnóstico inicial y sus reproducciones; sus hallazgos describen la base auditada, no el estado posterior de cada corrección.

Base examinada: rama `feat/tanstack-router`, commit `9f5dcf2`, **incluyendo los cambios locales existentes**. Los números de línea se refieren a esa instantánea del directorio de trabajo, no exclusivamente al commit. Alcance: motor eléctrico, modelos de módulos y placas, firmware, buses, visualización, verificaciones y límites de uso. Se conservaron los cambios de interfaz previos.

## 1. Resultado principal

El proyecto tiene una base útil para **análisis DC de circuitos concentrados y pruebas funcionales de firmware con periféricos modelados**. Resuelve redes completas con ngspice, contempla fuentes limitadas, conducción de diodos, resistencia de salida de GPIO, protección e interacciones entre placas. Cuenta con comprobaciones contra fórmulas y un solver independiente.

Eso todavía **no equivale a reproducir un circuito físico en toda condición**. Hay fenómenos ausentes, parámetros genéricos y defectos de integración que pueden producir resultados engañosos incluso dentro del alcance DC. Los más urgentes son: entradas flotantes mal clasificadas, alias eléctricos de pines separados, diagnóstico de brownout inconsistente, límites incorrectos del Uno y uso de valores hipotéticos para representar LEDs en vivo.

La meta verificable debería ser: **cada resultado tiene un alcance, un modelo identificado, condiciones de validez y un nivel de evidencia; lo no modelado se declara expresamente y un fallo del motor nunca se convierte en una medida válida**. No corresponde prometer equivalencia universal con la vida real ni asignar un porcentaje de fidelidad sin un catálogo de casos de referencia y mediciones.

## 2. Método y niveles de evidencia

La investigación se hizo en ciclos de revisión:

1. Inventario del código, descriptores, documentación y pruebas.
2. Contraste con documentación oficial y hojas de datos localizadas mediante búsqueda web.
3. Revisión adversarial: buscar casos que las pruebas existentes no cubren.
4. Reproducciones pequeñas de defectos y ejecución de suites existentes con un solo worker.
5. Reconciliación entre agentes y elaboración de un plan de validación independiente.

Los agentes revisaron el motor y los modelos de hardware; el agente principal revisó la integración firmware/buses/UI y las fuentes externas. Se limitaron los procesos de prueba para cuidar los recursos del equipo. No se recompilaron imágenes Docker ni se reinició deliberadamente el servidor de desarrollo.

| Etiqueta | Significado |
|---|---|
| Implementado | Hay un mecanismo concreto en el motor activo; no implica exactitud de todos los parámetros. |
| Aproximado | Se usa un equivalente, valor típico o simplificación cuyo dominio debe explicitarse. |
| Ausente | No se encontró representación del fenómeno en el camino activo examinado. |
| Reproducido | Se ejecutó un caso y se obtuvo el resultado registrado. |
| Confirmado por lectura | El mecanismo o discrepancia es observable directamente en código/datos; puede faltar prueba ejecutada del circuito. |
| Pendiente de validación | Hipótesis o requisito que necesita experimento, modelo específico o medición física. |

**Separaciones esenciales:** resolver ecuaciones correctamente no valida los parámetros; detectar sobrecarga no simula la avería; pasar pruebas funcionales de una librería no valida eléctricamente el bus; ruido sintético de un sensor no equivale a ruido del circuito.

## 3. Qué motor ejecuta realmente la aplicación

Camino activo:

```text
diagrama + catálogo + GPIO + controles
  → sim/analisis.ts: redes y estado de cada placa
  → sim/modelos.ts y model.js: primitivas por módulo
  → sim/placa.ts: alimentación y GPIO
  → sim/netlist.ts: netlist con .op
  → sim/spice.ts: ngspice WASM, cola serial
  → medidas, avisos, entradas y observaciones
  → index.ts: firmware, API y eventos
  → web/app.ts: representación visible
```

`solver.ts` y `circuitNetwork.ts` son una verificación separada, no el motor que determina normalmente las medidas de la aplicación. `circuitEngine.ts:10–17` lo declara. El flag antiguo `EMU_FREE_CIRCUIT` no selecciona el motor activo del servidor.

`sim/netlist.ts:220–236` genera **`.op`**, no `.tran`, `.ac` ni `.noise`. El manual distingue estos análisis; los resultados de un punto de operación no representan una evolución temporal. [Manual oficial de ngspice](https://ngspice.sourceforge.io/docs/ngspice-manual.pdf).

Primitivas expuestas por `app/shared/src/modelo.ts:133–148`: R, C, L, D, V, I, S, SV y REG. La API pública de módulos no expone directamente BJT, MOSFET, amplificadores operacionales, líneas de transmisión o inductores acoplados. Que ngspice disponga de esos dispositivos no significa que el catálogo y el SDK actual los modelen.

## 4. Matriz de leyes y fenómenos

Las expresiones siguientes son criterios de ingeniería para revisar el modelo, no una afirmación de que todas estén simuladas.

| Ley o fenómeno | Estado en el camino activo | Evidencia / límite / verificación requerida |
|---|---|---|
| Ohm: V = I·R | Implementado para R lineal | Netlist R; pruebas de divisor, serie, paralelo y redes aleatorias. R no depende de temperatura ni tolerancia. |
| Kirchhoff de corrientes | Implementado en la red modelada | Resolución nodal; `sim/motor.test.ts:40–59` comprueba residuos. Falta un control equivalente obligatorio en producción. |
| Kirchhoff de tensiones | Implementado en circuitos concentrados | Una tensión por nodo y diferencias entre terminales; pruebas de mallas. No cubre inducción distribuida ni líneas largas. |
| Potencia eléctrica: P = V·I | Implementado | `Netlist.resolver` conserva el signo pasivo. Verificar fuentes, elementos internos y referencias flotantes. |
| Joule: P = I²R = V²/R | Implementado como potencia instantánea DC | No hay integración térmica, temperatura de cuerpo ni daño por tiempo. |
| Balance energético DC | Comprobado por pruebas | Las potencias de los elementos reportados cierran con tolerancia. No es un cálculo de calor, luz, trabajo mecánico o energía almacenada transitoria. |
| Serie y paralelo | Implementado | Red completa, no suma de caminos aislados. Añadir casos de alias, islas y datos mal formados. |
| Thévenin / Norton | Parcial | Fuente más resistencia y fuentes de corriente; falta comprobar equivalencias bajo distintas cargas y distinguir regularización de resistencia física. |
| Superposición | Implementado en subconjuntos lineales | No aplicarla al LED, a CC, al regulador en dropout o a interruptores no lineales. |
| Millman / puentes resistivos | Implementado | Suites físicas existentes; completar fuentes que absorben/entregan y casos de alto rango dinámico. |
| Shockley para diodos | Aproximado | LED con IS, N, RS y BV; ajuste a Vf nominal, no extracción de curvas completas del componente concreto. |
| Polaridad del diodo | Implementado | Se distingue directa e inversa. Es una mejora real respecto de modelos sin polaridad. |
| Ruptura inversa | Aproximado | BV genérico del LED; la hoja concreta puede especificar otra condición o no permitir uso en inversa. |
| Capacitancia: i = C·dv/dt | Ausente en la ejecución temporal del circuito | C se declara pero `.op` la ve abierta en régimen estacionario. No carga, descarga ni retención física de tensión. |
| Inductancia: v = L·di/dt | Ausente en la ejecución temporal del circuito | L se declara pero `.op` representa su condición DC ideal; no contrafuerza ni desmagnetización. |
| Energía: EC = C·V²/2; EL = L·I²/2 | Ausente como estado dinámico | `estado` de módulos no es un integrador de carga/flujo con reloj físico. |
| RC / RL / RLC, resonancia y amortiguamiento | Ausente en el circuito activo | No respuestas al escalón, constantes de tiempo ni oscilaciones analógicas. |
| Impedancia y fase AC | Ausente | Sin barrido `.ac`, fasores, reactancia o respuesta en frecuencia del circuito. |
| PWM y valor medio/RMS | No validado eléctricamente | Llegan niveles muestreados, no forma de onda ni integración de energía por ciclo. No usar Vmedio para inferir I²R. |
| Rebote de contactos | Ausente | S cambia de estado sin un tren temporal de rebotes ni resistencia variable. |
| Flyback de bobinas | Ausente como fenómeno temporal | El relé tiene diodo en el modelo, pero su bobina es R y no existe transitorio de corte. |
| Contención de GPIO push-pull | Parcial DC | Resistencias de salida pueden producir corriente; faltan validación por pad, propagación y daño acumulado. |
| GPIO open-drain / alta impedancia | Incompleto | Los scanners convierten OPEN_DRAIN a salida genérica; la red no distingue soltar el pin de conducir alto. |
| Pull-up / pull-down internos | Aproximado | 45 kΩ generalizados; no se reciben todos los cambios de modo en runtime. |
| Umbrales VIL / VIH | Parcial | Factores por placa respecto de VDD resuelto, franja indefinida; clasificación de flotantes defectuosa. |
| Histéresis Schmitt | No acreditada como modelo de pad | Retener la última lectura en la franja VIL–VIH es una política de software, no una curva Schmitt medida. |
| Metastabilidad y sincronización | Ausente | No resolución de estados metaestables, ventanas de setup/hold o probabilidad de fallo. |
| ADC desde el nodo eléctrico | Ausente en la integración examinada | AVRADC existe, pero no se enlaza su entrada analógica al solver; el puente MicroPython no reemplaza ADC. |
| DAC / salida analógica | Ausente en el SDK eléctrico actual | No contrato de tensión analógica variable desde firmware al circuito. |
| CV / CC de fuente | Aproximado con pruebas | Equivalente no lineal con recorte; no dinámica del lazo, overshoot ni protección real. |
| Dropout de regulador lineal | Aproximado | `min(Vnom, Vin−caida)` y límite fijo; faltan curvas según carga/temperatura y número de parte. |
| Consumo del microcontrolador | Aproximado | Valor típico y rampa en baja tensión; no perfil por instrucción, RF, sleep, arranque o periféricos. |
| Brownout / reset | Parcial y con defecto reproducido | Dos pasadas eléctricas pueden producir estado inconsistente; sin histéresis ni secuencia temporal de reinicios. |
| Diodos de protección / inyección | Parcial DC | Diodos genéricos en GPIO cableados; aviso por corriente. No modela latch-up ni daño de la estructura interna. |
| Alimentación fantasma | Parcial | Puede aparecer por conducción de protección; falta certificar secuencias y límites por chip. |
| Selección USB / VIN / reguladores | Aproximado | Red genérica por placa; no esquemático exacto de selección y todos sus componentes. |
| Polifusible USB | Sustituto DC | Límite 500 mA y bloqueo, no PPTC térmico dependiente del tiempo. |
| Corriente total por puerto/chip | Ausente como control completo | Avisos por GPIO, sin todas las agrupaciones especificadas por el fabricante. |
| Tolerancias y dispersión | Ausente en R/placas de forma general | No corners, Monte Carlo ni distribuciones del catálogo eléctrico. Algunos chips sí usan semilla. |
| Ruido eléctrico Johnson / shot / 1/f | Ausente en la red activa | Hay ruido sintético de BME280/MPU6050, que es otra capa y sí debe reconocerse. |
| Temperatura / derating / envejecimiento | Incompleto | Entorno de sensores y ciertos parámetros del RTC no constituyen un modelo térmico del circuito. |
| Cables y contactos reales | Mayormente ideales | Cables unidos por union-find sin longitud, sección, R/L/C ni corrosión. S sí posee Ron/Roff. |
| Tierra y retorno | Parcial DC | Referencia por isla/placa y unión de cables; sin ground bounce, impedancia de retorno o acoplamiento. |
| Batería | Equivalente de fuente | Sin estado de carga, química, resistencia interna variable, recuperación, cargador o protección electroquímica. |
| I2C lógico | Implementado parcialmente | Dirección, ACK/NACK, bytes, ocupación, conflicto y comportamiento de chips. No equivale a validación analógica de SDA/SCL. |
| I2C eléctrico / timing de flancos | Ausente o desconectado del camino de bytes | Sin Cbus/trise, impedancia de pull-up ni validación completa de clock stretching/arbitraje físico. |
| SPI lógico | Implementado parcialmente | CS, modo, orden, frecuencia y registros. Múltiples respuestas se combinan lógicamente, sin modelo eléctrico completo de contención MISO. |
| UART y comunicación entre placas por cable | No acreditada universalmente | UART de consola/puente existe; no demuestra TX/RX interplaca con voltajes, baud mismatch y cableado arbitrario. |
| RF 433 MHz | Funcional / parcial por backend | Inyección y tramas; no canal electromagnético con distancia, antena, obstáculos, interferencia y sensibilidad. MicroPython y AVR tienen límites explícitos. |
| Maxwell, EMI, propagación y líneas de transmisión | Ausente | No solver de campos ni modelo distribuido. El dibujo espacial no convierte la geometría en una magnitud eléctrica. |
| Aislamiento, arcos y distancias de seguridad | Ausente | No es validación de redes de potencia, aislamiento o seguridad de montaje. |

## 5. Contraste con fuentes primarias

### 5.1 Parámetros de placas

Arduino publica **50 mA máximos para el pin de 3,3 V del Uno R3** y 20 mA por I/O en su pinout. El modelo `sim/placa.ts:81` aplica 600 mA al LDO de 3,3 V de todas las placas; esa discrepancia no es tolerancia numérica. [Pinout oficial Uno R3](https://content.arduino.cc/assets/Pinout-UNOrev3_latest.pdf).

El documento de ATmega328P separa máximos absolutos, condiciones de operación y restricciones acumuladas de puertos. No debe confundirse el valor absoluto de 40 mA por pin con una corriente recomendada de operación; falta validar las sumas por grupos y alimentación. La variante y revisión deben corresponder al chip montado en la placa. [Documentación oficial Microchip](https://www.microchip.com/en-us/product/ATMEGA328P?tab=documents), [hoja ATmega328/P publicada por Arduino](https://docs.arduino.cc/resources/datasheets/Atmel-42735-8-bit-AVR-Microcontroller-ATmega328-328P_Datasheet.pdf).

En ESP32-S3, tabla 5-4, las corrientes **40 mA source y 28 mA sink aparecen como típicas bajo condiciones de PAD_DRIVER y tensión concretas**, no como un único umbral universal de rotura. La tabla también especifica VIL/VIH, pulls típicos y límites de tensión. Un resistor simétrico de 33 Ω no reproduce automáticamente esas dos curvas ni las distintas fuerzas de drive. [Hoja oficial ESP32-S3, §5.4](https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf).

Los C3 y C6 requieren su propia revisión de características y esquemático de DevKit; no basta heredar del S3 por compartir 3,3 V. [Hoja oficial C3](https://documentation.espressif.com/esp32-c3_datasheet_en.html), [hoja oficial C6](https://www.espressif.com/sites/default/files/documentation/esp32-c6_datasheet_en.pdf).

### 5.2 Componentes y buses

El manual I2C relaciona tiempo de subida, pull-up y capacitancia mediante `tr = 0,8473·Rp·Cb`; limita condiciones eléctricas y temporales. La capa de bytes actual no calcula esa respuesta. [NXP UM10204, §7.1](https://cache.nxp.com/docs/en/user-guide/UM10204.pdf).

Un PPTC responde con curvas tiempo/corriente y dependencia térmica. Reemplazarlo por una fuente limitada permite estudiar corriente DC, pero no tiempo de disparo o recuperación. [Littelfuse, PPTC](https://www.littelfuse.com/products/fuses-overcurrent-protection/polyswitch-resettable-pptc-devices).

La desconexión de una carga inductiva requiere disipar energía almacenada y puede generar sobretensión; el diodo altera la desmagnetización. El circuito actual del relé no reproduce ese evento. [TI, cargas inductivas](https://www.ti.com/document-viewer/lit/html/SNVAA45).

Los límites de un LED dependen del número de parte y condiciones. Como contraejemplo de la regla genérica BV=5 V, la hoja VLWR9632 establece otros límites de corriente e inversa, con condiciones térmicas propias. Eso demuestra la necesidad de modelos por componente, no que ese LED esté soportado actualmente. [Vishay VLWR9632](https://www.vishay.com/docs/81818/vlwr9632.pdf).

La potencia admisible de una resistencia depende de disipación, temperatura y sobrecarga/pulsos. La regla local de 0,25 W/0,5 W es una política simplificada. [Vishay, fundamentos de resistencias](https://www.vishay.com/docs/28771/basics.pdf).

Un LDO requiere caracterizar dropout según carga y temperatura, corriente límite y disipación. El modelo genérico no representa el comportamiento completo del componente. El TPS715 es aquí una referencia del fenómeno, **no una identificación del regulador de los DevKit**. [TI TPS715](https://www.ti.com/lit/ds/symlink/tps715.pdf).

Los umbrales de niveles garantizados y la histéresis son conceptos diferentes; tampoco los flancos lentos son inocuos. [TI, Schmitt triggers](https://www.ti.com/document-viewer/lit/html/scea046).

El muestreo ADC exige considerar adquisición e impedancia de fuente. Aunque se conecte un valor de tensión al ADC virtual, aún faltará caracterizar esas limitaciones. [TI, impedancia de fuente ADC](https://www.ti.com/lit/an/spna061/spna061.pdf).

Los comportamientos de BME280, MPU6050 y DS3231 deben contrastarse por registros, modos y tiempos con las hojas, no solo con lo que devuelve una librería. [Bosch BME280](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bme280-ds002.pdf), [TDK MPU6000/6050](https://invensense.tdk.com/wp-content/uploads/2015/02/MPU-6000-Datasheet.pdf), [Analog Devices DS3231](https://www.analog.com/media/en/technical-documentation/data-sheets/ds3231.pdf).

## 6. Defectos y discrepancias prioritarias

P0: puede presentar una condición inválida como resultado físico válido. P1: sesgo importante en circuitos comunes. P2: ampliar alcance y modelos. No son niveles de riesgo de una instalación física.

### F01 — Brownout puede ocultar un corto de GPIO — P0, reproducido

Código: `sim/analisis.ts:338–347,396–404`, `sim/placa.ts:94–104`.

Caso: ESP32-S3, USB apagado, fuente de 3,3 V limitada a 130 mA al pin 3V3, masa común, GPIO7 configurado como salida alta y unido directamente a GND. En la primera pasada la carga hace caer el riel; en la segunda se retira el driver GPIO. El riel se recupera, pero no se reevalúa consistentemente el estado de encendido.

Resultado obtenido:

```json
{"chipEncendido":false,"alimentacion":{"estado":"ok","v":3.306957437379914},"avisos":[],"gpio":[]}
```

La fuente terminó en CV y el corto no apareció en los avisos finales. No demuestra un brownout temporal real: demuestra inconsistencia de la instantánea modelada. Corrección propuesta: estado explícito por placa, iteración/fijación consistente o transición temporal con detección de oscilación; conservar diagnóstico del intento fallido y no inferir `ok` solo del riel recuperado sin carga.

### F02 — Una entrada con C o R suelta se declara no flotante — P0, reproducido

Código: `sim/analisis.ts:425–428`. Se comprueba si hay un elemento incidente, no si existe un camino DC válido que fije tensión.

| Circuito | Resultado ejecutado |
|---|---|
| GPIO6 entrada sin pull, capacitor 1 µF a GND | `v=1,10006799 V`, `nivel=null`, `flotante=false`, sin aviso. |
| GPIO6 entrada sin pull, R=1 kΩ hacia un extremo sin conexión | `v=0,82505099 V`, `nivel=0`, `flotante=false`, sin aviso. |

En DC un capacitor no fija la tensión de una entrada; una resistencia hacia otro nodo flotante tampoco. Esas tensiones dependen del modelo numérico de fugas/protección. Corrección: análisis de conectividad conductiva/referencia e impedancia efectiva, considerando estado de diodos/interruptores, fuentes y el modo de análisis; separar regularización matemática de determinación física.

### F03 — Valores ausentes se convierten en ceros medidos — P0, reproducido a nivel de adaptador

Código: `sim/netlist.ts:245–258`, `sim/analisis.ts:332`, `sim/spice.ts:63–72`.

Se llamó `Netlist.resolver` con un mapa de resultados vacío y errores fatales: devolvió una resistencia de 1 kΩ con 0 V, 0 A y 0 W. La función usa `?? 0` para vectores no presentes. **Esta reproducción no demuestra que ngspice entregue ese mapa en una ejecución real**; confirma que el adaptador confunde ausencia con cero. El wrapper rechaza mapas totalmente vacíos, pero no garantiza todos los vectores esperados, finitud ni clasificación de errores con resultados parciales.

Corrección: contrato de resultado válido/inválido, vectores completos y finitos, diagnóstico de errores y validación de residuos. Solo el nodo de referencia debe convertirse deliberadamente en 0 V. Una lectura desconocida debe conservar `unknown`, nunca `0`.

### F04 — Alias de un mismo GPIO no forman el mismo nodo — P0, reproducido

Código: `sim/analisis.ts:149–163,221–223`; Uno `module.json`: A4/SDA→GPIO18 y A5/SCL→GPIO19. Se unen rails por nombres, pero los alias GPIO pueden permanecer en redes separadas. `Map<number,string>` sobrescribe el nodo anterior al incluir el segundo alias.

Reproducción ejecutada: Uno alimentado por USB, A4→R1 de 1 kΩ→GND y SDA→R2 de 1 kΩ→GND, GPIO18 como salida alta. A4 quedó a **0 V** y SDA a **4,87822481 V**; R1 condujo 0 A y R2 4,878 mA, sin avisos. Al invertir únicamente el orden de los dos cables, las tensiones y corrientes se intercambiaron. Ambos terminales físicos deben compartir tensión y alimentar ambas cargas. Script `/tmp/audit-electrico/alias.ts`, log `/tmp/audit-alias-result.log`.

Consecuencia demostrada: dos terminales físicamente iguales obtienen tensiones distintas y uno pierde el driver/protección. Debe normalizarse cada terminal mediante un identificador de pad físico **antes** del union-find. No sirve corregir solamente el nombre visible. Prueba requerida: cargas simultáneas en A4 y SDA, distintas secuencias de inserción y cortos entre alias.

### F05 — Uno 3V3 admite demasiado en el modelo — P1, confirmado por código y fabricante

El LDO genérico permite 600 mA frente a 50 mA publicados para Uno R3. Añadir al descriptor el regulador exacto o, como mínimo, límites específicos del riel. Reproducción requerida: barrido de carga 1–100 mA desde 3V3 con fuente válida, comparar caída y avisos; luego medir hardware sin exceder límites recomendados.

### F06 — Open-drain se interpreta como push-pull — P1, confirmado por lectura

`pinScan.ts:202–207,215–220` convierte OPEN_DRAIN en `{salida:true}`. `sim/placa.ts` conecta nivel 1 al riel mediante R. Un open-drain alto debería liberar el pad, no alimentar la red. Impacta buses, adaptación de niveles y líneas compartidas.

Corrección: modo eléctrico del pad separado del nivel lógico: input, push-pull, open-drain, high-Z, analog; nivel, fuerza de drive y pulls como estado runtime. Pruebas: dos open-drain, falta de pull-up, pull-up a otra tensión y corto/contención.

### F07 — El código fuente decide el modo del pin mediante heurísticas — P1, confirmado por lectura

`index.ts:1177–1190` combina el scanner de todos los archivos; no representa orden real de ejecución. `Pin.init`, modos pasados por variables, condiciones, librerías y cambios de DDR no se trasladan de forma completa al modelo eléctrico. `pinScan.ts` elimina comentarios con regex aproximadas y puede no reconocer llamadas válidas.

El scanner puede servir para diagnóstico previo; el runtime debe informar el estado del pad. En AVR se conoce DDR/PORT pero el mensaje `onPin` solo publica 0/1. En ESP32 se observa GPIO_OUT y se sustituyen APIs, no todos los periféricos que manejan el pad.

### F08 — PWM y pulsos pueden desaparecer por muestreo — P1, confirmado por lectura

`avrSim.ts:314–328` informa el nivel al final del tramo; `RelojAvr` usa tramos hasta 10 ms. `index.ts:1270–1303` agrupa el sensado a 50 ms. El puente MicroPython sondea salidas cada 20 ms (`templates/micropythonBridge.ts:543–558`).

Un pulso que aparece y desaparece entre muestras puede no producir un evento eléctrico. No existe garantía de reconstrucción de duty cycle, fase, energía o interrupciones interplaca. El tiempo de CPU AVR sí puede ser correcto internamente y aun así la red externa perder flancos. No asignar una “frecuencia máxima confiable” universal sin pruebas por ruta.

Corrección: eventos eléctricos con tiempo simulado, captura de cambios de estado/mode, y reducción exclusivamente de renderizado. PWM promedio puede ser un modo simplificado explícito, nunca sustituto universal del transitorio.

### F09 — La visualización de LEDs mezcla escenarios hipotéticos — P1, confirmado por lectura

`index.ts:1390–1402` resuelve vivo, salidas todas altas y salidas todas bajas. Devuelve `leds` basados en el escenario alto, con `mAFijo` del bajo. `web/app.ts:1402–1410` mezcla nivel lógico, corrientes y `ui.on`; `revisarQuemaduras:1426–1434` usa el veredicto hipotético.

“Todas altas” no es peor caso universal: una carga activa en bajo demanda más con salida baja; una carga diferencial entre dos GPIO puede encenderse con estados opuestos, no con todas iguales. La quemadura queda en un Map de la UI y no necesariamente altera la red del server.

Corrección: separar `live`, `designChecks` y `faultState`; brillo y daño deben derivarse del mismo estado físico autoritativo que las medidas. Una avería debe cambiar la topología/modelo si se pretende simular sus consecuencias.

### F10 — Estados de chips no siguen necesariamente su alimentación durante la corrida — P1, confirmado por lectura

`index.ts:1149` pasa alimentación al construir chips. `BusChips` conserva `alimentado` y no expone una transición continua de energía desde el solver. No se encontró actualización de ese flag ante caída exclusiva de VCC de un sensor mientras el MCU sigue alimentado.

Reproducción pendiente: abrir alimentación de BME280 con el micro aún activo y comprobar ACK/NACK y registros. Corrección: estado de suministro por dispositivo, power-on/reset/brownout con tiempos, persistencia no volátil y comportamiento sin energía.

### F11 — Respuesta I2C/SPI puede ser válida aunque la línea sea eléctricamente inválida — P1, confirmado por lectura

La capa de bytes enruta por cableado/pines y alimentación. No hace que cada bit dependa del voltaje calculado en SDA/SCL/MISO. `BusChips.velocidad` avisa si supera el máximo, pero el aviso por sí solo no introduce errores de comunicación. La combinación AND de respuestas representa colector abierto I2C, pero no la contención de salidas push-pull SPI.

Añadir modo de buses con validación eléctrica, umbrales, pull-ups, carga, timing y estados desconocidos. Mantener un modo funcional rápido claramente identificado para probar registros/librerías.

### F12 — Parámetros típicos tratados como límites universales — P1, confirmado por lectura

GPIO simétrico, 45 kΩ de pull, diodos genéricos, brownout=0,8·Vlogic, USB=500 mA, LED BV=5 V y quemadura=60 mA son simplificaciones. No hay procedencia individual por parámetro, temperatura o revisión del hardware. Deben distinguirse nominal, mínimo/máximo garantizado, recomendado, máximo absoluto y umbral pedagógico.

### F13 — Daño instantáneo y advertencias no son física de avería — P1, confirmado por lectura

Placa quemada: `index.ts:1205–1210,1317–1320` registra en memoria; un reinicio de server la “repara”. Resistor: el modelo solo informa potencia. LED: fallo visible recordado por cliente. No hay cálculo de temperatura/tiempo, envejecimiento ni elección físico-estadística abierto/corto/degradado.

El máximo absoluto tampoco predice que un componente se destruya exactamente al cruzarlo. Debe advertirse una violación de especificación y reservar una simulación de daño para modelos expresamente definidos y validados.

### F14 — Fallo de modelo puede volver el circuito más benigno — P1, confirmado por lectura

`sim/modelos.ts:35–41` ofrece fallback por flags cuando falla el código del módulo. Algunos módulos activos sin modelo terminan con cero elementos. El aviso es útil, pero seguir mostrando medidas sin marcar que se omitió una carga puede crear una falsa impresión de normalidad.

Corrección: nivel de fidelidad degradado en todo resultado afectado; no dar un veredicto de “sin problemas” si faltan modelos relevantes. Identificar los elementos omitidos y la razón.

### F15 — Timeout del motor no garantiza interrumpir cómputo bloqueante — P1, pendiente de prueba adversarial

`sim/spice.ts:54–60` usa `Promise.race` y descarta la instancia. Si el trabajo bloquea el mismo event loop, el timer no puede interrumpirlo; si sigue ejecutándose en otra tarea, tampoco hay cancelación explícita visible. Depende de cómo corre WASM la versión instalada. No se provocó un bloqueo deliberado del equipo.

Verificar aislamiento y cancelación reales. Para un plazo duro, ejecutar solver en worker/proceso supervisado y terminar/recrear el worker al vencer. Añadir topes de nodos/elementos/cola/memoria y métricas antes de aumentar resolución temporal.

## 7. Firmware, tiempo y varias placas

### AVR

`avrSim.ts` ejecuta instrucciones y periféricos de avr8js, USART, timers, watchdog, EEPROM, ADC, TWI y SPI. Las pruebas con HEX precompilados son evidencia funcional relevante. ADC instanciado no implica señal analógica conectada; el código no conserva una referencia al ADC para alimentar sus canales con tensiones del circuito.

`conectarI2c` agenda transferencias con periodos del reloj; `conectarSpi` usa ciclos de transferencia. Esa temporalidad local del bus es distinta de los 50 ms usados por el solver externo. La CPU puede ir más lenta que reloj de pared; el coordinador informa velocidad y resigna tiempo cuando acumula demasiado atraso.

### ESP32 / MicroPython / ESPHome

El puente MicroPython reemplaza Pin/I2C/SPI. La lectura de entradas manejadas por la app viene de `_input_levels`, y las IRQ se programan por software. No equivale a inyectar fielmente todos los periféricos al pad del SoC. El mensaje RF no está implementado en esa plantilla; AVR también declara RF pendiente. ESPHome tiene una ruta de RF/RMT específica, que no debe generalizarse a todos los backends.

`pin.in` por WebSocket y `ponerPin` por MCP pueden inyectar directamente una lectura al firmware (`index.ts:1555–1561,1640–1643`) sin atravesar el circuito. Es una herramienta de prueba válida si se etiqueta como **inyección**, no una medición física del nodo.

### Varias placas

El motor recibe niveles/direcciones por boardId y tiene tres pruebas específicas en `sim/multiplaca.test.ts`: alto/bajo interplaca, independencia y medida respecto de la propia tierra. Buen punto de partida, insuficiente para certificar comunicaciones rápidas, fuentes compartidas, reinicios independientes o contención.

`revisarAlimentacion` puede parar todas las corridas si una placa falla; la vida real no apaga automáticamente otra placa independiente. Se necesita decidir si es política de seguridad del entorno o un comportamiento físico, y documentar esa separación. Los emuladores no comparten un reloj determinista de co-simulación con el motor eléctrico.

## 8. Qué ya está bien y conviene preservar

1. Una red global evita errores estructurales de resolver cada módulo aisladamente.
2. La ley de Ohm se implementa en primitivas y se compara con fórmulas.
3. Las pruebas suman corrientes/potencias con signos y tolerancias explícitas.
4. Diodos polarizados y fuentes limitadas mejoran mucho el alcance DC.
5. Se separan cálculo eléctrico, comportamiento de chip y UI.
6. La alimentación de varias placas usa referencias locales y datos por boardId.
7. El catálogo admite modelos de módulos reutilizables mediante un SDK propio.
8. BME280 tiene compensación, ruido, filtros y tiempos; MPU6050 tiene escalas, ruido, errores y DLPF; DS3231 incluye tiempo, alarmas, ppm y aging. No son simples sensores que devuelven siempre un número perfecto.
9. Tests ejecutan firmware/librerías AVR precompiladas sin exigir recompilación Docker.
10. La documentación existente reconoce parte de los límites; hay que actualizar afirmaciones demasiado fuertes y no perder ese esfuerzo.

## 9. Plan de verificación por casos independientes

Cada caso debe registrar esquema/netlist, referencias de fabricante, condiciones, valores esperados, tolerancia, estado del motor y resultado. El resultado esperado no se obtiene copiando la salida del mismo modelo.

| ID | Caso / regla | Oráculo y aceptación propuestos |
|---|---|---|
| V01 | Resistencias en serie y paralelo | Fórmula analítica y residuos KCL/KVL. |
| V02 | Divisores cargados y sin carga | Thévenin calculado a mano, no divisor ideal si hay carga. |
| V03 | Wheatstone balanceado/desbalanceado | Sistema lineal independiente. |
| V04 | Fuentes positivas/negativas en serie | Signos y tensiones relativas, potencia consistente. |
| V05 | Fuentes desiguales en paralelo | Corriente por cada resistencia interna; distinguir capacidad de absorción. |
| V06 | Corto, circuito abierto, elementos de gran/small R | Regularización y límites físicos separados. |
| V07 | Islas flotantes y tierras distintas | Solo diferencias internas físicas; no inventar una tierra común. |
| V08 | Alias A4/SDA y A5/SCL | Misma tensión y nodo independientemente del orden. |
| V09 | Entrada sola, C a GND, R a extremo suelto | `unknown/flotante`, no cero válido. |
| V10 | Pulls y divisor de alta impedancia | Impedancia efectiva y sensibilidad a fugas; VIL/VIH. |
| V11 | GPIO source/sink | Curvas I/V del pad y drive concreto, por placa. |
| V12 | Corriente por puerto y total MCU | Agrupaciones y condiciones de la hoja específica. |
| V13 | Push-pull enfrentados | Corrientes, caída, advertencia; ningún vencedor lógico arbitrario. |
| V14 | Open-drain con/sin pull y dos emisores | Alto=Z; low dominante solo cuando corresponde. |
| V15 | Sobretensión/inyección, chip apagado | Corriente de clamps y back-power con modelo específico. |
| V16 | Tensión en franja indefinida | Estado desconocido explícito; no presentarlo como garantía Schmitt. |
| V17 | Fuente CV/CC y transición | Curva barrida con referencia SPICE externa y fuente física. |
| V18 | Dos fuentes limitadas compartiendo carga | Reparto de corriente y energía por fuente. |
| V19 | Fuente apagada retroalimentada | Característica explícita, no imposición universal de 0 V. |
| V20 | LDO dropout y quiescente | Hoja del número de parte y temperatura elegida. |
| V21 | Uno 3V3 a cargas crecientes | Límite de riel correcto; no transferir modelo ESP32. |
| V22 | VIN alto con consumo | Potencia/temperatura del regulador; no asegurar 1 A a cualquier Vin. |
| V23 | USB más fuente externa | Esquemático exacto de selección y bloqueo. |
| V24 | Brownout con corto GPIO | Estado consistente, conservar causa, detectar oscilación de arranque. |
| V25 | MCU que cambia input/output en runtime | Red sigue DDR/Pin.init real y no scanner estático. |
| V26 | LED directo/inverso y varios colores | Curva concreta y tolerancias; brillo basado en corriente viva. |
| V27 | LED entre dos GPIO y activo bajo | No usar todas-altas como peor caso universal. |
| V28 | Daño y reemplazo de LED/placa/R | Misma topología y estado en cliente, server y vista compartida. |
| V29 | RC al escalón, carga inicial | `V(t)=Vfinal+(V0−Vfinal)e^(−t/RC)` cuando se implemente transitorio. |
| V30 | RL corte con/sin flyback | Corriente continua en L y energía disipada con límites del modelo. |
| V31 | RLC oscilatorio | Frecuencia/amortiguamiento analíticos, paso y error numérico. |
| V32 | PWM al 10/50/90 %, varias fases | Captura de cada transición y energía, no nivel al cierre de tramo. |
| V33 | Pulso entre dos muestras UI | Firmware receptor lo observa aun si UI no repinta cada flanco. |
| V34 | Rebote determinista de contacto | Secuencia temporal reproducible y debounce de firmware. |
| V35 | ADC divisor / referencias / saturación | Nodo→canal→cuenta; referencia/resolución por chip. |
| V36 | ADC impedancia alta / multiplexado | Adquisición y settling según modelo seleccionado. |
| V37 | I2C sin pull, cortos y Cbus elevada | Resultado inválido/NACK o fallo explicitado, según modo/modelo. |
| V38 | I2C direcciones repetidas | AND de colector abierto, ACK y diagnóstico consistente. |
| V39 | I2C clock stretching / multi-master | Especificación NXP y pruebas de eventos, si se afirma soporte. |
| V40 | SPI modo/CS/MISO compartido | Setup/hold y contención, no AND universal de push-pull. |
| V41 | Cortar VCC de sensor en vivo | NACK y reset/registros/persistencia según su hoja. |
| V42 | BME280 conversión/oversampling/IIR | Fórmulas oficiales, tiempo y distribución de ruido. |
| V43 | MPU6050 saturación/DLPF/INT | Escalas, latencias, semilla y eventos capturados. |
| V44 | DS3231 pila/corte/alarmas/aging | Continuidad temporal y error ppm, sin derivar de reloj de pared arbitrario. |
| V45 | Varias placas con una averiada | Estado por placa, fuentes comunes/independientes y política de parada explícita. |
| V46 | UART interplaca baud/tensión | Solo marcar soportado cuando exista ruta real verificada. |
| V47 | RF ausente/canal/distancia | Funcional vs físico declarados; no inferir alcance por recibir una trama. |
| V48 | Modelo roto o desconocido | Fidelidad degradada; medidas desconocidas donde afecte. |
| V49 | SPICE sin vector, NaN, resultados parciales | Rechazo claro; ningún `??0` con apariencia de medición. |
| V50 | Divergencia y timeout | Worker termina, cola recupera, sin bloquear servidor ni consumo indefinido. |
| V51 | Orden de módulos/cables invertido | Mismas magnitudes, dentro de tolerancia, por invariancia de permutación. |
| V52 | Renombrar IDs sin cambiar red | Resultado invariante; alias normalizados y referencias coherentes. |
| V53 | Muestreo cliente y recarga | El estado eléctrico no depende de qué pestaña está abierta. |
| V54 | Temperatura y tolerancias | Corners min/typ/max documentados y semilla en análisis estadístico. |

No usar una tolerancia única para todo: error del solver, simplificación del modelo, tolerancia del componente e incertidumbre de medición se registran separadamente. Un 10 % aceptado entre modelos distintos de LED no valida un error del 10 % en cualquier componente.

## 10. Arquitectura recomendada para mantenerlo confiable

### 10.1 Contrato explícito de física

Cada modelo debe declarar: modo DC/transitorio/funcional; primitivas y puertos; identidad del hardware y revisión; fuentes de parámetros; rango de tensión/corriente/temperatura/frecuencia; incertidumbre; fenómenos omitidos; política de fallo y pruebas de conformidad.

Separar identificador de módulo visual, terminal visible y **pad físico**. Varias etiquetas pueden mapear al mismo pad. Las tierras se unen únicamente por relaciones eléctricas explícitas; las fugas de regularización tienen metadatos propios y no prueban aislamiento real.

### 10.2 Resultado autoritativo y estados desconocidos

Publicar un snapshot con `mode`, `simulatedTime`, versión de modelo/solver, `validity`, medidas con unidades, estado por placa, diagnóstico numérico y fenómenos no soportados. Los valores hipotéticos de comprobación se alojan aparte de las medidas vivas.

Estados mínimo: válido, fuera de dominio, degradado, no convergente, desconocido. La UI no debería mostrar un color “correcto” si el motor no tiene un modelo completo de esa parte del circuito.

### 10.3 Co-simulación por eventos

El dominio mantiene su reloj y los backends usan adaptadores. GPIO informa mode/drive/pulls/level con timestamp simulado; el motor devuelve niveles/analógicos y transiciones de suministro. Las placas independientes avanzan de forma coordinada cuando interactúan. Renderizar menos veces por segundo no descarta eventos de la física.

Mantener un modo DC rápido para circuitos simples y añadir transitorio solo cuando el circuito lo requiera. La estrategia de paso, interpolación y tolerancia se registra. No aumentar simplemente la frecuencia de peticiones HTTP.

### 10.4 Solver aislado y modelos propios

ngspice permanece detrás de un adaptador del dominio; no exponer su formato como estado interno de toda la app. Usar worker/proceso, cola acotada, watchdog real y telemetría de coste. Las extensiones pueden aportar modelos, pero no alterar silenciosamente reglas globales ni etiquetar como físico un comportamiento funcional.

Un módulo no validado conserva esa clasificación. El sandbox protege la ejecución y valida primitivas; no certifica que las ecuaciones de un modelo reproduzcan un número de parte real.

## 11. Orden de trabajo propuesto

1. **Corregir la confiabilidad dentro de DC:** F01–F05, unknown/errores, alias y parámetros de riel. Tests que fallen antes del cambio.
2. **Unificar estado vivo:** medidas/UI/daño y power de chips; evitar que un circuito no modelado aparezca sano.
3. **Pad runtime:** open-drain, cambios de dirección, pulls, ADC y perfiles por chip; mantener scanner solo para diagnóstico previo.
4. **Tiempo y eventos:** capturar pulsos; coordinar varias placas; transitorios RC/RL y PWM con validación analítica.
5. **Modelos de hardware concretos:** reguladores, alimentación USB/VIN, límites agregados, térmica/protecciones y tolerancias.
6. **Buses eléctricos:** primero I2C y SPI por casos comunes; después comunicaciones adicionales que se decida soportar.
7. **Caracterización experimental:** fixture físico y catálogo versionado de medidas; declarar dominio validado en cada release.

Criterio para cerrar una corrección: reproducción original falla antes; comportamiento corregido pasa; no rompe casos válidos; la documentación y la etiqueta de fidelidad coinciden; error y fuera-de-dominio se prueban además del caso nominal.

## 12. Validación física y mantenimiento continuo

La comparación entre dos solvers detecta errores de ecuaciones, pero ambos pueden compartir parámetros irreales. Hace falta una tercera referencia: modelos externos independientes y medidas controladas de componentes identificados.

Banco sugerido: fuente de laboratorio limitada, multímetro, osciloscopio/analizador lógico, resistencias medidas, LEDs con número de parte, placas de revisión conocida y fixture de cables repetible. Registrar instrumentos, resolución, incertidumbre, temperatura, firmware y condiciones de montaje. No hace falta destruir componentes para validar funcionamiento nominal y márgenes: los tests de abuso pueden usar modelos/fuentes de referencia dentro de límites y contrastar especificaciones.

Por cambio de modelo: revisión de hoja de datos, test analítico, regresión de invariantes y resultados guardados. Por release: DC y periféricos, casos desconocidos/degradados, co-simulación y casos de hardware caracterizados. La auditoría se repite cuando cambian backend, catálogo, parámetros, versiones del motor o rutas de eventos.

No se creó una automatización recurrente: los ciclos descritos son los realizados para esta investigación y el procedimiento propuesto para futuras revisiones.

## 13. Evidencia de ejecución

Los resultados de esta auditoría se completan abajo con los comandos ejecutados. No reutilizar los totales históricos de `docs/motor-electrico.md` como resultados actuales.

Pruebas físicas ejecutadas:

```bash
cd app
nice -n 10 ./node_modules/.bin/vitest run \
  server/src/sim/motor.test.ts server/src/sim/regulador.test.ts \
  server/src/sim/multiplaca.test.ts server/src/sim/comparacion.test.ts \
  server/src/solver.test.ts server/src/circuitNetwork.test.ts \
  --maxWorkers=1 --minWorkers=1
```

Resultado: **6 archivos, 90 pruebas pasaron**, duración reportada 14,07 s. Los 30/40 circuitos aleatorios de ciertos tests son casos internos, no 70 tests independientes adicionales. Log local `/tmp/audit-physics-tests.log`.

Reproducciones: script temporal `/tmp/audit-electrico/repro.ts`, log `/tmp/audit-repro.log`; casos F01, F02 y F03. Los resultados relevantes y las conexiones están registrados en §6 para que no dependan de que `/tmp` sobreviva.

Pruebas adicionales de firmware y buses ejecutadas:

```bash
cd app
nice -n 10 ./node_modules/.bin/vitest run \
  server/src/bus server/src/pinScan.test.ts server/src/avrSim.test.ts \
  --maxWorkers=1 --minWorkers=1
```

Resultado: **19 archivos, 214 pruebas pasaron**, duración reportada 91,74 s. Log `/tmp/audit-runtime-tests.log`. Incluyen periféricos funcionales, scanner y ejecución AVR; no certifican integridad eléctrica ni representan una compilación nueva de imágenes Docker.

Total de suites existentes ejecutadas en esta auditoría: **25 archivos, 304 pruebas aprobadas**. Además se ejecutaron las reproducciones adversariales de F01–F04. No se corrió la suite completa del repositorio ni Playwright: el cambio de esta tarea es documental y la evidencia buscada es del motor y sus contratos, no del aspecto del front. Las pruebas que pasan no invalidan los fallos reproducidos fuera de su cobertura.

## 14. Referencias del repositorio

- [Motor activo y límites declarados](docs/motor-electrico.md).
- [Diseño de circuito libre y solver alternativo](SDD-CIRCUITO-LIBRE.md).
- [Diseño de módulos](SDD-MODULOS.md).
- [SDK de módulos](docs/modulos-y-su-codigo.md).
- [Catálogo de chips y alcance funcional](chips/README.md).
- [Análisis activo](app/server/src/sim/analisis.ts).
- [Netlist y lectura de resultados](app/server/src/sim/netlist.ts).
- [Adaptador ngspice](app/server/src/sim/spice.ts).
- [Modelo eléctrico de placas](app/server/src/sim/placa.ts).
- [Scanner de pines](app/server/src/pinScan.ts).
- [CPU y periféricos AVR](app/server/src/avrSim.ts).
- [Buses de chips](app/server/src/bus/busChips.ts).
- [Puente MicroPython](app/server/src/templates/micropythonBridge.ts).
- [Integración y política de simulación](app/server/src/index.ts).
- [Estado visible y quemaduras](app/web/app.ts).

## 15. Pendientes explícitos de investigación

- Caracterizar con hoja y esquemático exactos los cuatro modelos de placa; evitar trasplantar parámetros de otra familia/revisión.
- Medir la cancelación real de ngspice WASM y verificar su versión efectiva; el manual consultado no identifica por sí solo la versión embebida.
- Convertir la reproducción de alias en una regresión permanente; ejecutar casos de alimentación dinámica de sensores, runtime open-drain y UI de LED activo bajo/diferencial.
- Contrastar parámetros de RF RXB6/STX882 con documentación de fabricante verificable; hay módulos comerciales con procedencia y variantes poco claras.
- Completar con hojas concretas el alcance de pantallas, EEPROM, reguladores y contactos de relé antes de afirmar fidelidad por componente.
- No se hicieron mediciones en un circuito físico, campaña Monte Carlo ni certificación de seguridad/EMC; este informe no las sustituye.

La lista cubre los caminos y familias examinados; la electrónica completa incluye fenómenos que exceden los modelos del repositorio. “Exhaustivo” aquí significa revisar sistemáticamente el alcance actual y registrar lo que falta, no dar por verificada toda la física posible.

## 16. Inventario de los veinte módulos examinados

Hay veinte descriptores `modules/*/module.json`, trece modelos eléctricos `model.js`, cuatro placas modeladas centralmente y tres dispositivos RF sin modelo eléctrico. Los números siguientes describen **lo que el código hace**, no parámetros certificados del hardware. Las referencias de fabricante y sus condiciones deben mantenerse junto a cada parámetro.

| Módulo | Modelo eléctrico actual | Alcance y faltantes particulares |
|---|---|---|
| Arduino Uno R3 | Lógica 5 V, driver 25 Ω, USB/VIN/regulador genéricos | Alias defectuosos; 3V3 con límite equivocado; RESET/AREF, LED integrado, consumo variable y distribución real de alimentación incompletos. |
| ESP32-S3 DevKitC-1 | Lógica 3V3, driver 33 Ω, diodos y pulls | No individualiza variantes de módulo, dominios, fuerza de drive, EN/strapping o picos de consumo de radio. |
| ESP32-C3 DevKitM-1 | Familia de modelo 3V3 genérico | Validar parámetros propios; glitches de encendido descritos por fabricante no representados en `.op`. |
| ESP32-C6 DevKitC-1 | Familia de modelo 3V3 genérico | Wi-Fi/Thread declarados no acreditan comportamiento eléctrico o RF. |
| LED | Shockley calibrado en un punto por color; N=2, RS=2 Ω, BV=5 V | Sin referencia de pieza, curvas térmicas/ópticas o tolerancia; `seriesOhm=15 Ω` del descriptor no coincide con RS del modelo activo. |
| Resistencia | R ideal, diagnóstico de potencia | Faltan tolerancia, TCR, potencia nominal por pieza, derating, pulsos, tensión máxima y parásitos. |
| Pulsador | Contacto RON=0,05 Ω, ROFF=1 GΩ | Sin rebote, arco, desgaste ni límites del contacto. |
| Interruptor | Contacto con la misma aproximación | Sin dinámica mecánica o configuraciones multipolares reales. |
| Fuente regulable | Ajuste ±12 V y limitación DC CV/CC | Sin respuesta del lazo, rizado o térmica; verificar explícitamente absorción y entrega inversa. |
| Relé | Entrada R/diodo, interruptor controlado, bobina 70 Ω y diodo flyback | Bobina sin inductancia; sin tiempos de operación/liberación. **No expone COM/NO/NC eléctricos**: la indicación de contacto no conecta una carga mediante esos terminales. |
| RXB6 | Carga 1,1 kΩ entre VCC y GND | DATA sin driver eléctrico; sensibilidad y canal RF funcionales separados. Rango de UI y umbral de peligro no coinciden. |
| STX882 | DATA 100 kΩ; carga de transmisión 147 Ω controlada por umbral | Sin antena, propagación, potencia RF o protección de DATA; corriente simplificada. Límites de comentario y aviso requieren conciliación. |
| Control remoto 433 | Eventos RF sin pines/modelo eléctrico | Sin batería, consumo, oscilador, antena, alcance o agotamiento. |
| Sensor de puerta 433 | Eventos funcionales sin modelo eléctrico | Sin reed físico, distancia/histéresis magnética, batería o canal RF. |
| Sirena 433 | Estado funcional/UI sin modelo eléctrico | Sin alimentación, amplificación, altavoz ni potencia acústica. |
| BME280 Adafruit | REG 3V3, dropout 0,31 V, 150 mA, carga equivalente y pulls | Comentario sobre BSS138 no equivale a MOSFETs/ambos lados del adaptador de nivel en el netlist. Consumo no sigue los modos de conversión. |
| MPU6050 GY-521 | REG 3V3, carga nominal 3,8 mA, pulls 4,7 kΩ y LED | XDA/XCL/INT sin electrónica completa; `ui.on` aproxima el riel interno desde VCC. Ruido/filtros funcionales sí existen. |
| DS3231 ZS-042 | Cargas, pulls, LED, circuito de carga y batería ideal | Advertencia de carga de CR2032 útil; sin SOC. RTC respaldado y EEPROM deben tener suministros independientes. Drivers SQW/32K incompletos. |
| OLED SSD1306 | REG, carga nominal 10 mA y pulls | Consumo no depende de píxeles, contraste o sleep; estado operativo no valida el riel interno ni niveles de todos los pines. |
| TFT ST7735 | REG, carga nominal 6 mA, LED y 47 Ω de backlight | SPI/reset/DC sin cargas y protecciones completas; consumo dinámico y variantes de módulo pendientes. |

Las placas y módulos genéricos deben indicar la variante que representan. No convertir una cifra del modelo en un límite válido para cualquier producto comercial con el mismo nombre.

## 17. Segunda revisión: límites del contrato y del diagnóstico

Estos puntos complementan F01–F15. Están confirmados por lectura salvo donde se indique prueba pendiente; no se presentan como nuevos fallos ejecutados.

### Regularización numérica y alta impedancia

`sim/netlist.ts:220–236` añade fugas de 1 TΩ, `rshunt` y `gmin` para facilitar convergencia. Son ayudas matemáticas: pueden fijar un potencial en una isla sin referencia física y afectar corrientes muy pequeñas. Deben figurar en los metadatos del resultado y en el presupuesto de error. El caso F02 demuestra por qué una tensión numérica no basta para declarar una entrada determinada.

El solver alternativo tiene un límite de iteraciones y un estado de convergencia. Comparar un resultado no convergido con ngspice no constituye validación independiente. Las cinco pruebas de comparación ejecutadas comprueban un subconjunto, no la equivalencia de todos los módulos ni de sus curvas no lineales.

### Descriptor, fuente y procedencia de energía

`supplyOutputOhm` aparece en los descriptores y en `circuitNetwork.ts`, pero no determina la fuente de `sim/placa.ts`. Por ello, editar ese dato no necesariamente cambia el motor productivo. La rama de fuente con límite de corriente de `sim/netlist.ts:157–177` tampoco aplica `rSerie` del mismo modo que la rama sin límite. Hace falta un contrato común y tests que varíen cada parámetro público verificando su efecto observable.

El modelo de regulador pasa pruebas de dropout, limitación y ausencia de energía gratuita dentro de los casos examinados. Esto no valida cualquier composición de fuentes ideales, fuentes internas de corriente y fuentes que puedan absorber potencia. Revisar signos, procedencia de energía, comportamiento en inversión y región de operación por dispositivo.

La guía del S3 DevKitC-1 describe USB, 5V y 3V3 como opciones de alimentación mutuamente excluyentes. Los diodos genéricos del simulador no acreditan seguridad de una combinación real de esas opciones. Se necesita aplicar reglas y camino de potencia del esquemático de la revisión elegida. [Guía oficial de alimentación DevKitC-1](https://docs.espressif.com/projects/esp-idf/en/v5.0/esp32s3/hw-reference/esp32s3/user-guide-devkitc-1.html).

### Modelos omitidos o inválidos

Un módulo desconocido o un error al construir su modelo puede quedar sin contribución eléctrica; la ruta de excepción de `sim/analisis.ts:295–300` necesita un diagnóstico explícito que invalide o marque como incompleto el análisis. Una carga desaparecida puede hacer que el resto del circuito parezca más saludable. Una fuente interna declarada sin procedencia física también necesita reglas del SDK, no solamente un aviso.

Revisar cacheado por tipo/flags cuando cambia el descriptor bajo el mismo identificador, y la sanitización de identificadores de nodos. **Pendientes de prueba:** recarga de un modelo conservando su ID y dos nombres distintos que puedan normalizarse al mismo nombre SPICE. No se afirma que esas colisiones hayan ocurrido.

### Límites de tensión y lenguaje del diagnóstico

El peligro por corriente de inyección en GPIO usa un umbral de 1 mA (`sim/analisis.ts:665–666`). Superar una tensión admisible y exceder corriente de inyección son condiciones distintas; un resistor grande puede limitar corriente sin hacer que la tensión aplicada cumpla la hoja de datos. Añadir reglas de tensión por dominio, tolerancia con chip apagado y corriente agregada, identificando cuáles son absolutos, típicos o recomendaciones.

Mensajes como “funciona” o “el polifusible corta” sobrepasan la evidencia cuando solo se conoce un punto DC y un límite estático. El diagnóstico debe expresar la medida, la condición de la referencia y el fenómeno que queda fuera del modelo. Una curva PPTC depende de temperatura y tiempo; el límite DC no modela su disparo ni recuperación. [Familia PPTC y documentación de fabricante](https://www.littelfuse.com/products/fuses-overcurrent-protection/polyswitch-resettable-pptc-devices).

### Cierre del ciclo de investigación

El segundo ciclo convirtió la hipótesis de alias en una reproducción, agregó las suites de buses/runtime y revisó la cobertura de cada módulo. El siguiente ciclo útil es convertir F01–F04 en regresiones permanentes, corregir el contrato de resultados y contrastar circuitos de referencia con piezas identificadas. Repetir las mismas suites sin ampliar casos ni evidencia no aumentaría la confianza física.
