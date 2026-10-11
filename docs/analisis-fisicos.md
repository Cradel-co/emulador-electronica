# Analizar un prototipo

Abrí un proyecto y elegí **Archivo → Análisis físicos**. **Calcular** guarda los cambios antes de solicitar una instantánea; un conflicto debe resolverse primero.

**DC** muestra el punto de funcionamiento: tensión en V, corriente en mA y potencia en mW, con la validez de cada medida. Reutiliza la observación del informe del prototipo. Los resultados sin resolver no se presentan como ceros.

**Transitorio** calcula un intervalo con GPIO y topología fijos. No ejecuta firmware ni usa la onda del micrófono. En proyectos sin placa, energizá el circuito con ▶ para que las fuentes entreguen tensión. Elegí duración y paso máximo en segundos. El paso es un límite de integración: ngspice devuelve tiempos adaptativos, no una frecuencia de muestreo uniforme.

La inicialización **Equilibrio DC** comienza en el punto estable. **Condiciones C/L del proyecto** utiliza los valores iniciales declarados de capacitores e inductores. Para observar una carga RC, declará el capacitor inicialmente a 0 V y usá esta segunda opción.

Elegí una señal: tensiones de pines respecto a tierra o tensión, corriente o potencia por elemento. Las corrientes transitorias se muestran en A y las potencias en W. No se dibujan pines flotantes como si tuvieran una lectura válida. Los avisos del motor explican las limitaciones de cada análisis.

**Descargar análisis JSON** conserva todas las muestras y sus tiempos, unidades, parámetros, proyecto, revisión y fecha. El dibujo reduce puntos preservando extremos para facilitar la lectura. Si cambia el circuito, la vista avisa y requiere recalcular para exportar. Cerrar el panel descarta solicitudes en curso.

AC, electro térmico acoplado y edición de estímulos PWL y correlación automática con lecturas de firmware quedan para entregas posteriores. Diseño y criterios: [SDD](../SDD-ANALISIS-FISICOS.md).

## Temperatura y energía

Elegí **Térmico · temperatura y energía** y **Identificar elementos**. Se guardan los cambios y se consulta el punto DC para listar resistencias y contactos con medidas válidas. Si el circuito no está alimentado o no tiene elementos disponibles, revisalo antes de continuar. Modificar el circuito requiere identificar de nuevo.

Seleccioná un elemento y completá el identificador del modelo, la fuente de los parámetros y las condiciones de aplicación. Declarás resistencia térmica en K/W, capacidad térmica en J/K, temperatura ambiente e inicial en °C y el rango válido. Los campos empiezan vacíos; estos valores deben provenir del modelo que quieras estudiar. El catálogo no los inventa por vos.

**Calcular** reutiliza el transitorio y aplica el modelo de un cuerpo a temperatura uniforme con ambiente constante. La señal inicial del resultado es su temperatura; también podés elegir tensión, corriente o potencia. La tabla presenta energía disipada, variación almacenada y energía evacuada, en J. Un valor evacuado negativo indica calor aportado por el ambiente. La temperatura inicial corresponde al primer tiempo devuelto por ngspice.

Si la temperatura sale del rango declarado, el cálculo falla y retira las medidas. La descarga conserva el modelo explícito, temperaturas, energía, tiempos, parámetros y unidades. Cambiar un campo exige recalcular. La configuración del panel no modifica ni se guarda en el proyecto.

Este modelo no realimenta la resistencia eléctrica según la temperatura ni simula varios cuerpos acoplados; tampoco acredita caracterización física del componente. Esta primera UI configura un elemento por solicitud. El backend conserva el análisis térmico de varios elementos y el modo electro térmico, cuya interfaz queda para otra entrega.
