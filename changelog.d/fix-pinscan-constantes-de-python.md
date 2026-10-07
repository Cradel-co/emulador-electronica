Ya no avisa "hay un módulo cableado al pin X que el código no usa" cuando el pin está en una constante (#65).

El escáner resolvía constantes solo en el camino de Arduino; en MicroPython era regex de
literales. Ahora resuelve asignaciones de Python, pero solo si el nombre va a `Pin`, `PWM` o `ADC`.
