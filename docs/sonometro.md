# Cómo probar y entender el sonómetro

Creá un proyecto desde la plantilla **Sonómetro que se lee desde el código**
(`sonometro-que-se-lee`). Usa MicroPython en ESP32-S3; requiere esp-emu y firmware disponible,
pero no Docker. Apretá ▶ y, en la consola, seleccioná **Emulador**. La pestaña Compilación sólo
muestra la preparación y subida del programa: allí no aparecen las lecturas periódicas.

Seleccioná el SEN0232 en el dibujo y cambiá **Nivel de sonido del ambiente (dBA)**. Es un nivel
que vos declarás para la escena. También podés usar el micrófono del computador desde Debug,
como se explica abajo. El modo manual no requiere permisos.

## Qué sucede

1. El modelo del sensor convierte el nivel declarado en una tensión: idealmente `V = dBA × 0,02`.
2. OUT está conectado a GPIO4, VCC a 3V3 y GND a GND de la placa. USB está encendido.
3. El ADC convierte tensión en cuentas usando el perfil explícito de esta plantilla, 12 bits
   y atenuación de 11 dB, con escala declarada de 0–3,1 V.
4. `main.py` convierte cuentas a voltios (`cuentas × 3,1 / 4096`) y luego a dBA (`V / 0,02`).
   Imprime aproximadamente una vez por segundo; no hay que volver a compilar al cambiar el nivel.

Prueba realizada el 2026-10-10 con Chrome, el motor eléctrico, MicroPython y esp-emu reales:

| Nivel configurado | ADC leído por firmware | Voltios impresos | Nivel impreso |
|---|---:|---:|---:|
| 30 dBA | 796 | 0,60 V | 30,1 dBA |
| 50 dBA | 1324 | 1,00 V | 50,1 dBA |
| 80 dBA | 2118 | 1,60 V | 80,1 dBA |
| 100 dBA | 2646 | 2,00 V | 100,1 dBA |
| 130 dBA | 3440 | 2,60 V | 130,2 dBA |

También se verificó el regreso de 130 a 50 dBA con una lectura nueva, no una línea vieja de la
consola. La diferencia con el nivel configurado proviene de la tensión resuelta del circuito,
la cuantización y el redondeo de impresión; no representa una calibración física del sensor.

## Si aparece un error

El perfil ADC forma parte de `project.json`, en `sim.analogicoEsp.board`. No alcanza con agregar
el sensor a un proyecto vacío: hace falta declarar el canal y la atenuación. La plantilla ya
trae esa configuración y el programa.

- `SIN_MODELO_CANAL`: GPIO o atenuación no coincide con un canal declarado.
- `ENTRADA_FUERA_DOMINIO`: la tensión está fuera del rango que permite el perfil.
- Si no hay salida de consola, comprobá que estás en **Emulador**, la simulación está corriendo
  y la placa está alimentada. Revisá también el cableado OUT → GPIO4 y la masa común.

Se probó un perfil restringido a 0,9–1,1 V: 80 dBA (≈1,6 V) produjo `ENTRADA_FUERA_DOMINIO`;
volver a 50 dBA (≈1 V) recuperó la lectura. Ese rechazo es intencional: el ADC no inventa cuentas
fuera del dominio declarado. Al cambiar un perfil, detené y arrancá la simulación para aplicarlo.

