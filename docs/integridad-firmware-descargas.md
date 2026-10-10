# Integridad de firmware y descargas acotadas

Tercera entrega de la etapa 4 de [consolidación](../SDD-CONSOLIDACION.md).

## Caché MicroPython

`ensureMicropythonFirmware` comparte una promesa por ruta dentro del proceso y la retira tanto
al terminar como al fallar. Cada uso comprueba SHA-256 del binario contra el archivo `.sha256`
conservado, incluido el nombre del binario. Una referencia inválida o un contenido distinto
produce un error y no se reemplaza automáticamente la referencia ni el binario.

La primera descarga completa y no vacía fija la huella (TOFU, confianza en el primer uso).
Esto detecta corrupción posterior; no autentica el origen del primer archivo. Cambiar URL
sin cambiar nombre no invalida una caché verificada ni fija una referencia nueva.

Una caché histórica **sin huella se rechaza**. Para recuperarla, con las corridas detenidas,
retirá o mové el binario que indica el error y volvé a ejecutar. La descarga necesita internet
y crea una referencia nueva; no se genera una huella a partir del archivo histórico. Si hay
una huella válida y falta el binario, la descarga debe coincidir con la referencia conservada.
Ante corrupción, conservá la referencia y retirá el binario para intentar recuperar los bytes
originales. Eliminar también la referencia inicia otra confianza de primer uso y pierde esa evidencia.

La referencia se publica primero, mediante escritura atómica, y después el binario también
mediante escritura atómica. Una interrupción entre ambos deja una referencia sin binario;
el reintento debe coincidir con ella. No es una transacción de dos archivos ni se promete
`fsync`, durabilidad ante pérdida de energía o coordinación entre procesos. Los archivos
`.download` históricos no se consideran una caché válida ni se borran indiscriminadamente.

## Presupuestos de descarga

`descargaAcotada.ts` se comparte entre importación de módulos y firmware:

| Consumidor | Máximo | Tiempo total |
|---|---|---|
| Importador de módulos | `LIMITES.descarga` (15 MiB) | `LIMITES.timeoutMs` |
| Firmware MicroPython | 16 MiB | 120 segundos |

Sólo admite HTTPS y comprueba el protocolo de la respuesta final. Los errores HTTP y un
Content-Length excesivo cancelan el cuerpo. El tamaño real se cuenta durante la lectura,
incluso sin Content-Length, con un valor menor al real o tras descompresión HTTP. Al exceder
el presupuesto se cancela el lector y se aborta la petición; no se espera el resto del cuerpo.
El plazo también abarca la lectura de un cuerpo que deja de enviar datos.

Los consumidores reciben bytes completos sólo después de terminar dentro del presupuesto.
El importador conserva sus límites adicionales de ZIP y archivos. La descarga acotada usa
memoria para los bloques admitidos y el resultado concatenado; no es un archivo en streaming
ni un límite exacto de memoria RSS. El transporte puede entregar un bloque que exceda el límite
antes de que se rechace. No se agrega validación semántica del formato del firmware ni firma
del proveedor, y HTTPS no sustituye una política de acceso a destinos de red.

## Evidencia

Tres regresiones fallaron antes del cambio: caché corrupta, caché sin huella y cancelación
chunked en el importador. Las pruebas finales cubren primera referencia, caché válida,
referencia malformada, recuperación con referencia conservada, descarga interrumpida y vacía,
límite exacto, cabecera excesiva o engañosa, timeout del cuerpo, error HTTP, concurrencia y reintento.
Los ensayos usan respuestas y streams reales de Node con un fetch inyectado, sin depender
de Internet ni del proveedor. No acreditan ejecución de firmware nuevo en Docker ni hardware físico.
