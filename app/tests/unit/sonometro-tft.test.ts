import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../server/src/projectStore.js';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { sonometroTftMain } from '../../server/src/templates/sonometroTft.js';
it('acota a 40 muestras, usa tiempo real, respeta vuelta del reloj y deja huecos ante error ADC', () => {
  const arnes = String.raw`
import sys,json,types
fuente=json.loads(sys.stdin.read())['fuente']
m=types.ModuleType('machine');m.ADC=m.Pin=m.SPI=object;sys.modules['machine']=m
f=types.ModuleType('framebuf');sys.modules['framebuf']=f
s=types.ModuleType('st7735');s.ST7735=object;sys.modules['st7735']=s
import time
time.ticks_diff=lambda a,b: ((a-b+(1<<29))%(1<<30))-(1<<29)
e={};exec(fuente.rsplit('\niniciar()\n',1)[0],e)
h=e['HistorialNivel']()
for i in range(100): h.agregar(i*250, 50 if i!=98 else None)
a=h.visibles(24750);viejas=h.visibles(36000)
r=e['HistorialNivel']();r.agregar((1<<30)-100,80);vuelta=r.visibles(100)
print(json.dumps({'cantidad':len(a),'primera':a[0],'hueco':a[-2],'viejas':viejas,'vuelta':vuelta,'voltios':e['voltios'](2118),'nivel':e['decibeles'](2118)}))
`;
  const r = spawnSync('python3', ['-c', arnes], { input: JSON.stringify({ fuente: sonometroTftMain }), encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ cantidad: 40, primera: [9750, 50], hueco: [250, null], viejas: [], vuelta: [[200, 80]], voltios: expect.closeTo(1.603, 3), nivel: expect.closeTo(80.15, 1) });
});
it('envía solo rectángulos modificados y conserva el resto de los píxeles del cuadro', () => {
  const arnes = String.raw`
import sys,json,types
fuente=json.loads(sys.stdin.read())['fuente']
m=types.ModuleType('machine');m.ADC=m.Pin=m.SPI=object;sys.modules['machine']=m
f=types.ModuleType('framebuf');f.RGB565=1;f.FrameBuffer=lambda *args:None;sys.modules['framebuf']=f
s=types.ModuleType('st7735');s.ST7735=object;sys.modules['st7735']=s
e={};exec(fuente.rsplit('\niniciar()\n',1)[0],e)
class TFT:
 def __init__(self): self.memoria=bytearray(128*160*2);self.envios=[]
 def dibujar_rgb565(self,d,x,y,w,h):
  self.envios.append([x,y,w,h,len(d)])
  for fila in range(h):
   i=((y+fila)*128+x)*2;j=fila*w*2
   self.memoria[i:i+w*2]=d[j:j+w*2]
p=TFT();g=e['GraficaNivel'](p);g.enviar_cambios()
g.datos[(70*128+50)*2]=7;g.datos[(71*128+51)*2+1]=224;g.enviar_cambios()
g.enviar_cambios()
print(json.dumps({'envios':p.envios,'igual':p.memoria==g.datos,'verde':e['color'](0x07e0)}))
`;
  const r = spawnSync('python3', ['-c', arnes], { input: JSON.stringify({ fuente: sonometroTftMain }), encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ envios: [[0, 0, 128, 160, 40960], [50, 70, 2, 2, 8]], igual: true, verde: 0xe007 });
});

it('la plantilla genera firmware y driver con cableado SPI y conserva el perfil ADC', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'emu-sonometro-tft-'));
  const store = new ProjectStore(root);
  try {
    await fs.mkdir(store.templatesDir, { recursive: true });
    await fs.cp(path.resolve(import.meta.dirname, '../../../projects/_template/sonometro-que-se-lee'), path.join(store.templatesDir, 'sonometro-que-se-lee'), { recursive: true });
    const p = await store.createFromTemplate('sonometro-pantalla', 'sonometro-que-se-lee');
    expect(p.modules.map(m => m.type)).toContain('tft-st7735-128x160');
    expect(p.wires).toContainEqual({ from: 'tft1.SCK', to: 'board.GPIO12' });
    expect(p.wires).toContainEqual({ from: 'mic1.OUT', to: 'board.GPIO4' });
    expect(p.sim.analogicoEsp?.board?.canales[0]?.gpio).toBe(4);
    expect(await store.readFile(p.name, 'main.py', 'micropython')).toContain('class HistorialNivel');
    expect(await store.readFile(p.name, 'st7735.py', 'micropython')).toContain('class ST7735');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
