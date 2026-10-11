# Cómo probar y entender el sonómetro

Creá un proyecto desde la plantilla **Sonómetro que se lee desde el código**
(`sonometro-que-se-lee`). Usa MicroPython en ESP32-S3; requiere esp-emu y firmware disponible,
pero no Docker. Apretá ▶ y, en la consola, seleccioná **Emulador**. La pestaña Compilación sólo
muestra la preparación y subida del programa: allí no aparecen las lecturas periódicas.

Seleccioná el SEN0232 en el dibujo y cambiá **Nivel de sonido del ambiente (dBA)**. Es un nivel
que vos declarás para la escena; este módulo no escucha el micrófono de la computadora.
El micrófono/webcam del navegador pertenece a otras funciones. No hace falta habilitar permisos
de micrófono para esta plantilla.

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
