El circuito y el código conservan las ediciones locales cuando otra sesión cambia la versión guardada; la app permite resolver el conflicto.

Los guardados de la UI llevan revisión y se comprueban dentro de la cola del proyecto.
La resolución permite descargar cambios, cargar la versión guardada o reemplazarla de forma
explícita y condicional. Los clientes REST históricos sin x-cliente conservan su contrato;
pueden adoptar If-Match. El envío al salir también verifica revisión.
