# SDD: optimización del decodificador JPEG para ArduCAM y TFT

**Estado:** salida directa implementada en la rama de trabajo; equivalencia validada en CPython; rendimiento MicroPython aún pendiente de medición repetible.
**Base:** [SDD-ARDUCAM-TFT.md](SDD-ARDUCAM-TFT.md), ESP32-S3, MicroPython y esp-emu.
**Validación:** pruebas deterministas y recorrido completo en localhost.
**Dependencia:** [PR #53](https://github.com/Cradel-co/emulador-electronica/pull/53), rama `feat/arducam-tft-implementation`, abierto al revisar este plan.

## 1. Problema observado y evidencia

El usuario confirmó una captura completa con esta medición de `cam-view/main.py`:

```text
Tiempos ms: captura=663 hash=0 decodificacion=14964 TFT=111 total=15738
```

| Etapa | Tiempo informado | Proporción del total |
|---|---:|---:|
| Captura y recepción del JPEG por firmware | 663 ms | 4,2 % |
| SHA-256 | 0 ms | por debajo de la resolución informada |
| JPEG a RGB565 | 14.964 ms | 95,1 % |
| Escritura de TFT | 111 ms | 0,7 % |
| Ciclo, sin la pausa posterior | 15.738 ms | 100 % |

Esta es una observación, no una distribución de rendimiento ni un benchmark reproducible:
no se conservó junto con ella el JPEG exacto, la carga del host ni la versión del emulador.
El valor cero de SHA-256 no demuestra costo nulo. La etapa «captura» agrupa la solicitud,
la webcam, la normalización del backend, la espera de disponibilidad y la lectura de FIFO;
no permite atribuir sus 663 ms a una operación particular.

El programa añade `time.sleep_ms(1000)` después de completar el ciclo. Con esta muestra,
el intervalo aproximado es 16.738 ms, unos 0,06 cuadros por segundo. La pausa es de un
segundo; actualmente no hay garantía de una captura por segundo. Se registran también
tiempos de reloj del host. La muestra inicial usa `time.ticks_ms()`; la plantilla actual usa
`time.ticks_us()` para reducir el redondeo. Esos relojes del firmware y el tiempo observado
por el usuario se registran por separado, sin asumir que sean equivalentes en esp-emu.

Después de optimizar el recorrido reducido, el usuario informó otra muestra:

```text
Tiempos ms: captura=589 hash=0 decodificacion=5269 TFT=120 total=5979
```

Frente a la muestra inicial, la decodificación observada bajó aproximadamente 64,8 % y el
ciclo medido (sin la pausa posterior) duró 5.979 ms. Con el `sleep_ms(1000)` actual, el
intervalo observado entre ciclos sería de unos 6.979 ms. Son dos ejecuciones informadas por
el usuario, no un benchmark controlado ni un rango esperado de rendimiento físico. La cifra
de captura sigue incluyendo espera de solicitud, navegador, backend y entrega/lectura de la
FIFO; no es el tiempo de codificación JPEG.

## 2. Análisis de la implementación

La fuente versionada es `app/server/src/templates/jpegDecoder.ts`. `ProjectStore` genera
`jpeg.py` al crear una plantilla ArduCAM + TFT. El proyecto local `cam-view` conserva su
propia copia: cambiar la plantilla no actualiza proyectos ya creados.

El recorrido actual consta de:

1. Validar cabeceras y construir tablas de cuantización y Huffman.
2. Leer secuencialmente las unidades MCU del JPEG y sus bloques por componente.
3. Decodificar coeficientes DC/AC y reconstruir muestras.
4. Recorrer los píxeles de origen, reducir coordenadas, convertir YCbCr a RGB y escribir RGB565.

### Hallazgos confirmados por el código

- En 320 × 240 → 128 × 96, ambas dimensiones de salida son menores que la mitad de las
  originales. `frecuencias_u` y `frecuencias_v` valen 1. El camino de reconstrucción usa
  solamente el coeficiente DC, equivalente al promedio del bloque; la IDCT completa no
  es el cálculo que se ejecuta en este caso.
- `_bloque` sigue reservando 64 coeficientes y calculando amplitudes, extensiones de signo
  y cuantizaciones AC que este modo no usa. Devuelve una lista de 64 valores idénticos.
- El recorrido de salida visita 76.800 posiciones de origen aunque solo devuelve 12.288
  píxeles. Repite cálculos de coordenadas, búsquedas de componentes, listas temporales,
  conversión de color con decimales y escrituras sobre las mismas posiciones de destino.
- `_simbolo` busca cada código Huffman bit a bit mediante claves de tupla en un diccionario.
- Reducir la salida no permite omitir arbitrariamente bytes comprimidos: los códigos AC
  siguen siendo necesarios para localizar los siguientes bloques y mantener sincronización.

Estas observaciones identifican trabajo evitable. La medición disponible no separa su costo:
no prueba todavía si domina la lectura Huffman, el armado de bloques o la conversión de salida.
El primer entregable técnico será esa separación de tiempos.

### Cobertura existente y brechas

`jpegDecoder.test.ts` ejecuta la plantilla con CPython y compara algunos píxeles de JPEG
de cuatro colores contra `sharp`. Comprueba tamaño reducido, truncamiento, progresivo y
límites. Esto verifica parte de la corrección, pero no mide rendimiento en MicroPython,
ni cubre suficientemente bordes entre bloques, redondeo de escala o todos los submuestreos.

El e2e de ArduCAM + ST7735 usa esp-emu, una fuente sintética y comprueba colores y bandas
negras, incluyendo una segunda captura. No exige actualmente equivalencia de toda la
salida RGB565 ni reporta los tiempos internos del decodificador.

## 3. Objetivo, alcance y restricciones

Reducir el tiempo de decodificación sin alterar el JPEG recibido por SPI, su SHA-256,
el contrato del driver ni el encuadre RGB565 big-endian de 128 × 96 centrado en la TFT.
La primera etapa conservará exactamente los bytes de salida del modo reducido actual.
Se mantendrá la calidad DC aproximada; recuperar detalle fino con IDCT completa será otro hito.

La implementación seguirá siendo MicroPython estándar generado desde TypeScript. No se
introducirá conversión de imágenes en el backend, un protocolo RGB privado ni una API
especial del emulador. El uso en una placa física seguirá requiriendo validación propia.

Se preservarán el procesamiento secuencial, los límites de dimensiones y las validaciones
de formato. La salida mantiene 24.576 bytes. No se reservará una imagen RGB completa de
320 × 240; solo JPEG de entrada, tablas, salida, mapas acotados y bloques de la MCU actual.

La captura, los buses y la TFT permanecerán fuera de la primera optimización: juntos
representan menos del 5 % de la muestra informada. El cambio de cadencia se evaluará
después, porque la pausa de un segundo también condiciona la frecuencia final.

## 4. Diseño por etapas

### A. Caracterización y medición reproducible

- Conservar una referencia del algoritmo previo en el arnés de pruebas, como contenido
  Python dentro de una fuente `.ts`, independiente de la plantilla que se optimizará.
- Generar y conservar JPEG deterministas de color uniforme, bordes entre bloques,
  gradiente y textura con abundantes coeficientes AC; registrar su SHA-256 y tamaño.
  Incluir una foto real congelada de forma local, sin versionarla por defecto.
- Ejecutar el mismo JPEG antes y después en MicroPython ESP32-S3 con el mismo firmware,
  esp-emu, host y configuración. Excluir importación y arranque de la ventana de decodificación.
- Registrar una ejecución de calentamiento y al menos cinco medidas útiles por fixture:
  tiempos, mediana, dispersión, memoria libre antes/después y mínimo observado cuando sea viable.
  Si hay variación importante, ampliar la muestra antes de decidir.
- Medir cabeceras/tablas, lectura y reconstrucción de bloques, conversión/escritura de salida
  y total. El perfil detallado será optativo, acumulará por MCU y emitirá al finalizar;
  no imprimirá ni leerá el reloj por bit o por píxel. Comparar con el total sin instrumentación.
- Usar CPython para corrección; la mejora de velocidad se aceptará con mediciones de MicroPython.

### B. Salida directa a resolución TFT

Se incorporará un camino específico para reducción DC en ambos ejes. Por cada MCU ya
decodificada se procesarán únicamente las coordenadas de destino que le correspondan.
Cada píxel de salida se convertirá y escribirá una vez. Se conservará inicialmente la
misma fórmula de color y redondeo para aislar la mejora del recorrido.

El código actual conserva la última muestra de origen que sobrescribe cada píxel. Para
reproducir ese resultado, los mapas de destino a origen usarán, en dimensiones reducidas:

```text
sx = ((dx + 1) * ancho_origen - 1) // ancho_destino
sy = ((dy + 1) * alto_origen - 1) // alto_destino
```

Esto elige la última posición cuyo mapeo original llega a `(dx, dy)`. Elegir el centro o
la primera muestra sería un cambio visual en bordes, por lo que no se hará en esta etapa.
Los mapas se calcularán una vez por imagen y se repartirán por MCU sin reexaminar toda
la salida por cada MCU. Se verificarán los bordes y MCU parciales.

El trabajo de conversión de salida baja de 76.800 a 12.288 posiciones, una reducción de
6,25 veces en esa parte, no una promesa de acelerar 6,25 veces el decodificador completo.
La decodificación de entropía permanece secuencial. Los modos de resolución completa,
reducción en un solo eje y otros tamaños conservarán el camino existente hasta contar
con caracterización específica.

### C. Bloques DC compactos

Para el mismo modo reducido, representar cada bloque con un valor DC escalar, evitando
listas de coeficientes y 64 muestras idénticas. Se mantendrán los predictores DC por
componente y los chequeos de categorías, corridas y truncamiento.

Los símbolos AC se seguirán leyendo para respetar límites de bloque. Sus bits de amplitud
se consumirán sin extensión de signo ni cuantización si no contribuyen a la salida.
El lector debe preservar el escape `FF 00` y detectar fin prematuro y marcadores inesperados.
Una operación de omisión acotada podrá añadirse al lector solo acompañada por pruebas de
esos casos. No se saltarán segmentos comprimidos sin analizarlos.

Se podrá reutilizar el RGB565 para muestras de color idénticas dentro de una MCU si el
perfil muestra un costo relevante. La reutilización será acotada, sin una caché creciente
durante sucesivas capturas.

### D. Conversión entera y Huffman, condicionadas a las mediciones

Después de B y C, repetir el perfil. Solo implementar las optimizaciones cuyo costo siga
siendo relevante:

- Conversión YCbCr con enteros en punto fijo, saturación y redondeo explícitos. Esta etapa
  puede cambiar el último bit RGB565 por redondeo; comparar toda la salida contra el
  algoritmo previo y exigir, como máximo, un nivel del canal RGB565 por componente,
  sin diferencias en posición, orientación ni saturación de colores límite.
- Tabla Huffman rápida para prefijos cortos con camino de respaldo para códigos de hasta
  16 bits. Acotar memoria por tabla; comprobar equivalencia de símbolos, códigos largos,
  escape de bytes, datos truncados y códigos inválidos. Se rechaza una mejora que altere
  errores o acepte silenciosamente JPEG corruptos.

Cada cambio tendrá su medición y podrá descartarse de manera independiente si no mejora
MicroPython o empeora memoria. No se añadirán ambas técnicas sin evidencia.

### E. Cadencia y aplicación al proyecto existente

Con el decodificador validado, definir un intervalo objetivo entre inicios de captura.
Si se mantiene el objetivo de un segundo, calcular `max(0, 1000 - tiempo_del_ciclo)` con
`time.ticks_diff`. Si procesar tarda más, comenzar el siguiente ciclo al finalizar,
sin solicitudes paralelas ni una cola de fotografías viejas.

Esto elimina la pausa adicional cuando el procesamiento ya supera un segundo, pero no
garantiza 1 FPS. La consola informará procesamiento e intervalo real. El panel conserva
su fotografía JPEG; la TFT representa ese cuadro después de decodificarlo y transmitirlo.

Actualizar `cam-view/jpeg.py` y, si cambia la cadencia, `cam-view/main.py` desde las plantillas
TypeScript. Antes, comparar sus copias con el código de referencia y preservar modificaciones
propias del usuario. Verificar el archivo servido y el contenido del editor, no solo el
archivo de plantilla. Los proyectos nuevos recibirán el código actualizado automáticamente;
los antiguos no se sobrescribirán de forma masiva.

## 5. Plan de TDD y validación

| Grupo | Comprobación | Evidencia requerida |
|---|---|---|
| Caracterización | Referencia anterior y fixtures con bordes, gradientes, textura, grises, submuestreo admitido y MCU parciales | RGB565 completo reproducible, no solo cuatro puntos |
| Camino reducido | 320 × 240 → 128 × 96, mapeo de última muestra y otras reducciones en ambos ejes | Igualdad byte a byte para B/C |
| Compatibilidad | Resolución completa y reducción solo horizontal o vertical | Resultado del camino previo sin regresión |
| Fallos | Baseline truncado internamente conservando SOI/EOI, tablas inválidas, códigos/corridas inválidos, progresivo y límites | Error explícito y ninguna escritura parcial en TFT |
| Entropía | AC descartados, escape FF 00, códigos Huffman largos y predictor DC | Mismos símbolos, límites y errores que la referencia |
| Color | Saturación, RGB565 big-endian y redondeo | Exactitud B/C; tolerancia acotada solo para D si se adopta |
| Rendimiento | Misma entrada congelada y ejecución secuencial en esp-emu | Medianas, dispersión, memoria y reloj del host antes/después |
| Integración | Fuente sintética → JPEG/FIFO → MicroPython → ST7735 | SHA del JPEG conservado, RGB565 esperado y bandas negras |
| Actualización | Dos cuadros diferentes sin captura manual y múltiples ciclos | TFT cambia, sin crecimiento sostenido de memoria tras recolección |
| Localhost | Webcam real y proyecto `cam-view` actualizado | Tiempos por etapa visibles, intervalo medido e imagen reconocible |

Los tests de caracterización se escribirán y pasarán antes de cambiar el algoritmo. Luego
se añadirán pruebas de los nuevos caminos que fallen por ausencia del comportamiento.
Las comprobaciones estructurales de límites pueden ser deterministas; el benchmark de tiempo
real será un reporte separado para evitar fallos de CI por carga del host.

El RGB565 de referencia reproduce la aproximación DC existente. La comparación con `sharp`
seguirá verificando orden y colores, pero no exigirá igualdad con una IDCT completa: esa
imagen contiene detalle que la versión actual descarta. El JPEG/hash del panel tampoco
se comparará directamente con el hash del RGB565, porque son representaciones distintas.

## 6. Secuencia de trabajo y archivos

| Entrega | Trabajo | Archivos principales | Condición de avance |
|---|---|---|---|
| 1 | Referencia, fixtures y arnés de medición MicroPython | `templates/jpegDecoder.test.ts`, nuevo arnés `.ts` de benchmark | Baseline reproducible y pruebas de caracterización en verde |
| 2 | Salida directa y mapeo reducido | `templates/jpegDecoder.ts` y tests | Igualdad de toda la salida y medición comparativa |
| 3 | DC escalar y consumo AC validado | Mismos archivos | Sin regresión de errores, salida ni memoria |
| 4 | Enteros/Huffman según perfil | Mismos archivos y benchmark | Mejora demostrada y tolerancia de color aprobada por los tests |
| 5 | Cadencia, generación y recorrido integrado | `templates/arducamTft.ts`, `projectStore.test.ts`, `tests/e2e/arducam.spec.ts` | Dos cuadros verificables y tiempos visibles |
| 6 | Sincronizar `cam-view`, documentación y PR | Proyecto local, SDD, README y README de plantilla | Verificación localhost y reporte final |

Las rutas `templates/*` corresponden a `app/server/src/templates/`; el e2e a `app/tests/e2e/`.
El arnés se ubicará junto a los tests de servidor y reutilizará `EmulatorManager` y el
manifiesto MicroPython, como la integración existente de imports. Su ejecución será optativa
y usará firmware instalado; la falta de esp-emu se reportará como validación pendiente.
Todo código versionado nuevo o modificado será `.ts` o `.tsx`; las fuentes Python de
referencia y las del firmware se mantendrán en plantillas TypeScript.

## 7. Criterios de aceptación y metas

1. B/C mantienen todos los bytes RGB565 del camino reducido caracterizado, el JPEG original,
   su SHA-256, el encuadre y la comunicación SPI normal.
2. Los errores cubiertos siguen siendo explícitos y un fallo de decodificación conserva
   la última imagen TFT confirmada, sin comenzar un dibujo parcial.
3. La memoria no incorpora una imagen RGB de origen ni crece de forma sostenida tras
   múltiples capturas y recolección; se reportan las mediciones antes/después.
4. **Meta inicial propuesta:** reducir al menos 50 % la mediana de decodificación frente
   al algoritmo anterior en los fixtures representativos sobre el mismo MicroPython/esp-emu.
   Si no se alcanza, documentar el perfil restante y revisar el alcance; no declarar cumplida
   la meta únicamente por mejorar en CPython. Esta meta no garantiza un segundo por cuadro.
5. Reportar velocidad y dispersión para imágenes simples y con textura; investigar cualquier
   regresión repetible antes de entregar. Publicar también el intervalo real entre cuadros.
6. `cam-view` usa la versión nueva servida al navegador y completa dos cuadros distintos
   con la webcam real en localhost. La prueba física seguirá pendiente hasta ejecutarla.
7. Completar Vitest, typechecks de servidor/frontend/shared, build web y e2e pertinentes.
   Un e2e omitido por falta de motor no se presentará como aprobado.

## 8. Dependencias, riesgos y entrega

Al revisar los PR abiertos, el #53 contiene el decodificador, la plantilla, sus tests y
el e2e de TFT. La implementación de esta optimización debe partir de esa rama mientras
siga abierta, con PR hacia ella; si se mergea antes, partir de `origin/main` actualizado.
El [PR #54](https://github.com/Cradel-co/emulador-electronica/pull/54) cambia alimentación
y puente de chips. No necesita modificarse para optimizar el decoder, pero el e2e completo
deberá volver a comprobar alimentación y captura al integrar ambas ramas.

El árbol local contiene cambios previos de cámara, panel, tests y documentación. Se deben
preservar y separar de los commits de optimización. El agente no mergeará el PR sin una
solicitud explícita del usuario.

Los riesgos principales son desplazar muestras en bordes al cambiar el recorrido, desalinear
el bitstream al descartar amplitudes AC, diferencias de redondeo de color y exceso de tablas
en memoria. Los contratos de equivalencia, fallos y memoria anteriores cubren cada caso.
La instrumentación y la carga del host también pueden sesgar tiempos, por eso se medirá
con entradas congeladas, ejecución secuencial y total sin perfil detallado.

La entrega incluirá resultados antes/después por fixture y en `cam-view`, versiones del
motor/firmware, límites de calidad DC y los checks ejecutados. Primero se optimiza la
decodificación; video continuo, IDCT completa y otras resoluciones quedan como trabajos
posteriores, que requerirán sus propios objetivos y mediciones.

## 9. Referencias locales

- [Decodificador y generación MicroPython](app/server/src/templates/jpegDecoder.ts).
- [Pruebas actuales del decodificador](app/server/src/templates/jpegDecoder.test.ts).
- [Programa TFT y tiempos por etapa](app/server/src/templates/arducamTft.ts).
- [Generación de proyectos](app/server/src/projectStore.ts).
- [Integración ArduCAM/TFT](app/tests/e2e/arducam.spec.ts).
- [Ejemplo de ejecución MicroPython real](app/server/src/micropythonImports.integration.test.ts).
- [Flujo de ramas y PR](CLAUDE.md).

## 10. Avance y verificación

La primera medición disponible sigue siendo la captura del usuario en `cam-view` indicada
en la sección 1; falta un JPEG congelado de esa captura para reproducirla exactamente.
Como referencia de corrección se añadió un hash SHA-256 del RGB565 completo para el
fixture determinista de cuatro cuadrantes. También se añadió una comparación diferencial
con el recorrido anterior en un JPEG sintético texturado.

La etapa B está implementada en `jpegDecoder.ts`: cuando ambas dimensiones se reducen al
menos a la mitad, escribe directamente los 12.288 píxeles destino por MCU. Los otros tamaños
siguen recorriendo el código previo. La copia local `projects/cam-view/jpeg.py` ya se
sincronizó desde esta plantilla. Las pruebas JPEG y ST7735 pasan: siete tests. La prueba
texturada verifica byte por byte la igualdad con el recorrido anterior; la de cuadrantes
comprueba el hash fijo de sus 24.576 bytes RGB565.

Se probó crear una referencia de tiempo en esp-emu con repeticiones automáticas. En más de
seis minutos de reloj de pared, el fixture sencillo llegó a cuatro resultados y no terminó
la ventana de medición; el reloj MicroPython marcó cerca de diez segundos por decodificación.
No se presenta esa corrida incompleta como medida. El benchmark automatizado queda aplazado
hasta contar con un ciclo medible en la aplicación y no se agrega al conjunto de tests de CI.
La meta de velocidad del 50 % aún no se ha comprobado; el hash diferencial acredita solo
corrección. No se midió todavía la etapa C (bloques DC compactos).

El SDD principal corrige la afirmación anterior de «una foto por segundo»: la plantilla
espera un segundo después de cada ciclo, y el tiempo de decodificar se suma a esa pausa.
Pasaron `jpegDecoder.test.ts` y `st7735MicroPython.test.ts` (7 tests), el typecheck del
servidor y `git diff --check`.

Para separar la latencia observada, el panel de cámara ahora mide la copia del fotograma,
la espera de `canvas.toBlob()` (codificación JPEG del navegador), la validación/decodificación
JPEG del backend y el transcode de normalización (`sharp`, que decodifica, redimensiona y vuelve
a codificar). También informa el POST completo y el tiempo residual aproximado fuera de Sharp;
ese residual agrupa red, enrutado y otro trabajo del servidor, no es una medición pura de red.
El programa MicroPython usa `ticks_us()` para informar captura, hash, decodificación y TFT con
resolución submilisegundo. En hardware físico solo aplicarán las medidas del firmware: el sensor
OV2640 sustituye al codificador del navegador y el backend de emulación desaparece.
