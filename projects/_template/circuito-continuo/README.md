# Circuito continuo: pulsador → LED, sin código

Una Fuente regulable de 5 V alimenta el ESP32 y, por otro camino, un pulsador en serie con un LED y una resistencia: al apretar el pulsador se cierra el circuito y el LED prende, sin que el código haga nada.

## El circuito

```
Fuente (5 V) ──┬── 5V de la placa          (alimenta el ESP32)
               └── Pulsador ── LED ── Resistencia 150 Ω ── GND
Fuente GND ────── GND de la placa           (referencia común)
```

- El pulsador une sus dos patas (OUT y GND, así se llaman en el módulo) mientras lo
  apretás: para la electricidad es un cable que se cierra.
- Corriente con el pulsador apretado: (5 V − 2 V del LED) / (150 Ω + 15 Ω del LED)
  ≈ 18 mA, dentro de los 20 mA recomendados.

## Para probar

1. Ejecutar (▶). La placa arranca porque la fuente la alimenta por el pin 5V
   ("USB conectado" está apagado a propósito).
2. Apretar el pulsador (en el dibujo o en el panel del módulo): el LED prende.
3. Ventana Debug → Alimentación: la fuente entrega ~120 mA (la placa) y ~138 mA con el
   pulsador apretado (placa + LED).

## Variantes para experimentar

- Sacar la resistencia (cable directo del LED a GND): el LED se quema al apretar.
- Bajar el límite de corriente de la fuente a 100 mA: no alcanza para la placa
  (necesita ~120 mA), la fuente entra en modo CC y la placa no arranca.
- Subir la fuente a 12 V: la placa se quema (su pin 5V aguanta hasta 6 V).
