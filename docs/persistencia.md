# Persistencia: primera entrega de la etapa 4

## Garantías implementadas

`escrituraAtomica.ts` escribe un temporal exclusivo y oculto en el mismo directorio que el
destino. Para reemplazos publica mediante `rename`; para crear código sin sobrescribir usa
un enlace exclusivo al temporal ya completo. Conserva los permisos del archivo reemplazado.
El temporal se elimina al terminar o ante un error manejado. Las validaciones de rutas y
rechazo de enlaces simbólicos de ProjectStore se mantienen.

Esto impide publicar archivos parcialmente escritos. No se ejecuta `fsync`: no se promete
durabilidad ante un corte de energía. Una terminación abrupta puede dejar un temporal oculto;
no se realiza una limpieza global que pueda borrar archivos de otra instancia activa.
No se promete una transacción atómica de varios archivos, ni conservar ACL/propietario especiales.

`colaProyectos.ts` mantiene una cola por ruta absoluta de proyecto, compartida entre stores
con la misma raíz dentro del proceso. ProjectStore serializa creaciones, guardados, borrados
y operaciones de código. `actualizar` incluye leer → transformar → guardar. `transaccion`
permite incluir validaciones e inicialización de archivos en la misma operación.

REST, mutaciones MCP del diagrama, placas y entorno de chips usan ese límite desde la lectura
inicial. Las operaciones anidadas reutilizan la transacción mediante AsyncLocalStorage;
no deben ejecutarse mutaciones anidadas en paralelo ni adquirir dos proyectos en orden inverso.
No lanzar una tarea de persistencia sin esperarla dentro de la transacción. El contexto se
invalida al terminar para que tareas posteriores no salteen la cola.

Un fallo se propaga y libera el siguiente turno. Otro proyecto tiene su propia cola; las
lecturas no esperan la cola y observan un archivo completo anterior o posterior al reemplazo.
`save` sigue siendo una operación de reemplazo: quien transforma un snapshot debe usar
`actualizar` o `transaccion` desde la lectura inicial.

## Límites y siguientes entregas

La cola coordina un único proceso servidor. No bloquea otros procesos ni ediciones externas
hechas directamente en disco, y raíces distintas que apuntan al mismo lugar mediante enlaces
no comparten identidad. Un cliente histórico que omite la revisión todavía puede reemplazar cambios recientes.
La UI usa escrituras condicionales y conserva su edición cuando encuentra un conflicto; el
contrato y la compatibilidad están en [conflictos-guardado.md](conflictos-guardado.md).
Ese contrato también describe el keepalive condicional y la conservación de cambios ante eventos externos.

La tercera entrega agrega [integridad de firmware y descargas acotadas](integridad-firmware-descargas.md),
con política explícita para caché histórica y referencias conservadas.

## Evidencia

`persistencia.test.ts` reproduce escritura parcial y pérdida de actualización en la base:
cuatro pruebas fallaron antes del cambio y una pasó. Las pruebas finales comprueban fallos
antes de publicar, recuperación, permisos, creación exclusiva, dos stores y disponibilidad
de otro proyecto. `api.test.ts` comprueba solicitudes REST simultáneas sobre un servidor real
con proyectos y catálogo temporales. Los recorridos E2E verifican consumidores reales de la API.

Validación de la entrega: 1618 pruebas de Vitest aprobadas y una omisión existente;
135 E2E aprobados y 13 omisiones condicionales existentes, en dos tandas disjuntas.
Build general y typechecks server/web pasan. Los escenarios opcionales de firmware/Docker
y hardware físico no forman parte de esa campaña.
