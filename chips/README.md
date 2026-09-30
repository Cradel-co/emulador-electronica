# Chips custom compartidos

Librería de módulos "hechos a mano" para Wokwi (Custom Chips API) que no existen en su catálogo estándar, pensados para reusarse entre proyectos.

Cada chip vive en su propia carpeta:

```
chips/
└── <nombre-chip>/
    ├── <nombre-chip>.chip.json   # pinout + controles visuales
    ├── <nombre-chip>.chip.c      # comportamiento (se compila a WASM)
    └── <nombre-chip>.chip.wasm   # generado, no editar a mano
```

## Crear un chip nuevo

Ver `../docs/custom-chips.md` para el flujo paso a paso. En resumen:

1. `mkdir chips/<nombre> && cd chips/$_`
2. Escribir `<nombre>.chip.json` (pines) y `<nombre>.chip.c` (lógica, incluye `wokwi-api.h`).
3. Compilar a WASM (Docker con el toolchain de Wokwi, ver docs).
4. Symlinkear los dos archivos fuente en cada proyecto que lo use.

## Pendientes de este proyecto (alarma 433 MHz)

- [ ] `rxb6/` — receptor 433 MHz: expone en `DATA` el tren de pulsos OOK de un código EV1527 elegible desde un control del chip.
- [ ] `stx882/` — transmisor 433 MHz: decodifica lo que le manda `remote_transmitter` y muestra el código resultante.

Están descritos en detalle en `../../IDEA.md`.
