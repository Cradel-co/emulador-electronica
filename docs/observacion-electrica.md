# Observación eléctrica compartida

REST (`GET /api/projects/:name/pins`), MCP (`ver_proyecto` y `leer_pines`) y la interfaz
usan la observación del motor DC. Un GPIO HIGH es una condición de entrada del cálculo,
no una prueba de conducción. No se cambiaron las ecuaciones ni los modelos del catálogo.

## Contrato

La propiedad `electrico` conserva LEDs, fuentes, alimentación, tensiones, medidas,
estados visibles y sonidos, y añade:

- `contexto.proyecto` y `contexto.placas`: identidad del circuito y sus placas.
- `contexto.corrida`: generación de ejecución del servidor; no persiste entre reinicios.
- `contexto.revision`: huella del circuito y de sus perfiles eléctricos. No incluye credenciales Wi-Fi.
- `contexto.topologia`: firma de módulos, propiedades, entorno y cables. Mover o rotar el dibujo no la cambia.
- `estado`: `valida`, `no-resuelta` u `obsoleta`; `resuelto` sólo es true para una observación resuelta y vigente.
- `nivelesPorPlaca`: GPIO reportados por firmware, separados por id de placa. Un GPIO ausente es desconocido.

El nivel efectivo que el motor usa para PWM se conserva separado de ese registro del firmware.
Los GPIO y PWM se copian antes de los awaits de la consulta, de modo que la luz y el sonido
se calculan con las mismas condiciones. Cada pedido calcula una instantánea; dos pedidos
sucesivos pueden diferir si el firmware o el circuito cambian. No se agrega una cosimulación
con reloj común ni una historia temporal de corriente.

## Lecturas y ausencia de datos

`leer_pines` acepta `{ "proyecto": "mi-proyecto" }`, incluso si ese proyecto está detenido.
Sin argumento usa el proyecto que corre o el circuito sin placa energizado. Sin ninguno
retorna `proyecto: null`, sin niveles ni salidas inventadas.

`modulosDeSalida[].encendido` es true o false si existe una observación física; es null
si faltan datos, falló el cálculo o cambió el contexto. La corriente del LED es autoritativa:
el indicador se enciende sobre 0,5 mA, con el mismo umbral visual que ya usaba la UI.
Para otras salidas se usa `ui.on` del modelo; no se deduce su estado de un cable o de HIGH.
`corrienteMa` y `riesgo` también pueden ser null. El riesgo no es daño permanente.

Se conservan `niveles` (alias de la primera placa), `gpio` y `sinAlimentar` por compatibilidad.
`gpiosPorPlaca` identifica las conexiones del pin de interfaz declarado en circuitos multiplaca. Esos metadatos de
cableado no certifican alimentación ni deciden el encendido. `estado` fuera de `electrico`
sigue siendo el estado global del emulador; no describe la ejecución del proyecto pedido.
`ver_proyecto` publica `electrico` completo, además de los campos anteriores.

Una tensión válida de 0 V aparece como cero. Un pin sin medida no se agrega con cero.
Si la observación falla o queda obsoleta, se retiran LEDs, tensiones, mediciones, fuentes,
estados visibles, sonidos y niveles: no se presentan las medidas anteriores como actuales.
Los diagnósticos del solver fallido se conservan en `warnings`.

## Vigencia

El servidor comprueba la generación de ejecución, el estado de energía, el guard de recarga
existente y la huella del proyecto después del cálculo. Cambiar energía o controles invalida
las consultas pendientes, incluso si luego se vuelve al valor anterior. No se aplican estados
internos de módulos provenientes de un cálculo obsoleto. Un cambio de topología detectado
produce `estado: "obsoleta"` y pide una lectura nueva.

MCP comprueba que la observación corresponde al proyecto y al circuito que está describiendo.
La UI comprueba proyecto, topología y su revisión de solicitud; al editar conexiones o
propiedades retira la lectura anterior antes del guardado y silencia las voces anteriores
sin cerrar el contexto de audio. Los movimientos visuales conservan
la observación. Un guardado fallido deja la medida inválida hasta obtener una observación
que corresponda al circuito mostrado.

Estos guards protegen las consultas eléctricas. No son control de concurrencia de escritura
entre clientes, una transacción global de archivos o un mecanismo de autenticación.

## Evidencia

Hay regresiones MCP que fallaban con la deducción GPIO=HIGH. Las pruebas con el motor real
cubren LOW activo, GPIO opuestos y equipotenciales, falta de energía y GPIO7 en dos placas.
Una integración contra servidor real compara REST, MCP y el indicador compartido con y sin
energía. Los tests de vigencia cubren recarga, cambio de generación, fallo y cero voltios.
Los E2E comprueban el retiro inmediato de medidas al editar y el rechazo de otro proyecto.
No se ejecuta firmware real nuevo en estos E2E ni se acredita calibración experimental.
