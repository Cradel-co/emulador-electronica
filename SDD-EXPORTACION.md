# SDD — Informe de prototipado

Primera entrega de etapa 6, sobre las etapas 3 y 4 integradas. Se entrega una instantánea
legible del circuito persistido y su observación eléctrica actual, en JSON versionado y HTML
sin dependencias externas. No es un paquete importable, copia de firmware ni esquema KiCad.

## Contrato

GET `/api/projects/:name/report` lee dentro de la cola de proyecto, calcula una observación
nueva y comprueba otra vez la revisión persistida. La UI envía If-Match del proyecto cargado;
si cambió se rechaza con 412. No se reutiliza la última lectura de la pantalla. Un fallo o una
lectura obsoleta conserva su estado y retira las medidas. La UI guarda cambios pendientes
antes de solicitar; si hay conflicto, cambio de contexto o edición durante la espera, no aplica
la respuesta. El informe ya abierto es una instantánea fechada, no un monitor vivo.

`schemaVersion: 1`, fecha UTC, nombre, revisión persistida, contexto eléctrico, dominio
`instantanea-dc`, unidades V/mA/mW/ohm, placas, módulos (incluidas placas implícitas), propiedades,
entorno, posición/rotación, cables y perfiles eléctricos declarados. No incluye credenciales
Wi-Fi, código fuente, archivos locales ni código ejecutable del catálogo. Los nombres y pines
del catálogo acompañan los tipos usados; las definiciones ausentes se señalan.

Medidas desconocidas se representan como null con validez explícita, nunca como cero. Se
conserva el signo del solver y se explica la orientación del elemento. HTML escapa contenido
ajeno y no incorpora scripts ni SVG del catálogo. El circuito se presenta mediante tablas de
instancias y conexiones completas; no se promete un dibujo equivalente al canvas.

## UI y verificación

Archivo → Informe del prototipo abre una isla React sobre un dialog nativo, con fecha, dominio,
validez, contexto de placas, tabla de medidas y descarga JSON/HTML de la misma instantánea.
Pruebas de dominio: cero válido, fallo/obsolescencia/contexto distinto, números no finitos,
multiplaca, conservación de circuitos y omisión de secretos. Pruebas HTML de escape y unidades.
Integración REST verifica circuito y precondición. E2E verifica descargas reales, ediciones
pendientes, navegación/conflicto y presentación; inspección visual a tamaño escritorio.

Quedan para la segunda entrega los controles UI de análisis DC/AC/transitorio/termal que ya
expone el backend: tienen dominios y ejes propios y no se mezclan con esta instantánea DC.
Tampoco se declara autenticidad, exactitud experimental ni persistencia de una corrida histórica.
