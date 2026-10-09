import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { decodificadorJpegMicroPython } from './jpegDecoder.js';

const pythonDisponible = spawnSync('python3', ['--version']).status === 0;
const arnesPython = String.raw`
import base64, json, sys
entrada = json.loads(sys.stdin.read())
espacio = {}
exec(compile(entrada['fuente'], '<decodificador-jpeg>', 'exec'), espacio)
try:
    pixeles = espacio['decodificar_rgb565'](base64.b64decode(entrada['jpeg']), entrada.get('ancho'), entrada.get('alto'))
    print(json.dumps({'ok': True, 'pixeles': base64.b64encode(pixeles).decode()}))
except Exception as error:
    print(json.dumps({'ok': False, 'error': str(error)}))
`;

async function jpegDeColores(ancho = 64, alto = 48): Promise<{ jpeg: Buffer; rgb: Buffer }> {
  const rgb = Buffer.alloc(ancho * alto * 3);
  const colores = [[240, 20, 20], [20, 230, 20], [20, 20, 240], [235, 220, 20]];
  for (let y = 0; y < alto; y++) for (let x = 0; x < ancho; x++) {
    const color = colores[(y >= alto / 2 ? 2 : 0) + (x >= ancho / 2 ? 1 : 0)]!;
    const i = (y * ancho + x) * 3;
    rgb[i] = color[0]!; rgb[i + 1] = color[1]!; rgb[i + 2] = color[2]!;
  }
  const jpeg = await sharp(rgb, { raw: { width: ancho, height: alto, channels: 3 } })
    .jpeg({ quality: 90, chromaSubsampling: '4:2:0' }).toBuffer();
  const decodificado = await sharp(jpeg).removeAlpha().raw().toBuffer();
  return { jpeg, rgb: decodificado };
}

async function jpegTexturado(ancho = 320, alto = 240): Promise<Buffer> {
  const rgb = Buffer.alloc(ancho * alto * 3);
  for (let y = 0; y < alto; y++) for (let x = 0; x < ancho; x++) {
    const i = (y * ancho + x) * 3;
    rgb[i] = (x * 37 + y * 19 + (x * y) % 251) & 255;
    rgb[i + 1] = (x * 13 + y * 43 + (x * y) % 239) & 255;
    rgb[i + 2] = (x * 29 + y * 7 + (x * y) % 227) & 255;
  }
  return sharp(rgb, { raw: { width: ancho, height: alto, channels: 3 } })
    .jpeg({ quality: 85, chromaSubsampling: '4:2:0' }).toBuffer();
}

function ejecutar(jpeg: Buffer, destino?: { ancho: number; alto: number }, fuente = decodificadorJpegMicroPython): { ok: boolean; pixeles?: Buffer; error?: string } {
  const resultado = spawnSync('python3', ['-c', arnesPython], {
    input: JSON.stringify({ fuente, jpeg: jpeg.toString('base64'), ...destino }),
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60_000,
  });
  if (resultado.status !== 0) throw new Error(resultado.stderr || 'Falló el proceso Python de prueba');
  const json = JSON.parse(resultado.stdout) as { ok: boolean; pixeles?: string; error?: string };
  return { ...json, pixeles: json.pixeles ? Buffer.from(json.pixeles, 'base64') : undefined };
}

function diferenciaRgb565(pixel: number, r: number, g: number, b: number): number[] {
  return [Math.abs(((pixel >> 11) & 31) * 255 / 31 - r), Math.abs(((pixel >> 5) & 63) * 255 / 63 - g), Math.abs((pixel & 31) * 255 / 31 - b)];
}

