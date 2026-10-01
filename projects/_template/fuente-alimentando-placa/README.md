# Placa alimentada por una fuente, interruptor y LED

El ESP32 no está enchufado por USB: lo alimenta una Fuente regulable de 5 V cableada a su pin 5V. Un interruptor en GPIO6 prende y apaga el LED de GPIO7 por código, como en cualquier circuito normal.

## El circuito

```
Fuente (5 V) ── board.5V          (alimenta el ESP32; USB apagado a propósito)
Fuente GND  ── board.GND           (referencia común)

Interruptor ── GPIO6 (pull-up)     → lo lee el firmware
GPIO7 ── LED ── Resistencia 220 Ω ── GND   → el firmware lo prende/apaga
```

A diferencia de la plantilla [`circuito-continuo`](../circuito-continuo/), acá el LED
no prende por corriente directa: lo maneja el código, leyendo el interruptor.

## Para probar

1. Ejecutar (▶). Arranca porque la fuente alimenta el pin 5V (no por USB).
2. Prender el interruptor (en el dibujo o su panel): el LED se enciende.
3. Ventana Debug → Alimentación: la fuente entrega el consumo de la placa (~120 mA),
   un poco más con el LED prendido.

## Variantes para experimentar

- Bajar el límite de corriente de la fuente por debajo de ~120 mA: la placa no
  arranca (modo CC, la tensión cae).
- Subir la fuente por encima de 6 V: la placa se quema.
- Prender el "USB conectado" de la placa: ahora arranca aunque la fuente esté mal
  configurada (dos fuentes de energía independientes).
