Los módulos se prueban a sí mismos y se pueden fabricar: tests.json, parte (MPN), esquemático y huella de KiCad, y los modelos migran a model.ts. (#90)

El banco de pruebas corre cada caso con el motor eléctrico real y compara con lo declarado; un módulo sube de nivel (dibujo → simula → probado → fabricable) a medida que suma esos datos.

El servidor conserva un único registro de cada ruta de placas y módulos. El banco rechaza una simulación sin resolver, incluso en la prueba de humo, y conserva el diagnóstico al impedir su importación.
