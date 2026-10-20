# SDD — Análisis físicos desde la app

Estado: DC/transitorio integrado en #86. Panel térmico RC integrado en #87. AC en implementación. Continuación de etapa 6.

## Alcance

Archivo → Análisis físicos abre un diálogo propio. DC reutiliza el informe de prototipado y sus unidades V/mA/mW; transitorio reutiliza POST analysis/transient y sus unidades s/V/A/W. AC queda para otra entrega; térmico RC se describe en la segunda entrega. No se cambia el solver.

El transitorio es un análisis de diseño con topología y GPIO fijos. No avanza firmware ni reproduce el audio del micrófono; utiliza propiedades persistidas del proyecto, no el overlay vivo de audio. Los avisos del motor se muestran junto al resultado.

## Contexto y vigencia

Antes de ejecutar se guardan cambios. Cada solicitud conserva nombre, revisión persistida, firma de diagrama y generación de vista. Se envía If-Match; el backend comprueba la revisión antes y después de resolver. Cambiar proyecto, editar, cerrar o reemplazar la solicitud impide aplicar respuestas tardías. Un resultado aceptado es una instantánea fechada; la vista señala cuando el circuito cambia y deshabilita su exportación hasta recalcular. Un error retira las medidas anteriores.

## Parámetros y presentación

Duración y paso máximo se expresan en segundos positivos y finitos, paso no mayor que duración y hasta 20000 muestras estimadas. La inicialización puede usar equilibrio DC o condiciones explícitas declaradas por C/L en el proyecto. Esta entrega no edita estímulos PWL ni condiciones iniciales por elemento. Los tiempos adaptativos devueltos por ngspice se conservan; pueden producir hasta 50000 muestras reales, distintas del presupuesto estimado de entrada.

DC muestra medidas por elemento con validez explícita. Transitorio permite elegir tensión de pin referenciada a tierra o tensión/corriente/potencia por elemento. Solo se dibuja una unidad por eje. Pines flotantes omitidos no se convierten en cero. Los valores ausentes producen huecos; las series constantes tienen escala visible. El gráfico reduce puntos para presentación manteniendo extremos por bloque; JSON conserva la respuesta completa.

La exportación JSON identifica proyecto, revisión, fecha, dominio, parámetros y unidades; excluye credenciales y código. Captura, resolución y firmware conservan sus relojes propios.

## Pruebas y salida

Pruebas de parámetros inválidos y presupuesto, series vacías/constantes y reducción con extremos; API rechaza revisión ajena o cambiada durante cálculo. E2E real de circuito RC: curva exponencial y estado DC, descarga y respuesta tardía tras edición. Revisar pantalla grande y angosta. Suite Vitest completa, tipos servidor/web y build antes de publicar PR. La entrega se marca integrada únicamente después del merge del PR.

## Evidencia de esta entrega

Suite completa: 1681 pruebas aprobadas y una omisión existente. Build de producción y typechecks servidor/web pasan. Nueve E2E focalizados de análisis, informe, monitoreo y micrófono pasan; después del ajuste visual y la ampliación del caso de vigencia se repitieron los tres E2E de análisis y los quince tests de parámetros/rutas/gráfico.

El RC real de catálogo y ngspice alcanza aproximadamente 5 × (1 − exp(−5)) V en 5 ms. Se verifican DC, tiempos adaptativos, descarga completa sin credenciales, parámetros inválidos sin solicitud, cierre durante cálculo, edición durante solicitud y bloqueo de exportación tras edición del circuito. Revisión visual a 1600 y 900 px. No se modifica física ni se agrega firmware o hardware nuevo. [Uso del panel](docs/analisis-fisicos.md).

Revisión posterior del PR #86: la vista acepta hasta 50000 muestras adaptativas reales, manteniendo 20000 como presupuesto estimado de entrada. Un test cubre 50000/50001 muestras; suite completa: 1682 pasan y una omisión previa. Tipos del servidor y build pasan.

## Segunda entrega: térmica RC explícita

El modo Térmico reutiliza el transitorio y su modelo `termico-rc-unidireccional`: un cuerpo isotermo por elemento, ambiente fijo, sin realimentación eléctrica ni acoplamiento entre cuerpos. No cambia el solver ni infiere parámetros del catálogo. La primera UI admite un elemento R/S por solicitud; la API conserva su soporte para varios. El modo electro térmico acoplado queda para otra entrega.

Antes de configurar, Identificar elementos solicita un informe DC guardado y vigente. Solo se ofrecen resistencias/contactos disipativos efectivamente presentes en el resultado, nunca C/L. Cambiar circuito invalida esa selección y requiere identificar de nuevo. El usuario declara identificador, fuente, condiciones, resistencia térmica K/W, capacidad J/K, ambiente e inicial °C y rango mínimo/máximo °C. No se rellenan valores físicos inventados. Los modelos son configuración temporal del panel, no se persisten en el proyecto.

