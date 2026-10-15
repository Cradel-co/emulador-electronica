import { test, expect } from '@playwright/test';

// Firmware MicroPython cacheado + esp-emu: no compila en Docker. Ejecución opt-in y serial.
test.skip(!process.env.E2E_EMU, 'requiere esp-emu y firmware MicroPython: E2E_EMU=1');

test('dos ESP32 ejecutan archivos independientes y se comunican por el circuito', async ({ page, request }) => {
  test.setTimeout(120_000);
  const name = `runtime-mb-${Date.now().toString(36)}`;
  const messages: any[] = [];
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    try { messages.push(JSON.parse(String(payload))); } catch { /* frames ajenos */ }
  }));
  expect((await request.post('/api/projects', { data: { name, language: 'micropython', board: 'esp32-s3-devkitc-1' } })).ok()).toBeTruthy();
  const added = await request.post(`/api/projects/${name}/board`, { data: { board: 'esp32-s3-devkitc-1', language: 'micropython', x: 300 } });
  expect(added.ok()).toBeTruthy();
  const project = (await added.json()).project;
  const second = project.boards.find((b: any) => b.id !== 'board').id;
  const boards = project.modules.filter((m: any) => project.boards.some((b: any) => b.id === m.id));
  for (const board of boards) board.props = { ...board.props, usb: true };
  expect((await request.put(`/api/projects/${name}/diagram`, { data: { modules: boards, wires: [
    { from: 'board.GPIO7', to: `${second}.GPIO6` }, { from: 'board.GND', to: `${second}.GND` },
  ] } })).ok()).toBeTruthy();
  const write = async (file: string, content: string, boardId: string) => expect((await request.put(`/api/projects/${name}/files/${file}?boardId=${boardId}`, { data: { content } })).ok()).toBeTruthy();
  await write('lib/__init__.py', '', 'board');
  await write('lib/__init__.py', '', second);
  await write('lib/helper.py', 'def marker():\n    return "PRIMARY_HELPER"\n', 'board');
  await write('lib/helper.py', 'def marker():\n    return "SECONDARY_HELPER"\n', second);
  await write('main.py', `from lib.helper import marker\nfrom machine import Pin\nimport time\nprint(marker())\nout = Pin(7, Pin.OUT)\nwhile True:\n    out.value(1)\n    time.sleep_ms(2000)\n    out.value(0)\n    time.sleep_ms(2000)\n`, 'board');
  await write('main.py', `from lib.helper import marker\nfrom machine import Pin\nimport time\nprint(marker())\ninp = Pin(6, Pin.IN)\nout = Pin(7, Pin.OUT)\nwhile True:\n    out.value(inp.value())\n    time.sleep_ms(100)\n`, second);
  await page.goto(`/#${name}`);
  try {
    expect((await request.post(`/api/projects/${name}/run`)).ok()).toBeTruthy();
    await expect.poll(async () => {
      const snapshot = await (await request.get('/api/emulator')).json();
      return snapshot.boards?.board?.running && snapshot.boards?.[second]?.running;
    }, { timeout: 60_000 }).toBeTruthy();
    await expect.poll(() => messages.some(m => m.type === 'emu.log' && m.boardId === 'board' && m.line.includes('PRIMARY_HELPER')), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => messages.some(m => m.type === 'emu.log' && m.boardId === second && m.line.includes('SECONDARY_HELPER')), { timeout: 60_000 }).toBe(true);
    const snapshot = await (await request.get('/api/emulator')).json();
    const allPorts = Object.values(snapshot.boards).flatMap((s: any) => Object.values(s.ports) as number[]);
    expect(new Set(allPorts).size).toBe(allPorts.length);
    // La salida de la segunda placa copia la entrada conectada a la primera.
    await expect.poll(() => messages.some(m => m.type === 'pin.out' && m.boardId === second && m.pin === 7 && m.level === 1), { timeout: 30_000 }).toBe(true);
    const since = messages.length;
    await expect.poll(() => messages.slice(since).some(m => m.type === 'pin.out' && m.boardId === second && m.pin === 7 && m.level === 0), { timeout: 15_000 }).toBe(true);
    // El target de debug también corresponde a la placa consultada.
    expect((await (await request.get(`/api/debug/state?boardId=${second}`)).json()).capabilities.motor).not.toBe('ninguno');
    const primaryPid = snapshot.boards.board.pid;
    await write('lib/helper.py', 'def marker():\n    return "SECONDARY_RELOADED"\n', second);
    await expect.poll(() => messages.some(m => m.type === 'emu.log' && m.boardId === second && m.line.includes('SECONDARY_RELOADED')), { timeout: 30_000 }).toBe(true);
    const reloaded = await (await request.get('/api/emulator')).json();
    expect(reloaded.boards.board.pid).toBe(primaryPid);
    expect(reloaded.boards.board.running).toBe(true);
    expect((await request.post('/api/emulator/reset', { data: { boardId: 'missing' } })).status()).toBe(404);
    // Detener mientras una nueva ejecución está compilando/arrancando no debe dejar un proceso tardío.
    expect((await request.post(`/api/projects/${name}/run`)).ok()).toBeTruthy();
    expect((await request.post('/api/emulator/stop')).ok()).toBeTruthy();
    await page.waitForTimeout(1000);
    const cancelled = await (await request.get('/api/emulator')).json();
    expect(cancelled.status.running).toBe(false);
    expect(Object.values(cancelled.boards).every((s: any) => !s.running)).toBe(true);
  } finally {
    await request.post('/api/emulator/stop');
    const stopped = await (await request.get('/api/emulator')).json();
    expect(stopped.status.running).toBe(false);
    expect(Object.values(stopped.boards).every((s: any) => !s.running)).toBe(true);
  }
});