describe.skipIf(!pythonDisponible)('decodificador JPEG compatible con MicroPython', () => {
  it('decodifica JPEG baseline 4:2:0 a RGB565 en el mismo orden que la fuente', async () => {
    const { jpeg, rgb } = await jpegDeColores();
    const salida = ejecutar(jpeg);
    expect(salida.ok).toBe(true);
    expect(salida.pixeles).toHaveLength(64 * 48 * 2);
    for (const [x, y] of [[10, 10], [50, 10], [10, 38], [50, 38]]) {
      const origen = (y! * 64 + x!) * 3;
      const pixel = salida.pixeles!.readUInt16BE((y! * 64 + x!) * 2);
      const diferencia = diferenciaRgb565(pixel, rgb[origen]!, rgb[origen + 1]!, rgb[origen + 2]!);
      expect(Math.max(...diferencia), `pixel (${x},${y}), RGB565=${pixel.toString(16)}, diferencia=${diferencia}`).toBeLessThanOrEqual(8);
    }
  });

  it('rechaza una entrada truncada sin devolver píxeles parciales', async () => {
    const { jpeg } = await jpegDeColores();
    const salida = ejecutar(jpeg.subarray(0, jpeg.length - 12));
    expect(salida.ok).toBe(false);
    expect(salida.pixeles).toBeUndefined();
    expect(salida.error).toMatch(/truncad|incomplet|JPEG/i);
  });

  it('reduce una captura completa de 320×240 al área de 128×96 de la TFT', async () => {
    const { jpeg, rgb } = await jpegDeColores(320, 240);
    const salida = ejecutar(jpeg, { ancho: 128, alto: 96 });
    expect(salida.ok).toBe(true);
    expect(salida.pixeles).toHaveLength(128 * 96 * 2);
    for (const [x, y] of [[20, 20], [100, 20], [20, 76], [100, 76]]) {
      const origen = (Math.floor(y! * 240 / 96) * 320 + Math.floor(x! * 320 / 128)) * 3;
      const pixel = salida.pixeles!.readUInt16BE((y! * 128 + x!) * 2);
      expect(Math.max(...diferenciaRgb565(pixel, rgb[origen]!, rgb[origen + 1]!, rgb[origen + 2]!))).toBeLessThanOrEqual(18);
    }
  }, 70_000);

  it('conserva byte por byte la salida RGB565 completa de la foto 320×240 de referencia', async () => {
    const { jpeg } = await jpegDeColores(320, 240);
    const salida = ejecutar(jpeg, { ancho: 128, alto: 96 });
    expect(salida.ok).toBe(true);
    expect(salida.pixeles).toHaveLength(128 * 96 * 2);
    expect(createHash('sha256').update(salida.pixeles!).digest('hex')).toBe('b57ff0d080b7deaa5f046f173fd94180e3c10a3baac95a5b8abaca67be373038');
  });

  it('produce los mismos 128×96 RGB565 que el recorrido previo en una foto texturada', async () => {
    const jpeg = await jpegTexturado();
    const salidaDirecta = ejecutar(jpeg, { ancho: 128, alto: 96 });
    const fuentePrevio = decodificadorJpegMicroPython.replace(
      'reducido_dc = frecuencias_u == 1 and frecuencias_v == 1',
      'reducido_dc = False',
    );
    expect(fuentePrevio).not.toBe(decodificadorJpegMicroPython);
    const salidaCaracterizada = ejecutar(jpeg, { ancho: 128, alto: 96 }, fuentePrevio);
    expect(salidaDirecta.ok).toBe(true);
    expect(salidaCaracterizada.ok).toBe(true);
    expect(salidaDirecta.pixeles).toEqual(salidaCaracterizada.pixeles);
  }, 70_000);

  it('rechaza JPEG progresivo y dimensiones fuera del límite antes de decodificar', async () => {
    const { rgb } = await jpegDeColores();
    const progresivo = await sharp(rgb, { raw: { width: 64, height: 48, channels: 3 } })
      .jpeg({ quality: 90, progressive: true }).toBuffer();
    expect(ejecutar(progresivo)).toMatchObject({ ok: false });

    const grande = await sharp({ create: { width: 321, height: 240, channels: 3, background: '#000' } })
      .jpeg({ quality: 80 }).toBuffer();
    expect(ejecutar(grande)).toMatchObject({ ok: false });
  });
});
