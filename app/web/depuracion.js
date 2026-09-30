// Ventana "Debug" (como la de Android Studio / VS Code) sobre la API /api/debug del server,
// que usa los nombres del Debug Adapter Protocol: pila (stackTrace), scopes, variables,
// evaluate, breakpoints, pause/continue/next/stepIn/stepOut. Ver docs/depuracion.md.
//
// También dibuja los breakpoints en el margen del editor y la línea donde se detuvo, y un
// analizador lógico con los cambios de pines que manda la grabadora (debug.trace).

/**
 * @typedef {{
 *   api: (path: string, opts?: any) => Promise<any>,
 *   $: (id: string) => HTMLElement,
 *   escapar: (s: string) => string,
 *   nota: (texto: string) => void,
 *   log: (tab: string, texto: string) => void,
 *   proyecto: () => { name: string } | null,
 *   archivoActivo: () => string | null,
 *   archivos: () => { path: string }[],
 *   irALinea: (archivo: string | undefined, linea: number) => Promise<void>,
 *   abrirVentanaDebug: () => void,
 *   debugVisible: () => boolean,
 *   nombrePin: (gpio: number) => string,
 *   altoLinea: number,
 *   padEditor: number,
 *   scrollEditor: () => number,
 * }} ContextoDebug
 */

const VENTANA_PINES_MS = 10000;

