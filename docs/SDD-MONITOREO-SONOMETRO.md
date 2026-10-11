# SDD — Monitoreo de señales y entrada de micrófono

Estado: primeras dos entregas implementadas en la rama de monitoreo; entrada de micrófono pendiente. Continuación del monitoreo de la etapa 6.

## Objetivo

Observar cómo un estímulo de sonido llega al firmware sin confundir la onda acústica capturada, el nivel estimado del ambiente y la salida eléctrica del SEN0232. Reutilizar el historial para otras magnitudes del simulador.

## Situación actual

Debug dispone de una grabadora de eventos y un analizador lógico digital. Los análisis transitorios de diseño cuentan con API, pero no con una ventana de osciloscopio. El sonómetro recibe `dbA` manual y su modelo recorta la salida al equivalente de 30–130 dBA. Este recorte es una decisión del modelo, no evidencia experimental fuera del rango del fabricante.

La entrada del micrófono del computador aún no está implementada. La actualización de dependencias y las verificaciones del sonómetro deben publicarse antes de iniciar este bloque en una rama independiente.

## Señales y procedencia

- Onda del micrófono: muestras de audio relativas, con frecuencia de muestreo y reloj de captura. No se etiquetan como voltios ni pascales.
- Nivel de entrada: dBFS medidos y, por separado, nivel estimado para estimular el modelo. Sin referencia acústica no se presenta como medición física en dBA.
- Nivel manual: dBA declarados por el usuario; conserva la operación sin micrófono.
- Salida del sensor: voltios calculados por el motor respecto a GND, con su validez y tiempo de resolución.
- Lectura del firmware: dato publicado por el programa. No se infiere una lectura ADC efectiva a partir del voltaje del circuito.

Cada serie identifica proyecto, corrida, origen, unidad, reloj, tiempo y validez. Cambio de proyecto o corrida limpia el historial correspondiente. Valores ausentes o inválidos producen huecos; no mantienen una lectura anterior como si fuera vigente. Relojes de captura, resolución eléctrica y firmware no se presentan como simultáneos sin sincronización acreditada.

## Interfaz

Un panel Monitoreo accesible desde Debug reúne series seleccionables, pausa de visualización, ventana temporal y exportación de muestras. La primera entrega muestra el nivel manual y la tensión resuelta del sonómetro; después incorpora la entrada de audio. El analizador lógico conserva sus canales digitales.

La onda de audio y la tendencia de nivel usan vistas y escalas diferentes. El voltaje del SEN0232 sigue el nivel acondicionado: no reproduce cada oscilación del sonido. La gráfica del circuito vivo es un historial de instantáneas, no una solución transitoria continua de ngspice.

## Entrada de micrófono

Activación explícita con permiso del navegador. Adaptador de captura separado del modelo de dominio. Solicitar desactivación de ganancia automática, cancelación de eco y reducción de ruido; registrar las opciones efectivamente concedidas, porque el navegador puede no respetarlas.

Calcular RMS y dBFS en ventanas definidas, indicar silencio y saturación de captura. Una referencia configurable traduce el nivel relativo a un estímulo estimado; conservar la señal original y la referencia usada. No declarar ponderación A ni calibración física sin implementarlas y verificarlas.

El estímulo puede quedar fuera de 30–130; el adaptador no lo recorta antes de enviarlo al modelo. El modelo existente aplica sus límites eléctricos. Detener captura libera las pistas de audio. Denegación de permiso, desconexión o suspensión muestran estado y permiten volver al modo manual. Audio crudo no se guarda ni se envía al servidor por defecto.

## Entregas

1. Contrato de series y buffer acotado, con pruebas de unidades, validez, reloj, aislamiento y descarte de muestras antiguas.
2. Panel reutilizable; primera integración con nivel manual y salida resuelta del sonómetro. Verificar cambios en vivo con MicroPython ejecutándose.
3. Adaptador de micrófono y configuración de referencia; probar permiso denegado, silencio, saturación, cambio de dispositivo y liberación de recursos.
4. Exportación y comparación con lecturas explícitamente publicadas por firmware. Extender luego a corriente, potencia y temperatura según contratos disponibles.

## Criterios de aceptación

- Un cambio manual de nivel se observa en el historial y en el programa real de la plantilla.
- Entradas inferiores a 30 y superiores a 130 conservan su valor de estímulo y respetan el recorte del modelo, con alimentación y carga verificadas.
- La onda capturada nunca se rotula como salida analógica del SEN0232.
- Ninguna serie promete dBA físicos, sincronización o resolución superiores a su evidencia.
- Captura, transporte, almacenamiento y repintado tienen costes acotados; audio se reduce por ventanas antes de actualizar el circuito y no dispara un cálculo por muestra.
- Una sesión nueva no contiene muestras de otra; un cálculo inválido no dibuja una medida vigente.

## Decisiones de alcance

La primera entrega no cambia el solver ni añade un módulo nuevo. Las extensiones de física requieren pruebas que fallen antes del cambio, conforme a las reglas del repositorio. La ponderación A, respuesta temporal física y calibración acústica son entregas posteriores con requisitos y oráculos propios.

## Primera implementación

El historial vive en el navegador, separado del estado de React, y recibe solo las respuestas
eléctricas que ya pasaron la comprobación de proyecto y topología del editor. La tensión
es OUT menos GND; no se presupone una masa de cero voltios. Cada muestra incluye revisión
de la observación cuando es válida. La captura se limpia al abrir un proyecto, volver a
Inicio, comenzar el arranque del emulador o recibir una nueva generación de corrida.

La UI se monta como una isla React en un nodo existente de Debug. El desplegable Monitoreo
permite elegir señales, congelar una copia para visualizar/exportar y volver al historial
vivo. Retiene 600 muestras; los descartes se contabilizan. El sondeo es de un segundo,
solo con la pestaña y el desplegable visibles, sin solicitudes periódicas solapadas.
Los eventos y cambios del editor también aportan observaciones.

La descarga JSON identifica el reloj de recepción y el dominio de instantáneas DC.
La primera integración es el SEN0232 manual. No implementa captura de audio ni deduce
lecturas ADC del firmware: la validación con la plantilla comprueba ambas por separado.

Verificación de la primera entrega: 1660 pruebas unitarias pasan (1 omisión previa), 143
casos de navegador pasan (13 omisiones previas), tipos y build en verde. Después del ajuste
final de presentación se repitieron los cinco casos de Monitoreo y Problemas. La plantilla
se ejecutó con MicroPython real y se contrastaron los niveles 30, 50, 80, 100 y 130 dBA y
el retorno a 50 contra la consola y las muestras exportadas. Esto verifica software, no
calibración acústica de un dispositivo físico.
