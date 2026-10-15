El dibujo y el sonido de un módulo ya no se contradicen (#61).

El umbral estaba declarado en dos lados —el modelo y el `module.json`— y discrepaban: a 2,44 V el
buzzer conducía y el sonido decía silencio. Ahora manda el veredicto del modelo, que tiene la
histéresis y ve la corriente real.
