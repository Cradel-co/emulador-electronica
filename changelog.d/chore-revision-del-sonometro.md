El sonómetro queda revisado con el firmware corriendo, y sus avisos ahora tienen test.

Los tres casos de riesgo andan: fuera del dominio declarado el ADC rechaza en vez de inventar una
cuenta, un GPIO sin canal da `SIN_MODELO_CANAL`, y alimentado con 2,5 V el sensor no alcanza el
fondo de escala —informa 115 dBA con la escena en 130— y la app lo avisa en vez de mentir en
silencio. Ese aviso no estaba cubierto por ningún test.
