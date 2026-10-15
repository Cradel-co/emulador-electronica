# Canal RF opcional

`CanalRfSchema` es un contrato propio del servidor. Las herramientas MCP `enviar_rf`
y `accionar_modulo` aceptan `canalRf`; `transmitirPorCanalRf` decide antes de llamar
al mismo puente RF que ya utiliza la aplicación. La decisión y el presupuesto vuelven
al solicitante. `entregado` indica que el puente aceptó la inyección, no un ACK de radio.
`accionar_modulo` exige el transmisor existente que se acciona. `enviar_rf` permite un transmisor
externo al dibujo. Ambos conservan el canal completo al llamar al transporte, para que una
declaración física no termine convertida en una inyección funcional.

`validarDestinoRf(proyecto, buscar, boardId, analisis, canalRf?)`, en `destinoRf.ts`, comprueba
por placa la identidad/rol `rf-rx`, el GPIO conectado y un único receptor cableado. Cuenta también
otros receptores apagados o de alimentación desconocida: el puente no puede elegir entre ellos.
Para un canal declarado exige `analisis.resuelto === true` y
`analisis.modulos[receptorId].ui.on === true`, además de las conexiones de VCC/GND. Un cable
en VCC no acredita alimentación: VCC a tierra, análisis ausente o un modelo sin `ui.on` bloquean
la entrega. El llamador aporta una instantánea eléctrica vigente del mismo proyecto; el helper
no ejecuta ngspice ni puede acreditar por sí solo la vigencia de un snapshot.

La validación central del transporte se aplica además del presupuesto y del destino. El puente
RF nativo admite protocolo RMT 1 y hasta 24 bits; AVR y MicroPython carecen de ese transporte.
Una trama no soportada no se trunca ni se informa como entregada. Las otras configuraciones del
contrato sirven para evaluar un presupuesto declarado, no para acreditar un demodulador emulado.

- Sin `canalRf`, conserva el modo `funcional`, identificado en la respuesta. No calcula alcance.
- Con datos incompletos o fuera de dominio, devuelve `no-resuelto` y no inyecta bits.
- Un presupuesto sin sensibilidad ni ruido+SNR calcula potencia, pero no autoriza recepción.
- Debajo del umbral o con polarización ortogonal ideal, no inyecta bits. En el umbral exacto sí.

El modelo exige identificación, fuente y condiciones para ambos extremos, una frecuencia
en Hz, distancia en metros, dimensiones de antenas en metros, potencia conducida en
dBm/mW/W, ganancias en dBi **en la dirección del enlace**, pérdidas de alimentación/adaptación
en dB y polarización. No convierte posiciones del dibujo en distancia física. La potencia
debe estar referida antes de las pérdidas de alimentación declaradas para evitar contarlas dos veces.
La configuración de modulación, tasa de bits y ancho de banda identifica las condiciones de
sensibilidad y ruido; se supone compatible en los dos extremos, no se simula su demodulador.

Solo admite espacio libre, línea de vista y campo lejano declarados, sin multitrayecto ni
interferencia. Además exige `r > max(10λ, 2Dtx²/λ, 2Drx²/λ)`, un perfil conservador que combina
el criterio de antenas pequeñas y el de Fraunhofer. Ese filtro no acredita el montaje físico.
No calcula reflexiones, paredes, curvatura terrestre, desvanecimientos ni campo cercano.

El cálculo es `Pr[dBm] = Pt + Gt + Gr − Ltx − Lrx − Lfs − Lpol`.
Para polarizaciones lineales ideales, la fracción de potencia acoplada es `cos²(ángulo)`;
90° representa señal cero, serializada como `potenciaRecibidaW=0` y `potenciaRecibidaDbm=null`.
También admite una pérdida de polarización declarada con fuente. El umbral efectivo es el
mayor de la sensibilidad declarada y `ruido de entrada + SNR mínimo`, cuando existen ambos.
El ruido corresponde al ancho de banda y las condiciones declaradas; no se genera ruido aleatorio.

No hay valores por defecto de potencia, sensibilidad o antena para RXB6/STX882.
No se transfieren especificaciones de CC1101 ni de otra radio. Una fuente escrita por quien
configura el canal conserva procedencia declarada; no equivale a una calibración o validación de
esa radio. El filtro determinista no acredita BER/PER ni sustituye ensayos de alcance.

Referencias y oráculos:

- [ITU-R P.525-5, §2.3, ecuaciones 4–6](https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.525-5-202411-I!!PDF-E.pdf): pérdidas de espacio libre y apertura isotrópica.
- [Keysight, Antenna Measurement Theory](https://www.keysight.com/kr/ko/assets/9018-07604/article-reprints/9018-07604.pdf): regiones de campo y límites `2D²/λ` y `10λ`.
- [TI SWRA479A, §2.3–2.5](https://www.ti.com/lit/an/swra479a/swra479a.pdf): presupuesto, margen y límites de Friis; ejemplo de 80,2 dB a 2445 MHz y 100 m. No se usan sensibilidades de sus radios como parámetros del catálogo.
- [MathWorks, polloss](https://www.mathworks.com/help/phased/ref/polloss.html): ejemplos de 3,0103 dB a 45°, 1,2494 dB a 30° y pérdida infinita a 90°.

Los tests contrastan el cálculo en dB contra densidad de flujo/apertura en vatios, referencias
publicadas, unidades equivalentes y rechazo de condiciones fuera del perfil. Las pruebas MCP
usan el transporte real en memoria. Los tests de destino usan snapshots eléctricos y verifican
que una trama bloqueada no se inyecta, incluso con VCC a tierra, datos eléctricos desconocidos,
identidad/rol incorrectos o varios receptores. No levantan ngspice.
