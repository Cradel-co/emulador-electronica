El firmware ya ve los cambios de propiedades mientras el programa corre (#68).

Cambiar una prop movía el circuito pero no lo que leía el código: un sonómetro seguía informando
50 dBA con la escena en 110. `PUT /diagram` aplicaba la alimentación pero no empujaba la
instantánea nueva del ADC ni los niveles de entrada.
