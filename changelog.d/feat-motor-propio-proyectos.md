Los proyectos ESP32 MicroPython pueden ejecutar GPIO y temporización con un motor propio en el lienzo habitual, sin esp-emu.

La selección se guarda en Configuración del proyecto. Ejecutar, Parar, Reset, el programa main.py,
los controles y las medidas eléctricas usan el flujo existente. Soporte funcional inicial y
acotado: el código y los periféricos no implementados fallan con diagnóstico, sin fallback.
