# Acoplamientos de escritura entre representaciones

La API interna `OpcionesSimulacionTemporal.acoplamientos` declara enlaces sobre rutas del grafo
elaborado. No agrega campos al manifiesto ni a Project: el ensamblador debe declarar los enlaces
para la selección concreta, incluidos los IDs derivados del equivalente.

```ts
acoplamientos: [{
  origen: { ruta: ['sensor', 'interior', 'chip'], parametro: 'nivel' },
  destino: { ruta: ['sensor', 'equivalente', 'chip'], parametro: 'nivel' },
}]
```

Cada origen debe ser una hoja exclusivamente funcional y cada destino una exclusivamente eléctrica.
Se exige el mismo contrato de parámetro (tipo, rango, unidad, enum, default) y el mismo valor inicial.
Hay un único destino por origen y un único escritor por destino. No hay ciclos, fan-out, conversiones
ni expresiones ejecutables. Las declaraciones se validan antes de iniciar modelos y se reconstruyen
al reiniciar. Una ruta inexistente o inactiva falla; no se busca otro destino por nombre.

`ponerParametro` valida ambos contratos antes de cambiar valores y solicita una barrera DC en el
instante actual de la agenda compartida. `escribirDigital` conserva sus controles de alimentación,
reset y drive 0/1/Z. El enlace no agrega callbacks ni estampa otro elemento físico. Una escritura
sin enlace desde una hoja solo funcional sigue siendo un error y retira las medidas anteriores.
La fase de observación no puede escribir y un contexto vencido tampoco.

Los enlaces de drive requieren perfiles digitales idénticos y redes comunes de alimentación y reset.
No se permite usar un parámetro genérico para escribir un drive. Al apagar o resetear el origen se
libera también el destino a Z dentro de la estabilización eléctrica. Los temporizadores conservan
las reglas de cancelación por generación. No hay un segundo evento de escritura pendiente que pueda
sobrevivir al reset: el cambio es síncrono dentro del callback y el punto DC sigue en la agenda.

## Alcance

Este paso conecta comportamiento y circuito a nivel cuasiestático. No es aún el reemplazo de esp-emu:
faltan manifiestos portables de acoplamiento, GPIO del SoC, periféricos, ejecución de firmware y la
integración con la aplicación. No modela RF ni transitorios de transistor. Los tests usan ngspice real
con dos capas jerárquicas, drive, reset, pérdida de alimentación, reinicio, rangos y declaraciones
inválidas. No requiere levantar servidores persistentes.

## Verificación

La regresión inicial falló por falta de propiedad eléctrica antes del enlace. Se agregaron siete
casos: drive/reset, drive/alimentación, cuatro rechazos de declaración y parámetro numérico/rango.
La suite completa pasó con `vitest run --maxWorkers 1`: 1927 correctas y 1 omitida en 342,04 s
(179 archivos correctos y 1 omitido). Build de shared, servidor y web, tipos del servidor y
`git diff --check` correctos. Sin E2E ni firmware ESP32: las integraciones ejercitan la API interna
con ngspice real.
