/** Decodificador baseline pequeño, sin módulos nativos, para el firmware MicroPython. */
export const decodificadorJpegMicroPython = String.raw`# JPEG baseline secuencial de 8 bits, Huffman, componentes YCbCr (1x1, 2x1, 1x2 o 2x2).
# Devuelve píxeles RGB565 big-endian; el destino puede reducir la imagen por vecino más próximo.
import math

_ZIGZAG = (0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63)
_COS = tuple(tuple(int(round(math.cos((2*x+1)*u*math.pi/16) * 256)) for u in range(8)) for x in range(8))
_C0 = 181  # 0.7071 en punto fijo Q8

def _fallar(mensaje):
    raise ValueError('JPEG: ' + mensaje)

def _extendido(valor, bits):
    if bits == 0:
        return 0
    limite = 1 << (bits - 1)
    return valor if valor >= limite else valor - ((1 << bits) - 1)

class _Bits:
    def __init__(self, datos, inicio):
        self.datos = datos
        self.pos = inicio
        self.actual = 0
        self.restantes = 0

    def bit(self):
        if self.restantes == 0:
            if self.pos >= len(self.datos):
                _fallar('datos truncados')
            b = self.datos[self.pos]
            self.pos += 1
            if b == 255:
                if self.pos >= len(self.datos) or self.datos[self.pos] != 0:
                    _fallar('marcador inesperado dentro de los datos')
                self.pos += 1
            self.actual = b
            self.restantes = 8
        self.restantes -= 1
        return (self.actual >> self.restantes) & 1

    def leer(self, n):
        v = 0
        for _ in range(n):
            v = (v << 1) | self.bit()
        return v

def _huffman(conteos, valores):
    tabla = {}
    codigo = 0
    indice = 0
    for largo in range(1, 17):
        cantidad = conteos[largo - 1]
        for _ in range(cantidad):
            if indice >= len(valores):
                _fallar('tabla Huffman incompleta')
            tabla[(largo, codigo)] = valores[indice]
            codigo += 1
            indice += 1
        codigo <<= 1
    if indice != len(valores):
        _fallar('tabla Huffman inválida')
    return tabla

def _simbolo(bits, tabla):
    codigo = 0
    for largo in range(1, 17):
        codigo = (codigo << 1) | bits.bit()
        simbolo = tabla.get((largo, codigo))
        if simbolo is not None:
            return simbolo
    _fallar('código Huffman inválido')

def _bloque(bits, tabla_dc, tabla_ac, cuantizacion, anterior, max_u, max_v):
    coef = [0] * 64
    categoria = _simbolo(bits, tabla_dc)
    if categoria > 11:
        _fallar('categoría DC no soportada')
    anterior += _extendido(bits.leer(categoria), categoria)
    coef[0] = anterior * cuantizacion[0]
    k = 1
    hay_ac_util = False
    while k < 64:
        rs = _simbolo(bits, tabla_ac)
        ceros = rs >> 4
        largo = rs & 15
        if largo == 0:
            if ceros == 0:
                break
            if ceros != 15:
                _fallar('corrida AC inválida')
            k += 16
            continue
        k += ceros
        if k >= 64 or largo > 10:
            _fallar('coeficiente AC inválido')
        pos = _ZIGZAG[k]
        coef[pos] = _extendido(bits.leer(largo), largo) * cuantizacion[pos]
        if (pos & 7) < max_u and (pos >> 3) < max_v:
            hay_ac_util = True
        k += 1
    if not hay_ac_util:
        valor = max(0, min(255, int(coef[0] / 8 + 128.5)))
        return [valor] * 64, anterior
    # IDCT separable en punto fijo Q8: evita millones de operaciones float en ESP32.
    intermedio = [[0] * 8 for _ in range(8)]
    for v in range(8):
        fila = v * 8
        for x in range(8):
            suma = 0
            for u in range(max_u):
                suma += coef[fila + u] * (_C0 if u == 0 else 256) * _COS[x][u]
            intermedio[v][x] = suma >> 16
    salida = [0] * 64
    for y in range(8):
        for x in range(8):
            suma = 0
            for v in range(max_v):
                suma += intermedio[v][x] * (_C0 if v == 0 else 256) * _COS[y][v]
            salida[y * 8 + x] = max(0, min(255, (suma + (128 << 18) + (1 << 17)) >> 18))
    return salida, anterior

def decodificar_rgb565(jpeg, destino_ancho=None, destino_alto=None):
    datos = memoryview(jpeg)
    if len(datos) < 4 or datos[0] != 255 or datos[1] != 216 or datos[-2] != 255 or datos[-1] != 217:
        _fallar('imagen incompleta o sin marcadores SOI/EOI')
    pos = 2
    cuantizaciones = {}
    huff_dc = {}
    huff_ac = {}
    componentes = {}
    ancho = alto = max_h = max_v = 0
    reinicio = 0
    inicio_scan = -1
    scan = []
    while pos < len(datos) - 2:
        if datos[pos] != 255:
            _fallar('marcador inválido')
        while pos < len(datos) and datos[pos] == 255:
            pos += 1
        if pos >= len(datos):
            _fallar('marcador truncado')
        marcador = datos[pos]
        pos += 1
        if marcador == 218:
            if pos + 2 > len(datos):
                _fallar('segmento SOS truncado')
            n = (datos[pos] << 8) | datos[pos + 1]
            if n < 6 or pos + n > len(datos):
                _fallar('longitud SOS inválida')
            cantidad = datos[pos + 2]
            scan = []
            for i in range(cantidad):
                base = pos + 3 + i * 2
                cid, tablas = datos[base], datos[base + 1]
                if cid not in componentes:
                    _fallar('componente SOS desconocido')
                scan.append((cid, tablas >> 4, tablas & 15))
            if datos[pos + n - 3] != 0 or datos[pos + n - 2] != 63 or datos[pos + n - 1] != 0:
                _fallar('solo se admite JPEG baseline secuencial')
            inicio_scan = pos + n
            break
        if marcador in (192, 194):
            if marcador != 192:
                _fallar('JPEG progresivo no soportado')
            n = (datos[pos] << 8) | datos[pos + 1]
            if n < 11 or pos + n > len(datos) or datos[pos + 2] != 8:
                _fallar('SOF0 inválido o precisión distinta de 8 bits')
            alto = (datos[pos + 3] << 8) | datos[pos + 4]
            ancho = (datos[pos + 5] << 8) | datos[pos + 6]
            cantidad = datos[pos + 7]
            if ancho < 1 or alto < 1 or ancho > 640 or alto > 480 or ancho * alto > 307200:
                _fallar('dimensiones mayores que 640×480')
            if cantidad not in (1, 3) or n != 8 + cantidad * 3:
                _fallar('cantidad de componentes no soportada')
            max_h = max_v = 1
            for i in range(cantidad):
                base = pos + 8 + i * 3
                cid, hv, tq = datos[base], datos[base + 1], datos[base + 2]
                h, v = hv >> 4, hv & 15
                if h < 1 or h > 2 or v < 1 or v > 2 or tq > 3:
                    _fallar('muestreo o tabla de cuantización inválidos')
                componentes[cid] = {'h': h, 'v': v, 'tq': tq}
                max_h = max(max_h, h)
                max_v = max(max_v, v)
            pos += n
        elif marcador == 219:
            n = (datos[pos] << 8) | datos[pos + 1]
            fin = pos + n
            if n < 67 or fin > len(datos):
                _fallar('DQT inválida')
            qpos = pos + 2
            while qpos < fin:
                info = datos[qpos]; qpos += 1
                if info >> 4 != 0 or (info & 15) > 3 or qpos + 64 > fin:
                    _fallar('solo se admiten cuantizaciones de 8 bits')
                tabla = [0] * 64
                for i in range(64):
                    tabla[_ZIGZAG[i]] = datos[qpos + i]
                cuantizaciones[info & 15] = tabla
                qpos += 64
            pos = fin
        elif marcador == 196:
            n = (datos[pos] << 8) | datos[pos + 1]
            fin = pos + n
            if n < 19 or fin > len(datos):
                _fallar('DHT inválida')
            hpos = pos + 2
            while hpos < fin:
                info = datos[hpos]; hpos += 1
                if info >> 4 not in (0, 1) or (info & 15) > 3 or hpos + 16 > fin:
                    _fallar('selector Huffman inválido')
                conteos = [datos[hpos + i] for i in range(16)]
                hpos += 16
                cuenta = sum(conteos)
                if cuenta > 256 or hpos + cuenta > fin:
                    _fallar('símbolos Huffman truncados')
                valores = [datos[hpos + i] for i in range(cuenta)]
                hpos += cuenta
                destino = huff_dc if info >> 4 == 0 else huff_ac
                destino[info & 15] = _huffman(conteos, valores)
            pos = fin
        elif marcador == 221:
            n = (datos[pos] << 8) | datos[pos + 1]
            if n != 4 or pos + n > len(datos):
                _fallar('DRI inválido')
            reinicio = (datos[pos + 2] << 8) | datos[pos + 3]
            if reinicio:
                _fallar('intervalos de reinicio no soportados')
            pos += n
        elif marcador == 217:
            break
        elif marcador == 1 or 208 <= marcador <= 215:
            continue
        else:
            if pos + 2 > len(datos):
                _fallar('segmento truncado')
            n = (datos[pos] << 8) | datos[pos + 1]
            if n < 2 or pos + n > len(datos):
                _fallar('longitud de segmento inválida')
            pos += n
    if inicio_scan < 0 or not ancho or not alto or not scan:
        _fallar('falta SOF0 o SOS')
    if len(scan) != len(componentes):
        _fallar('se requieren todos los componentes en un solo scan')
    for cid, td, ta in scan:
        comp = componentes[cid]
        if comp['tq'] not in cuantizaciones or td not in huff_dc or ta not in huff_ac:
            _fallar('falta tabla de cuantización o Huffman')
        comp['td'] = td; comp['ta'] = ta
    destino_ancho = ancho if destino_ancho is None else destino_ancho
    destino_alto = alto if destino_alto is None else destino_alto
    if destino_ancho < 1 or destino_alto < 1 or destino_ancho > 320 or destino_alto > 240:
        _fallar('dimensiones de destino inválidas')
    # Al reducir una foto a la TFT se usa el componente DC de cada bloque JPEG,
    # equivalente a su color promedio. El ESP32 emulado no puede hacer una IDCT
    # completa por software a 320×240; el muestreo mantiene color y formas gruesas.
    frecuencias_u = 1 if destino_ancho * 2 <= ancho else 8
    frecuencias_v = 1 if destino_alto * 2 <= alto else 8
    salida = bytearray(destino_ancho * destino_alto * 2)
    bits = _Bits(datos, inicio_scan)
    anteriores = {cid: 0 for cid in componentes}
    mcu_ancho = max_h * 8
    mcu_alto = max_v * 8
    mcu_columnas = (ancho + mcu_ancho - 1) // mcu_ancho
    mcu_filas = (alto + mcu_alto - 1) // mcu_alto
    reducido_dc = frecuencias_u == 1 and frecuencias_v == 1
    if reducido_dc:
        # El recorrido anterior visitaba cada muestra original y sobrescribía
        # varias veces cada píxel destino. Guardar solo la última muestra que
        # llegaba a cada coordenada conserva exactamente su redondeo y encuadre.
        columnas_por_mcu = [[] for _ in range(mcu_columnas)]
        for dx in range(destino_ancho):
            x = ((dx + 1) * ancho - 1) // destino_ancho
            columnas_por_mcu[x // mcu_ancho].append((dx, x % mcu_ancho))
        filas_por_mcu = [[] for _ in range(mcu_filas)]
        for dy in range(destino_alto):
            y = ((dy + 1) * alto - 1) // destino_alto
            filas_por_mcu[y // mcu_alto].append((dy, y % mcu_alto))
    for my in range(mcu_filas):
        for mx in range(mcu_columnas):
            bloques = {}
            for cid, _, _ in scan:
                comp = componentes[cid]
                lista = []
                for _ in range(comp['h'] * comp['v']):
                    bloque, anteriores[cid] = _bloque(bits, huff_dc[comp['td']], huff_ac[comp['ta']], cuantizaciones[comp['tq']], anteriores[cid], frecuencias_u, frecuencias_v)
                    lista.append(bloque)
                bloques[cid] = lista
            base_x = mx * mcu_ancho
            base_y = my * mcu_alto
            if reducido_dc:
                for dy, ly in filas_por_mcu[my]:
                    for dx, lx in columnas_por_mcu[mx]:
                        valores = []
                        for cid, _, _ in scan:
                            comp = componentes[cid]
                            sx = lx * comp['h'] // max_h
                            sy = ly * comp['v'] // max_v
                            indice = (sy // 8) * comp['h'] + (sx // 8)
                            valores.append(bloques[cid][indice][0])
                        if len(valores) == 1:
                            r = g = b = valores[0]
                        else:
                            yy, cb, cr = valores[0], valores[1] - 128, valores[2] - 128
                            r = int(yy + 1.402 * cr + 0.5)
                            g = int(yy - 0.344136 * cb - 0.714136 * cr + 0.5)
                            b = int(yy + 1.772 * cb + 0.5)
                        r = max(0, min(255, r)); g = max(0, min(255, g)); b = max(0, min(255, b))
                        p = (dy * destino_ancho + dx) * 2
                        salida[p] = (r & 248) | (g >> 5)
                        salida[p + 1] = ((g & 28) << 3) | (b >> 3)
                continue
            for ly in range(mcu_alto):
                y = base_y + ly
                if y >= alto:
                    break
                dy = y * destino_alto // alto
                for lx in range(mcu_ancho):
                    x = base_x + lx
                    if x >= ancho:
                        break
                    dx = x * destino_ancho // ancho
                    valores = []
                    for cid, _, _ in scan:
                        comp = componentes[cid]
                        sx = lx * comp['h'] // max_h
                        sy = ly * comp['v'] // max_v
                        indice = (sy // 8) * comp['h'] + (sx // 8)
                        valores.append(bloques[cid][indice][(sy & 7) * 8 + (sx & 7)])
                    if len(valores) == 1:
                        r = g = b = valores[0]
                    else:
                        yy, cb, cr = valores[0], valores[1] - 128, valores[2] - 128
                        r = int(yy + 1.402 * cr + 0.5)
                        g = int(yy - 0.344136 * cb - 0.714136 * cr + 0.5)
                        b = int(yy + 1.772 * cb + 0.5)
                    r = max(0, min(255, r)); g = max(0, min(255, g)); b = max(0, min(255, b))
                    p = (dy * destino_ancho + dx) * 2
                    salida[p] = (r & 248) | (g >> 5)
                    salida[p + 1] = ((g & 28) << 3) | (b >> 3)
    return salida
`;
