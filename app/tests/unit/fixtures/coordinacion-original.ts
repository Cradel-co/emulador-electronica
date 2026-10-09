// Instantánea de main ca9171a anterior a la extracción. Solo oráculo de caracterización.
export const colaOriginal = `function runProject(project: { name: string }, forceBuild: boolean) {
  const generation = ++runGeneration;
  const job = runQueue.catch(() => {}).then(async () => {
    executingProject = project.name;
    try { return await ejecutarProyecto(project, forceBuild, generation); }
    finally { executingProject = null; }
  });
  runQueue = job;
  return job;
}
`;

export const observacionOriginal = `async function avisosDelProyecto(
  project: Project,
): Promise<{
  pins: number[];
  warnings: DiagramWarning[];
  /**
   * placa: null = proyecto sin placa. energizado: el circuito sin placa está prendido (▶).
   * tensiones: lo que mediría un tester en cada pin cableado.
   */
  electrico: ObservacionElectrica;
}> {
  const generacion = runGeneration;
  const corriendo = runningProject;
  const energizado = proyectoEnergizado;
  const revision = revisionElectrica(project);
  const vigente = vigenciaElectrica.capturar(() => generacion === runGeneration
    && corriendo === runningProject && energizado === proyectoEnergizado);
  const placas = placasDelProyecto(project).map(b => b.id);
  const reportados = project.name === corriendo
    ? new Map([...nivelesPorPlaca].filter(([id]) => placas.includes(id)).map(([id, niveles]) => [id, new Map(niveles)])) : new Map<string, Map<number, 0 | 1>>();
  const pwm = new Map(placas.map(id => [id, project.name === corriendo ? new Map(pwmDePlaca(id)) : new Map<number, PwmPin>()]));
  const pwmSnapshot = (id: string): ReadonlyMap<number, PwmPin> => pwm.get(id) ?? new Map();
  const cerrados = new Set(cerradosDe(project.name));
  const fuentesApagadas = !project.board && energizado !== project.name;
  const pins = await pinsDeCodigo(project);
  const catalogo = await loadCatalog();
  const buscar = (t: string): ModuloCatalogo | undefined => catalogo.find((m) => m.type === t);
  const conLaPlaca = conPlaca(project);
  // Con los niveles reales de la simulación: avisos, lo que entrega cada fuente, si la placa tiene energía.
  const estados = estadosModulos.get(project.name) ?? new Map<string, Record<string, unknown>>();
  const direccionesPorPlaca = await direccionesTodas(project);
  const direcciones = direccionesPorPlaca.get(placasDelProyecto(project)[0]?.id ?? 'board') ?? new Map<number, DireccionPin>();
  // Un pin con PWM activo se resuelve en alto: el registro GPIO_OUT que muestrea el puente no
  // refleja lo que maneja el LEDC. Ver nivelesConPwm en pwmEsp.ts.
  const niveles = nivelesConPwm(reportados, pwmSnapshot, placas);
  const vivo = await analizarCircuito(conLaPlaca, buscar, { nivelesReales: true, nivelesPorPlaca: niveles, cerrados, fuentesApagadas, estados, direccionesPorPlaca });
  // Lo que cada modelo quiere recordar vuelve en el próximo cálculo (solo del vivo: los otros son hipotéticos).

  const placa = project.board ? estadoAlimentacion(vivo.alimentacion, vivo.resuelto) : null;
  // Misma instantánea para UI, medidas y diagnóstico: LED activo bajo o entre dos
  // GPIO depende de niveles reales. Todos-altos/todos-bajos no son un peor caso general.
  const leds = vivo.leds;
  const { avisos: electricos, fuentes } = vivo;
  const electrico = await finalizarObservacion({
      contexto: { proyecto: project.name, placas, corrida: generacion, revision, topologia: firmaDiagramaElectrico(conLaPlaca) },
      estado: vivo.resuelto ? 'valida' : 'no-resuelta',
      nivelesPorPlaca: Object.fromEntries([...reportados].map(([id, valores]) => [id, Object.fromEntries(valores)])),
      resuelto: vivo.resuelto,
      leds, fuentes, placa, energizado: energizado === project.name, tensiones: vivo.tensiones,
      placas: Object.fromEntries(Object.entries(vivo.alimentacionesPorPlaca ?? {}).map(([id, a]) => [id, estadoAlimentacion(a, vivo.resuelto)])),
      mediciones: vivo.elementos.map((e) => {
        const inst = project.modules.find((m) => m.id === e.dueno);
        const def = inst ? buscar(inst.type) : undefined;
        return {
          modulo: e.dueno,
          moduloNombre: e.dueno === 'board' ? 'Placa' : def?.name ?? e.dueno,
          elemento: e.local,
          tipo: e.tipo,
          tensionV: e.va - e.vb,
          corrienteMa: e.i * 1000,
          potenciaMw: e.p * 1000,
          resistenciaOhm: e.ohms ?? null,
        };
      }),
      modulos: Object.fromEntries(Object.entries(vivo.modulos).map(([id, m]) => [id, m.ui ?? {}])),
      sonidos: sonidosDelCircuito(
        project.modules, (t) => buscar(t)?.salidas, vivo.tensiones,
        (id) => vivo.modulos[id]?.ui,
        // El PWM está indexado por GPIO de la placa; gpioDe sigue el cableado (y los passthrough).
        (id, pin) => {
          if (project.name !== corriendo) return undefined;
          for (const placa of placasDelProyecto(project)) {
            const gpio = gpioDe(project, id, pin, buscar, placa.id);
            if (gpio === null) continue;
            const pwm = pwmSnapshot(placa.id).get(gpio);
            if (pwm) return pwm;
          }
          return undefined;
        },
      ),
    }, async () => {
      if (!vigente()) return false;
      const actual = await store.read(project.name).catch(() => null);
      return vigente() && actual !== null && revisionElectrica(actual) === revision;
    });
  if (electrico.estado === 'valida') {
    for (const [id, m] of Object.entries(vivo.modulos)) if (m.estado) estados.set(id, m.estado);
    estadosModulos.set(project.name, estados);
  }
  return {
    pins, electrico,
    warnings: [
      ...(electrico.estado === 'obsoleta' ? [{ kind: 'advertencia-electrica' as const, pin: -1,
        message: 'La observación eléctrica quedó obsoleta durante el cálculo; solicitá una lectura nueva.' }] : []),
      ...diffDiagramVsCode(project, pins, project.board ? buscar(project.board)?.board : undefined),
      ...(electrico.estado !== 'obsoleta' ? electricos : []).map((a) => ({
        kind: a.severidad === 'peligro' ? ('peligro-electrico' as const) : ('advertencia-electrica' as const),
        pin: a.pin,
        message: a.mensaje,
        refs: a.refs,
      })),
    ],
  };
}
`;

