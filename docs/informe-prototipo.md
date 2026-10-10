# Informe del prototipo

En un proyecto abierto, elegí **Archivo → Informe del prototipo…** (también disponible en la
paleta de comandos). La app guarda lo pendiente antes de capturar. Si hay un conflicto de
guardado, resolvelo primero: no se exporta silenciosamente una versión distinta del dibujo.

La vista previa muestra fecha UTC, dominio `instantanea-dc`, estado de validez, placas, corrida
y medidas por elemento. **Descargar JSON** conserva el contrato versionado y el circuito completo;
**Descargar HTML** produce un informe autónomo para abrir o imprimir, con tablas de instancias,
conexiones, medidas, tensiones de nodos, catálogo utilizado y perfiles eléctricos declarados.
La vista previa y el HTML muestran seis cifras significativas; JSON conserva los números
originales del motor. Los valores pequeños se muestran con notación científica, sin convertirlos
en cero. Ambos formatos salen de la misma instantánea. Una vez abierta no se actualiza en vivo: cerrá
y solicitá otro informe para capturar un estado nuevo.

- Tensión: V, diferencia Va−Vb del elemento.
- Corriente: mA, de a hacia b; un signo negativo conserva la orientación del solver.
- Potencia: mW según el motor; no es energía acumulada ni predicción de daño.
- Resistencia: ohm; null se presenta como **Desconocida**. No se inventa una resistencia de cero.

Cero puede ser una medida válida. Una observación `no-resuelta` u `obsoleta` no exporta las
medidas anteriores. Un valor no finito se representa como null y su fila como desconocida.
Una placa sin nivel de GPIO reportado no acredita HIGH. El informe incluye alimentación por
placa y niveles reportados, y conserva sus identidades aunque compartan números de GPIO.
La propiedad `energizado` corresponde al circuito independiente; no sustituye la alimentación
individual de las placas. Los nombres de nodos y elementos son los del modelo eléctrico.

La revisión de proyecto vincula el dibujo persistido, mientras que el contexto eléctrico lleva
su propia huella y generación de corrida. Esta última no es una identidad persistente entre
reinicios. Mover un módulo cambia el dibujo guardado, aunque no cambie la topología eléctrica.
La captura REST usa cola por proyecto y una comprobación posterior; no bloquea editores externos
ni garantiza un snapshot entre varios procesos. La UI descarta una captura que llega después
de una edición o cambio de contexto.

El JSON incluye instancias y cables, posiciones, rotaciones, propiedades, entorno y placas
implícitas. No contiene credenciales de `sim.wifi*`, código fuente ni ejecutables del catálogo.
Los nombres, tipos y pines del catálogo permiten interpretar el circuito; una definición faltante
queda marcada como no disponible. No es un backup ejecutable ni una especificación para importar.
El HTML muestra el circuito en tablas; no pretende reproducir el canvas ni exportar KiCad.

Este dominio es la instantánea DC del motor, incluidos sus niveles efectivos actuales. Los
análisis AC, transitorios y térmicos tienen otros ejes y condiciones; sus controles UI quedan
para la siguiente entrega. El informe no certifica exactitud de hardware físico ni autenticidad.
Diseño y pruebas: [SDD-EXPORTACION.md](../SDD-EXPORTACION.md).
