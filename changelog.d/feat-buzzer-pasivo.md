Buzzer pasivo (piezo): el programa elige la nota con `machine.PWM`, así que puede tocar melodías (#65).

La frecuencia la declara el firmware con `@PWM` en vez de reconstruirla de los flancos, que se
perderían en el aliasing del muestreo. El volumen sigue a sen(π·duty), la amplitud del fundamental
de la onda cuadrada, y el navegador sintetiza la onda del pulso real para que el timbre también
cambie con el ciclo de trabajo.
