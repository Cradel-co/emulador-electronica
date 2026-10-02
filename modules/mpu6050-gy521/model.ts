// Placa GY-521 (MPU-6050). Es un módulo genérico sin esquemático oficial; este modelo sigue el que
// difunde la comunidad: regulador de 3,3 V (662K, tipo XC6206) que alimenta el MPU-6050, pull-ups
// de 4,7 kΩ de SCL y SDA a los 3,3 V regulados (no a VCC: los pines del MPU-6050 no aguantan 5 V),
// pull-down de 4,7 kΩ en AD0 y LED de encendido con 1 kΩ.
// Consumo del MPU-6050 midiendo: 3,8 mA (PS-MPU-6000A, 6.3: giróscopo + acelerómetro).
import type { ModeloModulo } from '@emu/shared';

export default {
  circuito(ctx) {
    const vcc = ctx.pin('VCC'), gnd = ctx.pin('GND'), v33 = ctx.nodo('v33');
    ctx.regulador(vcc, v33, gnd, { voltios: 3.3, caida: 0.25, limiteA: 0.2, iq: 1e-6 }, 'ldo');
    ctx.resistencia(v33, gnd, 3.3 / 0.0038, 'mpu6050');
    ctx.resistencia(ctx.pin('SCL'), v33, 4700, 'pullupSCL');
    ctx.resistencia(ctx.pin('SDA'), v33, 4700, 'pullupSDA');
    ctx.resistencia(ctx.pin('AD0'), gnd, 4700, 'pulldownAD0');
    ctx.resistencia(v33, ctx.nodo('led'), 1000, 'rled');
    ctx.diodo(ctx.nodo('led'), gnd, { is: 1e-20, n: 2, rs: 5 }, 'led');
  },
  observar(l) {
    const vcc = l.vEntre('VCC', 'GND');
    // El MPU-6050 necesita 2,375 V (PS 6.3): con el regulador en caída, debajo de ~2,6 V de VCC no
    // anda. Los límites de VCC están en las `reglas` del module.json.
    return { ui: { on: vcc - 0.25 >= 2.375 && vcc <= 6 } };
  },
} satisfies ModeloModulo;
