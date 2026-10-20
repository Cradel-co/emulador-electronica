Los esquemáticos jerárquicos propagan señales digitales y reaccionan a cortes de alimentación y reset por instancia. (#93)

El perfil declara umbrales, rieles y parámetros de drive; el modelo eléctrico conserva la propiedad de las salidas.
Cancela timers de generaciones anteriores, mantiene indeterminadas las entradas flotantes y espera barreras adelantadas.
Agrega un controlador de interrupciones por flancos o niveles, con pendientes, máscaras y reconocimiento por instancia.
Los servicios temporales se cancelan al perder alimentación o activar reset; la recuperación no hereda pendientes.
Es una API interna cuasiestática; todavía no incluye editor ni firmware propio de ESP32.