No se modelan acústica del ambiente, ponderación A real, respuesta temporal del sensor ni su
error experimental. No se ensayó un SEN0232 físico. Detalle del modelo: [audio.md](audio.md#el-que-ya-está-sonometro-sen0232).

## Historial en Debug

Abrí **Debug → Monitoreo de señales**. Cerrá ese desplegable para volver a las variables, alimentación y pines de Debug. La vista muestra el nivel declarado en dBA y
OUT respecto a GND en voltios, en escalas separadas. Al abrirla consulta la instantánea
una vez por segundo; los cambios del circuito también aportan muestras. Retiene hasta
600 muestras, con tiempo de recepción en el navegador. Los cálculos inválidos dejan huecos.

**Pausar vista** congela lo que ves y descargás, mientras el historial vivo continúa.
**Reanudar vista** vuelve a las muestras recientes. **Descargar muestras** conserva unidades,
procedencia, contexto y huecos en JSON. Cambiar de proyecto o iniciar otra corrida limpia
el historial. La gráfica representa instantáneas DC; no es la onda acústica del micrófono.

Podés agrandar la ventana Consola arrastrando su separador para ver las gráficas con más espacio.

## Micrófono del computador

En **Debug → Monitoreo de señales**, elegí el sonómetro de destino y pulsá **Conectar micrófono**.
Aceptá el permiso del navegador. Requiere localhost o HTTPS. Hablá: la onda relativa muestra
la envolvente mín/máx de la última ventana de 2048 muestras. No sale sonido por los parlantes.
Después de autorizar el micrófono podés detenerlo, elegir otro dispositivo y reconectar.

Se calcula RMS digital y `dBFS = 20 × log10(RMS)`. Son decibelios respecto al máximo digital;
no miden presión acústica. La referencia inicial relaciona −20 dBFS con 80 dB estimados.
Podés cambiar ambos valores: `estímulo = dBFS − referencia digital + nivel de referencia`.
La sensibilidad y el procesamiento del computador afectan la lectura. Se solicita desactivar
cancelación de eco, reducción de ruido y ganancia automática; el panel informa lo concedido.
No hay ponderación A ni calibración acústica, por lo que el resultado no es dBA físico.

El estímulo reemplaza temporalmente el nivel manual del sensor en el circuito y el ADC del
firmware recibe su tensión. El SEN0232 conserva el recorte 30–130 (≈0,6–2,6 V con alimentación
suficiente); un estímulo estimado menor o mayor permite probar esos límites. El silencio digital
se representa con estímulo cero y también cae en el límite inferior del sensor.

El audio crudo permanece en el navegador; al servidor se envían solo dBFS, referencia y secuencia
hasta cuatro veces por segundo, con una petición en curso. Solo se admite una sesión de captura
por servidor. No se guarda el nivel estimado en el proyecto. **Detener micrófono** libera el
dispositivo y recupera el nivel manual guardado. También se detiene al ocultar la pestaña,
cambiar de proyecto/destino, desconectar el dispositivo o perder conexión. Si el navegador
se cierra sin avisar, la sesión vence a los seis segundos sin actualizaciones.

Las gráficas eléctricas usan «dB estimados» durante la captura y conservan la referencia en la
exportación JSON. Al pasar entre manual y micrófono se reinicia el historial para separar
procedencias. Pausar la vista congela las gráficas eléctricas; la onda local del micrófono y el
estímulo continúan hasta pulsar Detener. La onda local no se exporta ni se conserva como grabación.

### Validación integrada de la captura

Probado el 2026-10-10 en Chrome con una señal sintética de 375 Hz dentro de un MediaStream y
Web Audio reales, el motor eléctrico, esp-emu y MicroPython. No se usó un micrófono físico.
El seno de amplitud digital 0,1 midió −23,0103 dBFS; se usó esa referencia para esta prueba:

| Estímulo estimado | OUT resuelto | ADC del firmware | Nivel impreso por la plantilla |
|---|---:|---:|---:|
| 80 | 1,603 V | 2118 | 80,1 |
| 100 | 2,003 V | 2646 | 100,1 |
| 160 | 2,604 V | 3440 | 130,2 |
| 5 | 0,603 V | 796 | 30,1 |

Después de detener la captura se recuperaron 1324 cuentas y 50,1, con el proyecto sin cambios.
La plantilla sigue imprimiendo la etiqueta dBA de la escala del sensor emulado; eso no convierte
la señal del computador en una medición acústica física. La validación cubre el camino digital,
el recorte y la lectura del firmware; la selección y autorización de tu micrófono se realiza en
tu navegador al pulsar Conectar.
