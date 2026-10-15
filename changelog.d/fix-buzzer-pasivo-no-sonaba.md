El buzzer pasivo ya suena: el motor no sabía que su pin era una salida (#66).

Dos causas encadenadas. `direccionesDeCodigo` no reconocía `machine.PWM` —sin `Pin.OUT` y con una
constante—, así que el pin quedaba sin manejar y medía 0 V. Y el registro `GPIO_OUT` que muestrea
el puente informa 0 para un pin que maneja el LEDC, porque lo maneja por la matriz de periféricos.
