# Ejemplos para aprender con el emulador

Esta carpeta es hermana de `_template`. Contiene circuitos educativos versionados, separados de las plantillas de creación y de los proyectos personales.

Cada subcarpeta incluye un `project.json` válido y un `README.md` con el objetivo y las predicciones. Los ejemplos no aparecen en la lista de proyectos ni en el selector de plantillas. Desde una lección se crea una copia editable con nombre propio; cambiarla no modifica esta biblioteca.

| Ejemplo | Concepto | Predicción a 5 V |
| --- | --- | --- |
| `ohm` | Ley de Ohm | 1 kΩ → 5 mA, 25 mW |
| `serie` | KVL y potencia | 1 kΩ + 1 kΩ → 2,5 mA, 2,5 V por resistor |
| `paralelo` | KCL | 1 kΩ ∥ 2 kΩ → 5 mA + 2,5 mA |
| `divisor-cargado` | Equivalentes y carga | Salida 1,667 V, fuente 3,333 mA |

Las variantes `ohm-2k`, `serie-desigual`, `paralelo-rama-abierta` y `divisor-sin-carga` permiten comparar los cambios explicados en las lecciones sin tener que reconstruir el circuito.

Los valores corresponden al circuito original energizado en régimen DC. La fuente empieza apagada. La guía de autoría está en `docs/aprendizaje-mdx.md`.