export const guardadoOriginal = `let revisionDiagrama = 0;
let guardadoDiagrama: Promise<unknown> = Promise.resolve();

/** Serializa guardados para que la cámara no abra una instancia aún sin persistir. */
function enviarDiagrama(proyecto: string, contenido: string) {
  guardadoDiagrama = guardadoDiagrama.catch(() => {}).then(() => api(\`/api/projects/\${encodeURIComponent(proyecto)}/diagram\`, { method: 'PUT', body: contenido }));
  return guardadoDiagrama;
}

async function esperarDiagramaCamara(proyecto: string) {
  while (true) {
    if (state.proyecto?.name !== proyecto) throw new Error('El proyecto cambió.');
    const revision = revisionDiagrama;
    if (state.timerDiagrama) {
      clearTimeout(state.timerDiagrama);
      state.timerDiagrama = null;
      void enviarDiagrama(proyecto, JSON.stringify(state.diagrama));
    }
    await guardadoDiagrama;
    if (state.proyecto?.name !== proyecto) throw new Error('El proyecto cambió.');
    if (revisionDiagrama === revision && !state.timerDiagrama) return;
  }
}
function guardarDiagrama() {
  if (topologiaObservada !== firmaDiagramaElectrico(state.diagrama)) {
    invalidarObservacionFisica();
    lienzo.refrescarFisica();
  }
  revisionDiagrama++;
  // Todos los cambios del dibujo pasan por acá: es el lugar para avisarle a React, que no ve
  // las mutaciones de adentro de \`wires\`/\`modules\` (ver react/estado.ts).
  notificar();
  clearTimeout(state.timerDiagrama);
  const proyecto = state.proyecto?.name;
  if (!proyecto) return;
  // La tarea pendiente pertenece a esta versión, aunque se cambie de proyecto antes de ejecutarla.
  const contenido = JSON.stringify(state.diagrama);
  state.timerDiagrama = setTimeout(async () => {
    state.timerDiagrama = null;
    try {
      await enviarDiagrama(proyecto, contenido);
      if (state.proyecto?.name === proyecto) await refrescarAvisos();
    } catch (e: any) {
      nota(\`No se pudo guardar el circuito: \${String(((e as Error))?.message ?? e)}\`);
    }
  }, 300);
}

/** Manda ya el guardado pendiente (al recargar/cerrar la pestaña o cambiar de proyecto). */
function guardarDiagramaYa() {
  if (!state.timerDiagrama || !state.proyecto) return;
  clearTimeout(state.timerDiagrama);
  state.timerDiagrama = null;
  // keepalive: el pedido sale aunque la página se esté cerrando.
  void fetch(\`/api/projects/\${state.proyecto.name}/diagram\`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-cliente': CLIENTE },
    body: JSON.stringify(state.diagrama),
    keepalive: true,
  }).catch(() => {});
}
`;


export const transporteOriginal = `function broadcastLog(line: string): void {
  console.log(line);
  const data = JSON.stringify({ type: 'emu.log', line } satisfies ServerEvent);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
}

function broadcast(msg: ServerEvent): void {
  const parsed = ServerEventSchema.safeParse(msg);
  if (!parsed.success) {
    // Un evento mal formado no debe caer al cliente ni romper la sesión.
    broadcastLog(\`evento inválido: \${parsed.error.message}\`);
    return;
  }
  const data = JSON.stringify(parsed.data);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}`;