El modelo compartido valida finitud, positividad de R/C y su producto, rango ordenado y temperaturas dentro del rango sobre cero absoluto. La solicitud incluye If-Match y conserva las comprobaciones de vigencia del transitorio. El resultado expone temperatura en °C y energía disipada/almacenada/evacuada en J, modelo y tiempos de simulación. Salir del rango genera fallo, sin curva de éxito parcial. Nunca se afirma caracterización experimental.

Criterios: circuito resistivo real con potencia constante contrastado contra T=Ta+P·Rth·(1−exp(−Δt/(Rth·Cth))); unidades/energías y exportación completa; modelos incompletos o fuera de rango, selección inválida, cierre/edición durante cálculo. Tipos, build, suite completa y E2E del panel y DC/transitorio antes del PR.

La validación del resultado conserva temperaturas emparejadas con el reloj del transitorio y rechaza elementos que no sean R/S o temperaturas fuera del rango. Los contratos térmicos compartidos se reutilizan en la ruta y la vista; el cálculo existente conserva su implementación.

### Evidencia de la segunda entrega

1694 tests unitarios pasan, una omisión previa; tipos servidor/web y build de producción pasan. Cinco E2E de DC, transitorio y térmico pasan. La resistencia real de catálogo con fuente CV/CC se compara contra las cotas analíticas de temperatura para sus potencias mínima/máxima; la potencia resuelta varía levemente por tolerancias numéricas, por lo que no se la supone exactamente constante. Se verifican energía y unidades, modelo completo en JSON, proyecto conservado, formulario vacío, fallo al exceder el rango y respuesta tardía tras edición. Revisión visual a 1600 y 900 px. Los parámetros térmicos del test son sintéticos y se identifican como tales. No se agrega firmware ni se prueba hardware físico.

## Tercera entrega: AC de pequeña señal

La vista AC agrega un barrido logarítmico con una fuente de tensión explícita, entrada y salida
referidas a tierra física verificable. Identificar circuito enumera fuentes V de módulos source
activos y pines representados; editar el proyecto invalida la selección. La excitación AC normalizada
es 1 V con fase 0 sobre la fuente o referencia de tensión existente, conservando su valor DC y
las limitaciones CV/CC. La transferencia se calcula con la tensión real de entrada, no asumiendo
que una fuente limitada entrega exactamente 1 V. Las restantes fuentes conservan DC sin excitación AC.

Parámetros: inicio/fin positivos, fin mayor que inicio, 1..1000 puntos por década enteros, hasta
10000 frecuencias y presupuesto de 1000000 valores reales del adaptador. El motor comparte el worker
terminable con DC/transitorio. Ninguna solicitud admite SPICE arbitrario. El resultado conserva
frecuencias efectivas (ngspice reparte pasos entre ambos extremos también en décadas fraccionarias), fasores entrada/salida y transferencia (real/imaginaria), ganancia
20 log10(|Vout/Vin|) en dB y fase principal en grados (-180..180). Transferencia nula: ganancia
y fase null, con hueco gráfico; entrada nula o insuficiente genera fallo sin medidas inventadas.
No se calcula potencia instantánea ni dBA desde fasores.

Dos gráficos de Bode con eje horizontal logarítmico Hz y unidades independientes dB/grados. Exportación
JSON sin reducción con parámetros, advertencias, unidades, revisión y fecha. Se reutilizan guardado,
If-Match antes/después, cancelación y bloqueo de exportación obsoleta. Configuración temporal del panel.
No ejecuta firmware, no captura micrófono y no representa saturación, distorsión ni conmutación digital.
Ngspice linealiza alrededor del punto DC; la validez depende de los modelos declarados.

Salida: pruebas analíticas RC/RL, extracción compleja inválida/incompleta, presupuesto, fuente/pin
ajenos o flotantes, revisiones cambiantes y cero de transferencia. E2E real RC con descarga y curvas,
invalidación y cancelación; revisión visual escritorio/angosta. Suite completa, tipos server/web y
build antes de publicar PR. Integración solo después del merge.

Evidencia AC: 1704 tests unitarios aprobados, una omisión existente; ocho E2E de los cuatro
modos pasan. Typechecks server/web y build de producción correctos. RC verifica -3,0103 dB y
-45° en el corte y cada fasor contra la fórmula; RL valida la fuente limitada y la normalización
real. El caso de décadas fraccionarias valida ambos extremos del ngspice usado. Se comprueban
edición durante respuesta, selección invalidada, cierre/cancelación y exportación obsoleta.
Revisión visual a 1600 y 900 px; fase en eje propio y etiquetas Hz sin recorte. Sin hardware ni
firmware nuevo. Estado: implementado en rama, todavía sin merge.
