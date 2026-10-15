# Acoplamiento electrotérmico de resistencias

El endpoint `POST /api/projects/:name/analysis/electrothermal` integra un cuerpo térmico
RC por resistencia y vuelve a resolver la red eléctrica del proyecto con ngspice en
cada etapa. La temperatura modifica la resistencia, cambia la corriente y la potencia
Joule, y esa nueva potencia modifica la evolución térmica:

```text
R(T) = Rref · [1 + alpha · (T − Tref)]
Cth · dT/dt = P(T) − (T − Ta)/Rth
P(T) = V(T) · I(T) = I(T)² · R(T)
```

El perfil publicado es `electrotermico-rc-cuasiestatico`. La temperatura evoluciona
en el tiempo y la electricidad se considera en equilibrio instantáneo. Este supuesto
requiere que la dinámica eléctrica sea despreciable frente a la térmica. Por eso se
rechazan proyectos con primitivas eléctricas C/L; las fuentes y controles permanecen
fijos. No ejecuta firmware, PWM ni reinicios por brownout.

La [documentación oficial de COMSOL](https://www.comsol.com/support/learning-center/article/Setting-Up-and-Solving-Electromagnetic-Heating-Problems-with-High-Frequency-Loads-46881)
describe el acoplamiento bidireccional y la formulación eléctrica estacionaria en cada
paso térmico bajo ese supuesto. Su [ejemplo de microresistencia](https://doc.comsol.com/6.3/doc/com.comsol.help.models.mems.microresistor_beam/microresistor_beam.html)
explica la aproximación lineal de resistividad con la temperatura. Aquí no se adoptan
sus parámetros de material: Rref, Tref y alpha siempre los declara el usuario.

## Dominio y parámetros

- El identificador de cada entrada es el del elemento físico, por ejemplo `r.r` para
  la instancia `r` del módulo resistor. Sólo se admiten primitivas `R` actualizables.
- `resistenciaReferenciaOhm` debe coincidir con la resistencia nominal del proyecto.
  Esa resistencia se interpreta a `temperaturaReferenciaC`.
- `coeficientePorK` puede ser positivo, negativo o cero. R(T) debe ser positiva y finita
  en **todo** `termica.rangoDeclaradoC`; no se extrapola fuera del rango.
- `termica.fuente` identifica el origen de los parámetros y `termica.condiciones` el
  montaje y supuestos. Rth, Cth, ambiente e inicio son explícitos y constantes.
- `dominioElectrico` limita tensión absoluta entre terminales, corriente absoluta y
  potencia disipada. Se comprueba también en las etapas intermedias del integrador.
- Las resistencias sin entrada térmica mantienen su valor nominal. No se calculan
  radiación, intercambio entre cuerpos ni cambios irreversibles del material.

El resultado conserva `caracterizadoEnLaboratorio: false`. Una curva calculada no
demuestra calibración de una pieza ni predice daño, avería o vida útil.

## Ejemplo de solicitud

Para un proyecto con una fuente fija de 10 V y un resistor `r` de 100 Ω entre salida
y retorno, el siguiente ejemplo usa **parámetros sintéticos**, no datos de una pieza
comercial ni valores recomendados de operación:

```json
{
  "parametros": {
    "duracionS": 0.1,
    "pasoInicialS": 0.1,
    "pasoMinimoS": 0.0001,
    "pasoMaximoS": 0.1,
    "toleranciaC": 0.01
  },
  "modelos": {
    "r.r": {
      "resistenciaReferenciaOhm": 100,
      "temperaturaReferenciaC": 25,
      "coeficientePorK": 0.02,
      "dominioElectrico": {
        "tensionMaxAbsV": 20,
        "corrienteMaxAbsA": 1,
        "potenciaMaxW": 5
      },
      "termica": {
        "id": "ejemplo-sintetico",
        "fuente": "Parámetros inventados para demostrar el contrato",
        "condiciones": "Cuerpo único, ambiente constante; sin mediciones físicas",
        "resistenciaKPorW": 10,
        "capacidadJPorK": 0.1,
        "ambienteC": 25,
        "inicialC": 25,
        "rangoDeclaradoC": [0, 100]
      }
    }
  }
}
```

La respuesta incluye `t`, series por elemento de temperatura, R, V, I y P; energía
Joule, energía evacuada, variación de energía almacenada y residuo del balance;
además de evaluaciones eléctricas, pasos aceptados/rechazados y error local estimado.
El ejemplo calienta R, aumenta su resistencia y reduce su corriente. El proyecto
guardado conserva sus propiedades originales.

## Integración, verificaciones y límites

Se usa RK2 de punto medio con comparación entre un paso y dos medios pasos. Se acepta
la solución de los medios pasos cuando `|Tmedios − Tcompleto|/3 <= toleranciaC` para
todos los cuerpos. El estimador es **local**, no una garantía de error global ni de
exactitud física. Se rechaza la falta de convergencia al alcanzar el paso mínimo.

Cada solución eléctrica pasa las comprobaciones de Kirchhoff y potencia del motor.
Los flujos de energía térmica se integran en las mismas etapas que la temperatura;
el balance no se fabrica calculando evacuación como diferencia. Aun así, ese balance
es una comprobación numérica interna, no evidencia experimental independiente.

La solicitud admite hasta 8 cuerpos, 128 módulos/elementos eléctricos, 256 pasos y
256 evaluaciones eléctricas; tiene un plazo global de acoplamiento de 20 segundos y
un cuerpo HTTP máximo de 64 KiB. Al vencer el plazo no se programan más etapas ni se
publican trazas parciales. Puede quedar **una operación nativa ya enviada**, que no
tiene cancelación individual: conserva el timeout y la cola acotada del worker.

Contratos inválidos devuelven 400. Topología incompatible, dominio excedido,
inconsistencia, presupuesto agotado o solver fallido devuelven 422 con
`resuelto: false`. El endpoint existente `/analysis/transient` conserva su perfil
eléctrico transitorio y su posprocesamiento térmico unidireccional.

Los tests comparan corriente constante con solución analítica, verifican refinamiento
de segundo orden y el caso alpha cero, comprueban feedback con tensión fija, y prueban
una red real y la API con pocas corridas ngspice. También cubren el límite de tiempo,
evaluaciones, dominio, errores y preservación del proyecto.
