# SDD — Análisis físicos desde la app

Estado: diseño del bloque DC/transitorio; implementación y validación en curso. Continuación de etapa 6.

## Alcance

Archivo → Análisis físicos abre un diálogo propio. DC reutiliza el informe de prototipado y sus unidades V/mA/mW; transitorio reutiliza POST analysis/transient y sus unidades s/V/A/W. AC y térmico se entregan después. No se cambia el solver.

El transitorio es un análisis de diseño con topología y GPIO fijos. No avanza firmware ni reproduce el audio del micrófono; utiliza propiedades persistidas del proyecto, no el overlay vivo de audio. Los avisos del motor se muestran junto al resultado.

## Contexto y vigencia

Antes de ejecutar se guardan cambios. Cada solicitud conserva nombre, revisión persistida, firma de diagrama y generación de vista. Se envía If-Match; el backend comprueba la revisión antes y después de resolver. Cambiar proyecto, editar, cerrar o reemplazar la solicitud impide aplicar respuestas tardías. Un resultado aceptado es una instantánea fechada; la vista señala cuando el circuito cambia y deshabilita su exportación hasta recalcular. Un error retira las medidas anteriores.

## Parámetros y presentación

Duración y paso máximo se expresan en segundos positivos y finitos, paso no mayor que duración y hasta 20000 muestras estimadas. La inicialización puede usar equilibrio DC o condiciones explícitas declaradas por C/L en el proyecto. Esta entrega no edita estímulos PWL ni condiciones iniciales por elemento. Los tiempos adaptativos devueltos por ngspice se conservan.

DC muestra medidas por elemento con validez explícita. Transitorio permite elegir tensión de pin referenciada a tierra o tensión/corriente/potencia por elemento. Solo se dibuja una unidad por eje. Pines flotantes omitidos no se convierten en cero. Los valores ausentes producen huecos; las series constantes tienen escala visible. El gráfico reduce puntos para presentación manteniendo extremos por bloque; JSON conserva la respuesta completa.

La exportación JSON identifica proyecto, revisión, fecha, dominio, parámetros y unidades; excluye credenciales y código. Captura, resolución y firmware conservan sus relojes propios.

## Pruebas y salida

Pruebas de parámetros inválidos y presupuesto, series vacías/constantes y reducción con extremos; API rechaza revisión ajena o cambiada durante cálculo. E2E real de circuito RC: curva exponencial y estado DC, descarga y respuesta tardía tras edición. Revisar pantalla grande y angosta. Suite Vitest completa, tipos servidor/web y build antes de publicar PR. La entrega permanece en curso hasta completar estas verificaciones.
