# Volumen con potenciómetro

Un potenciómetro como divisor entre la fuente y un buzzer: al girar el cursor baja la tensión que
le llega y el zumbido se oye más bajo. Nadie programa un volumen — sale de la Ley de Ohm.

## Para probarlo

Apretá **▶** para energizar el circuito (y para que el navegador habilite el audio: no deja
sonar nada sin un gesto del usuario). Después cambiá **Posición del cursor** en el panel de
propiedades del potenciómetro y escuchá la diferencia.

## Qué pasa en cada posición

Medido con el motor (ngspice) sobre esta misma plantilla: potenciómetro de 100 Ω, fuente de 5 V,
buzzer activo de 5 V.

| Posición | Tensión en el buzzer | Consumo | Amplitud | Presión sonora |
|---|---|---|---|---|
| 0 | 4,92 V | 29,7 mA | 0,98 | 84,9 dBA |
| 10 | 4,27 V | 25,7 mA | 0,85 | 83,6 dBA |
| 20 (por defecto) | 3,65 V | 22,0 mA | 0,73 | 82,3 dBA |
| 30 | 3,11 V | 18,7 mA | 0,62 | 80,9 dBA |
| 40 | 2,62 V | 15,8 mA | 0,52 | 79,4 dBA |
| 44 | 2,44 V | 14,7 mA | 0,49 | 78,8 dBA |
| 50 y más | — | 0 mA | — | **no suena** |

De la posición 0 a la 40 se pierden 5,5 dB: es la ley de que la mitad de tensión son 6 dB menos.

## Dos cosas que vale la pena mirar

**No se desvanece: se corta.** Un buzzer activo tiene su propio oscilador, y por debajo de unos
2,4 V no arranca. Así que el volumen baja hasta ahí y después el zumbido desaparece de golpe. Un
buzzer *pasivo* (sin oscilador) se comportaría distinto, pero todavía no está en el catálogo.

**El divisor se carga.** Con el buzzer colgado del cursor la tensión no es la mitad de la mitad:
el buzzer (unos 166 Ω cuando zumba) queda en paralelo con el tramo de abajo del potenciómetro. Por
eso en la posición 50 no hay 2,5 V útiles. Ese efecto no está programado: lo calcula el motor.

## Un límite conocido

Entre las posiciones **45 y 48** el circuito **no se puede resolver** y la app avisa que no hay
solución. No es un error del proyecto: justo ahí el buzzer está en el filo de su umbral, y como al
conducir carga el divisor y baja su propia tensión, el punto de operación se vuelve inestable
(conduce → baja la tensión → deja de conducir → sube → conduce). Un buzzer real en esa condición
chirría o castañetea. Si te pasa, movete unos puntos para cualquier lado.