/** @param {ContextoDebug} ctx */
export function crearDepuracion(ctx) {
  const { $, api, escapar } = ctx;
  const estado = {
    /** @type {any} */ capacidades: null,
    /** @type {any} */ parada: null, // state del server cuando status === 'stopped'
    corriendo: false,
    /** archivo → líneas con breakpoint */
    breakpoints: /** @type {Map<string, Set<number>>} */ (new Map()),
    /** archivo → líneas verificadas por el depurador (las otras se ven huecas) */
    verificados: /** @type {Map<string, Set<number>>} */ (new Map()),
    marcoElegido: /** @type {number | undefined} */ (undefined),
    timerVars: 0,
    pines: /** @type {Map<number, { t: number, nivel: number, dir: string }[]>} */ (new Map()),
    ultimoT: 0,
    ultimoPerf: 0,
    corridaTrace: null,
    framePines: 0,
    /** Variables expandidas (por evaluateName o nombre): se mantienen al refrescar. */
    abiertas: new Set(),
  };

  // --- Estado y botones ---------------------------------------------------------------

  async function refrescarEstado() {
    const r = await api('/api/debug/state').catch(() => null);
    if (!r) return;
    estado.capacidades = r.capabilities;
    aplicarEstado(r.state);
    marcarVerificados(r.breakpoints ?? []);
  }

  function aplicarEstado(s) {
    estado.parada = s?.status === 'stopped' ? s : null;
    estado.corriendo = s?.status === 'running';
    const c = estado.capacidades ?? {};
    const parado = Boolean(estado.parada);
    /** @type {HTMLButtonElement} */ ($('dbg-continuar')).disabled = !parado;
    /** @type {HTMLButtonElement} */ ($('dbg-pausa')).disabled = !(estado.corriendo && c.pause);
    for (const id of ['dbg-sobre', 'dbg-adentro']) /** @type {HTMLButtonElement} */ ($(id)).disabled = !(parado && c.step);
    /** @type {HTMLButtonElement} */ ($('dbg-afuera')).disabled = !(parado && c.step && c.stackTrace === 'exacto');
    const texto = parado
      ? `En pausa${s.reason ? ` (${traducirMotivo(s.reason)})` : ''}${s.source ? ` · ${s.source.name}:${s.line}` : s.function ? ` · ${s.function}` : ''}`
      : estado.corriendo
        ? 'Corriendo'
        : (s?.description ?? 'Sin ejecución');
    $('dbg-estado').textContent = texto;
    $('dbg-estado').dataset.s = parado ? 'parado' : estado.corriendo ? 'corriendo' : 'no';
    $('dbg-motor').textContent = c.motor && c.motor !== 'ninguno' ? `motor: ${c.motor}` : '';
    $('dbg-motor').title = (c.notas ?? []).join('\n');
    document.body.classList.toggle('depuracion-parada', parado);
    if (parado) {
      // La barra de estado la escribe emu.state; en pausa, el emulador sigue "corriendo" para él.
      $('estado').textContent = 'en pausa';
      $('estado').dataset.s = 'paused';
    }
    pintarParada();
  }

  /** Lo que la grabadora ya tiene de pines (al recargar la página o abrir la ventana tarde). */
  async function cargarTrazaPines() {
    const r = await api('/api/debug/trace?types=pin&limit=2000').catch(() => null);
    if (!r?.eventos) return;
    estado.pines.clear();
    estado.corridaTrace = r.corrida?.inicio ?? null;
    recibirTraza(r.eventos);
  }

  const MOTIVOS = { pause: 'pausa', breakpoint: 'breakpoint', step: 'paso', exception: 'excepción', entry: 'inicio' };
  const traducirMotivo = (m) => MOTIVOS[m] ?? m;

  async function control(action) {
    try {
      const r = await api('/api/debug/control', { method: 'POST', body: JSON.stringify({ action, waitMs: 1500 }) });
      if (r?.state) aplicarEstado(r.state);
      await refrescarTodo();
    } catch (e) {
      ctx.nota(String(/** @type {Error} */ (e)?.message ?? e));
    }
  }

  // --- Pila y variables ------------------------------------------------------------------

  async function refrescarTodo() {
    if (!ctx.debugVisible() && !estado.parada) return;
    await Promise.all([pintarPila(), pintarVariables()]);
  }

  async function pintarPila() {
    const ul = $('dbg-pila');
    if (!estado.parada || estado.capacidades?.stackTrace === 'no') {
      ul.innerHTML = `<li class="dbg-vacio">${estado.parada ? 'Este motor no da la pila.' : 'La pila aparece cuando el programa se detiene (breakpoint o pausa).'}</li>`;
      return;
    }
    const r = await api('/api/debug/stack').catch(() => null);
    const marcos = r?.stackFrames ?? [];
    ul.innerHTML = marcos.length
      ? marcos
          .map((f, i) => `<li data-i="${i}" class="${(estado.marcoElegido ?? marcos[0].id) === f.id ? 'sel' : ''}"><b>${escapar(f.name)}</b><span>${f.source ? `${escapar(f.source.name)}:${f.line}` : f.instructionPointerReference ?? ''}${f.aproximado ? ' ≈' : ''}</span></li>`)
          .join('')
      : '<li class="dbg-vacio">Sin marcos.</li>';
    for (const li of ul.querySelectorAll('li[data-i]')) {
      /** @type {HTMLElement} */ (li).onclick = () => {
        const f = marcos[Number(/** @type {HTMLElement} */ (li).dataset.i)];
        estado.marcoElegido = f.id;
        if (f.source && f.line) void ctx.irALinea(archivoDe(f.source), f.line);
        void pintarPila();
        void pintarVariables();
      };
    }
  }

  async function pintarVariables() {
    const cont = $('dbg-variables');
    if (!estado.capacidades?.variables) {
      cont.innerHTML = `<p class="dbg-vacio">${estado.capacidades?.motor === 'ninguno' || !estado.capacidades ? 'Ejecutá el proyecto: las variables del firmware aparecen acá.' : 'Este motor no permite leer variables.'}</p>`;
      return;
    }
    const q = estado.parada && estado.marcoElegido !== undefined ? `?frameId=${estado.marcoElegido}` : '';
    const r = await api(`/api/debug/scopes${q}`).catch(() => null);
    const scopes = r?.scopes ?? [];
    const frag = document.createDocumentFragment();
    for (const s of scopes) {
      const hijos = await api(`/api/debug/variables?ref=${s.variablesReference}`).catch(() => null);
      const grupo = document.createElement('details');
      grupo.className = 'dbg-scope';
      grupo.open = !s.expensive || estado.abiertas.has(`scope:${s.name}`);
      grupo.innerHTML = `<summary>${escapar(s.name)}</summary>`;
      grupo.addEventListener('toggle', () => recordar(`scope:${s.name}`, grupo.open));
      for (const v of hijos?.variables ?? []) grupo.append(filaVariable(v, 0));
      frag.append(grupo);
    }
    cont.textContent = '';
    cont.append(frag);
    if (!scopes.length) cont.innerHTML = '<p class="dbg-vacio">Sin variables todavía.</p>';
  }

  function recordar(clave, abierta) {
    if (abierta) estado.abiertas.add(clave);
    else estado.abiertas.delete(clave);
  }

  /** Una variable del árbol; si tiene hijos, se cargan al expandirla (como en el IDE). */
  function filaVariable(v, nivel) {
    const fila = document.createElement('div');
    fila.className = 'dbg-var';
    fila.style.setProperty('--nivel', String(nivel));
    const clave = v.evaluateName ?? `${nivel}:${v.name}`;
    const expandible = v.variablesReference > 0;
    fila.innerHTML = `<span class="dbg-flecha">${expandible ? '▸' : ''}</span><span class="dbg-nombre">${escapar(v.name)}</span><span class="dbg-igual">=</span><span class="dbg-valor">${escapar(String(v.value))}</span>${v.type ? `<span class="dbg-tipo">${escapar(v.type)}</span>` : ''}`;
    if (!expandible) return fila;
    const envoltorio = document.createElement('div');
    const hijos = document.createElement('div');
    hijos.hidden = true;
    const abrir = async (sin) => {
      const abierta = sin ?? hijos.hidden;
      hijos.hidden = !abierta;
      fila.classList.toggle('abierta', abierta);
      recordar(clave, abierta);
      if (abierta) {
        const r = await api(`/api/debug/variables?ref=${v.variablesReference}`).catch(() => null);
        hijos.textContent = '';
        for (const h of r?.variables ?? []) hijos.append(filaVariable(h, nivel + 1));
      }
    };
    fila.onclick = () => void abrir();
    envoltorio.append(fila, hijos);
    if (estado.abiertas.has(clave)) void abrir(true);
    return envoltorio;
  }

  async function evaluar() {
    const input = /** @type {HTMLInputElement} */ ($('dbg-eval'));
    const expresion = input.value.trim();
    if (!expresion) return;
    const res = $('dbg-eval-res');
    try {
      const r = await api('/api/debug/evaluate', { method: 'POST', body: JSON.stringify({ expression: expresion }) });
      res.textContent = '';
      res.append(filaVariable({ name: expresion, value: r.result, type: r.type, variablesReference: r.variablesReference ?? 0 }, 0));
    } catch (e) {
      res.innerHTML = `<p class="dbg-error">${escapar(String(/** @type {Error} */ (e)?.message ?? e))}</p>`;
    }
  }

  /** Mientras corre y la ventana está a la vista, las variables se leen en vivo (una vez por segundo). */
  function vigilarVariables() {
    clearInterval(estado.timerVars);
    estado.timerVars = window.setInterval(() => {
      if (ctx.debugVisible() && estado.corriendo && estado.capacidades?.variables) void pintarVariables();
    }, 1000);
  }

  // --- Breakpoints en el margen del editor ---------------------------------------------------

  /** Archivo del proyecto al que se refiere una ruta del depurador ("main.yaml", "src/sketch.cpp"...). */
  function archivoDe(source) {
    const ruta = source?.path ?? source?.name ?? '';
    const lista = ctx.archivos().map((f) => f.path);
    return lista.find((p) => p === ruta) ?? lista.find((p) => ruta.endsWith(`/${p}`) || p.endsWith(`/${source?.name}`) || p === source?.name) ?? ruta;
  }

  function marcarVerificados(lista) {
    estado.breakpoints.clear();
    estado.verificados.clear();
    for (const b of lista) {
      if (!b.source || !b.line) continue;
      const archivo = archivoDe(b.source);
      if (!estado.breakpoints.has(archivo)) estado.breakpoints.set(archivo, new Set());
      estado.breakpoints.get(archivo)?.add(b.line);
      if (b.verified) {
        if (!estado.verificados.has(archivo)) estado.verificados.set(archivo, new Set());
        estado.verificados.get(archivo)?.add(b.line);
      }
    }
    pintarBreakpoints();
  }

  async function cargarBreakpoints() {
    const p = ctx.proyecto();
    if (!p) return;
    const r = await api(`/api/debug/breakpoints?project=${encodeURIComponent(p.name)}`).catch(() => null);
    marcarVerificados(r?.breakpoints ?? []);
  }

  async function alternarBreakpoint(linea) {
    const p = ctx.proyecto();
    const archivo = ctx.archivoActivo();
    if (!p || !archivo) return;
    const lineas = new Set(estado.breakpoints.get(archivo) ?? []);
    if (lineas.has(linea)) lineas.delete(linea);
    else lineas.add(linea);
    estado.breakpoints.set(archivo, lineas);
    pintarBreakpoints();
    try {
      const r = await api('/api/debug/breakpoints', {
        method: 'PUT',
        body: JSON.stringify({ project: p.name, source: archivo, lines: [...lineas].sort((a, b) => a - b) }),
      });
      const nuevos = (r?.breakpoints ?? []).filter((b) => b.source && archivoDe(b.source) === archivo);
      const noVerif = nuevos.filter((b) => !b.verified && b.message && b.message !== 'se pone al ejecutar');
      if (noVerif.length) ctx.nota(`Breakpoint en ${archivo}:${noVerif[0].line}: ${noVerif[0].message}`);
      estado.verificados.set(archivo, new Set(nuevos.filter((b) => b.verified).map((b) => b.line)));
      pintarBreakpoints();
    } catch (e) {
      ctx.nota(String(/** @type {Error} */ (e)?.message ?? e));
    }
  }

  /** Puntos rojos en el margen (dentro del gutter, así se desplazan con él). */
  function pintarBreakpoints() {
    const capa = $('bp-capa');
    const archivo = ctx.archivoActivo();
    const lineas = (archivo && estado.breakpoints.get(archivo)) || new Set();
    const verif = (archivo && estado.verificados.get(archivo)) || new Set();
    capa.textContent = '';
    for (const l of lineas) {
      const d = document.createElement('div');
      d.className = `bp${verif.has(l) ? ' verificado' : ''}`;
      d.style.top = `${ctx.padEditor + (l - 1) * ctx.altoLinea}px`;
      d.title = verif.has(l) ? 'Breakpoint (click para sacarlo)' : 'Breakpoint: se activa al ejecutar';
      capa.append(d);
    }
    pintarParada();
  }

  /** Resalta la línea donde se detuvo el programa (si es el archivo abierto). */
  function pintarParada() {
    const barra = $('linea-parada');
    const s = estado.parada;
    const archivo = ctx.archivoActivo();
    if (!s?.source || !s.line || !archivo || archivoDe(s.source) !== archivo) {
      barra.hidden = true;
      return;
    }
    barra.hidden = false;
    barra.style.transform = `translateY(${ctx.padEditor + (s.line - 1) * ctx.altoLinea - ctx.scrollEditor()}px)`;
  }

  $('gutter').addEventListener('mousedown', (e) => {
    const g = $('gutter');
    const r = g.getBoundingClientRect();
    const linea = Math.floor((e.clientY - r.top + g.scrollTop - ctx.padEditor) / ctx.altoLinea) + 1;
    if (linea >= 1) {
      e.preventDefault();
      void alternarBreakpoint(linea);
    }
  });

  // --- Analizador lógico de pines -------------------------------------------------------

  function recibirTraza(eventos) {
    for (const ev of eventos) {
      if (ev.corrida !== undefined && ev.corrida !== estado.corridaTrace) {
        estado.corridaTrace = ev.corrida;
        estado.pines.clear();
      }
      if (typeof ev.t === 'number' && ev.t < estado.ultimoT - 1000) estado.pines.clear(); // arrancó otra corrida
      if (typeof ev.t === 'number') {
        estado.ultimoT = ev.t;
        estado.ultimoPerf = performance.now();
      }
      if (ev.tipo !== 'pin' || typeof ev.pin !== 'number') continue;
      const lista = estado.pines.get(ev.pin) ?? [];
      lista.push({ t: ev.t, nivel: Number(ev.nivel), dir: String(ev.direccion ?? '') });
      if (lista.length > 2000) lista.splice(0, lista.length - 2000);
      estado.pines.set(ev.pin, lista);
    }
    pedirPines();
  }

  function pedirPines() {
    if (!estado.framePines && ctx.debugVisible()) estado.framePines = requestAnimationFrame(pintarPines);
  }

  function pintarPines() {
    estado.framePines = 0;
    const canvas = /** @type {HTMLCanvasElement} */ ($('dbg-pines'));
    const caja = canvas.getBoundingClientRect();
    if (!caja.width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(caja.width * dpr);
    canvas.height = Math.round(caja.height * dpr);
    const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    g.scale(dpr, dpr);
    g.clearRect(0, 0, caja.width, caja.height);
    const pines = [...estado.pines.keys()].sort((a, b) => a - b);
    g.font = '11px ui-monospace, monospace';
    if (!pines.length) {
      g.fillStyle = '#6f737a';
      g.fillText('Los cambios de pines aparecen acá mientras corre la simulación.', 10, 20);
      return;
    }
    const ahora = estado.ultimoT + (estado.corriendo ? performance.now() - estado.ultimoPerf : 0);
    const izq = 64;
    const ancho = caja.width - izq - 8;
    const alto = Math.min(34, (caja.height - 16) / pines.length);
    const xDe = (t) => izq + ancho * (1 - (ahora - t) / VENTANA_PINES_MS);
    pines.forEach((pin, i) => {
      const y0 = 6 + i * alto;
      const arriba = y0 + 4;
      const abajo = y0 + alto - 8;
      const lista = estado.pines.get(pin) ?? [];
      const salida = lista.some((p) => p.dir === 'salida');
      g.fillStyle = '#9da0a8';
      g.fillText(`${ctx.nombrePin(pin)} ${salida ? '→' : '←'}`, 6, (arriba + abajo) / 2 + 4);
      g.strokeStyle = salida ? '#5fb865' : '#548af7';
      g.lineWidth = 1.5;
      g.beginPath();
      // Nivel antes de la ventana: el último cambio anterior.
      let nivel = 0;
      for (const p of lista) if (p.t <= ahora - VENTANA_PINES_MS) nivel = p.nivel;
      let x = izq;
      g.moveTo(x, nivel ? arriba : abajo);
      for (const p of lista) {
        if (p.t <= ahora - VENTANA_PINES_MS) continue;
        const xp = xDe(p.t);
        g.lineTo(xp, nivel ? arriba : abajo);
        nivel = p.nivel;
        g.lineTo(xp, nivel ? arriba : abajo);
        x = xp;
      }
      g.lineTo(izq + ancho, nivel ? arriba : abajo);
      g.stroke();
    });
    // Escala de tiempo: marcas cada segundo.
    g.fillStyle = '#4b5059';
    for (let s = 0; s <= VENTANA_PINES_MS / 1000; s++) g.fillRect(izq + (ancho * s) / (VENTANA_PINES_MS / 1000), caja.height - 6, 1, 4);
    if (estado.corriendo) pedirPines();
  }

  // --- Botones y eventos ----------------------------------------------------------------------

  $('dbg-continuar').onclick = () => void control('continue');
  $('dbg-pausa').onclick = () => void control('pause');
  $('dbg-sobre').onclick = () => void control('next');
  $('dbg-adentro').onclick = () => void control('stepIn');
  $('dbg-afuera').onclick = () => void control('stepOut');
  $('dbg-eval').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void evaluar();
  });
  vigilarVariables();

  return {
    /** Mensajes del WebSocket con type "debug.*" (y emu.state para saber si corre). */
    alMensaje(msg) {
      switch (msg.type) {
        case 'debug.stopped': {
          const s = { ...msg, status: 'stopped' };
          estado.marcoElegido = undefined;
          void refrescarEstado().then(() => {
            aplicarEstado(s);
            ctx.abrirVentanaDebug(); // como el IDE: al detenerse, se ve la ventana de depuración
            if (s.source && s.line) void ctx.irALinea(archivoDe(s.source), s.line).then(pintarParada);
            void refrescarTodo();
          });
          break;
        }
        case 'debug.continued':
          aplicarEstado({ status: 'running' });
          void pintarPila();
          break;
        case 'debug.trace':
          recibirTraza(msg.eventos ?? []);
          break;
        case 'debug.exception': {
          const e = msg.error ?? {};
          ctx.nota(`Error en el firmware: ${e.mensaje ?? 'ver la consola'}`);
          ctx.log('emu', `[debug] ${e.mensaje ?? JSON.stringify(e)}`);
          const marco = e.marcos?.at(-1);
          if (marco?.archivo && marco?.linea) void ctx.irALinea(archivoDe({ path: marco.archivo, name: marco.archivo }), marco.linea);
          break;
        }
        case 'emu.state':
          void refrescarEstado();
          break;
      }
    },
    /** Al abrir un proyecto o cambiar de archivo. */
    alCambiarArchivo() {
      pintarBreakpoints();
    },
    async alAbrirProyecto() {
      estado.pines.clear();
      await cargarBreakpoints();
      await refrescarEstado();
      await cargarTrazaPines();
    },
    /** Al mostrar la pestaña Debug. */
    alMostrar() {
      void refrescarEstado().then(refrescarTodo);
      if (!estado.pines.size) void cargarTrazaPines();
      pedirPines();
    },
    alScroll: pintarParada,
    control,
    alternarBreakpointEnCursor(linea) {
      void alternarBreakpoint(linea);
    },
    estaParado: () => Boolean(estado.parada),
  };
}
