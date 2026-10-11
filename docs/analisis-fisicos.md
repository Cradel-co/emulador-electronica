# Analizar un prototipo

Abrí un proyecto y elegí **Archivo → Análisis físicos**. **Calcular** guarda los cambios antes de solicitar una instantánea; un conflicto debe resolverse primero.

**DC** muestra el punto de funcionamiento: tensión en V, corriente en mA y potencia en mW, con la validez de cada medida. Reutiliza la observación del informe del prototipo. Los resultados sin resolver no se presentan como ceros.

**Transitorio** calcula un intervalo con GPIO y topología fijos. No ejecuta firmware ni usa la onda del micrófono. En proyectos sin placa, energizá el circuito con ▶ para que las fuentes entreguen tensión. Elegí duración y paso máximo en segundos. El paso es un límite de integración: ngspice devuelve tiempos adaptativos, no una frecuencia de muestreo uniforme.

La inicialización **Equilibrio DC** comienza en el punto estable. **Condiciones C/L del proyecto** utiliza los valores iniciales declarados de capacitores e inductores. Para observar una carga RC, declará el capacitor inicialmente a 0 V y usá esta segunda opción.

Elegí una señal: tensiones de pines respecto a tierra o tensión, corriente o potencia por elemento. Las corrientes transitorias se muestran en A y las potencias en W. No se dibujan pines flotantes como si tuvieran una lectura válida. Los avisos del motor explican las limitaciones de cada análisis.

**Descargar análisis JSON** conserva todas las muestras y sus tiempos, unidades, parámetros, proyecto, revisión y fecha. El dibujo reduce puntos preservando extremos para facilitar la lectura. Si cambia el circuito, la vista avisa y requiere recalcular para exportar. Cerrar el panel descarta solicitudes en curso.

AC, térmico, edición de estímulos PWL y correlación automática con lecturas de firmware quedan para entregas posteriores. Diseño y criterios: [SDD](../SDD-ANALISIS-FISICOS.md).
