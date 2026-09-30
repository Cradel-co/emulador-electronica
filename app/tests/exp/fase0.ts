/**
 * Cliente de la Fase 0 (E1-E4) contra el puente TCP de UART1 del emulador.
 *
 *   node --experimental-strip-types tests/exp/fase0.ts <host> <puertoUART1>
 *
 * No usa dependencias: es el mismo protocolo de texto que implementa
 * server/src/bridgeClient.ts, para validar el firmware y no la app.
 */
import net from 'node:net';

const host = process.argv[2] ?? '127.0.0.1';
const port = Number(process.argv[3] ?? 20101);

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

const sock = net.createConnection({ host, port });
sock.setEncoding('utf8');

let buffer = '';
const inbox: string[] = [];
const waiters: { re: RegExp; resolve: (line: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];

sock.on('data', (chunk: string) => {
  buffer += chunk;
  let i: number;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).replace(/\r$/, '');
    buffer = buffer.slice(i + 1);
    inbox.push(line);
    console.log(`  <  ${line}`);
    for (let w = 0; w < waiters.length; w++) {
      if (waiters[w]!.re.test(line)) {
        clearTimeout(waiters[w]!.timer);
        waiters.splice(w, 1)[0]!.resolve(line);
        break;
      }
    }
  }
});

/** Espera una línea que matchee el patrón (o falla con timeout). */
function waitLine(re: RegExp, ms = 5000): Promise<string> {
  const already = inbox.find((l) => re.test(l));
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout esperando ${re}`)), ms);
    waiters.push({ re, resolve, reject, timer });
  });
}

function send(line: string): void {
  console.log(`  >  ${line}`);
  sock.write(line.endsWith('\n') ? line : line + '\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

sock.on('connect', () => void main());
sock.on('error', (e) => {
  console.error('error de socket:', (e as Error).message);
  process.exit(1);
});

async function main(): Promise<void> {
  console.log(`\n== E1: @HELLO / @READY (${host}:${port})`);
  send('@HELLO 1');
  const ready = await waitLine(/^@READY 1 /, 8000).catch((e) => `ERR: ${(e as Error).message}`);
  ok('el firmware responde @READY 1 <version>', /^@READY 1 \S+/.test(ready), String(ready));

  console.log('\n== E2 + E3: @IN 6 0 -> el botón lo ve y prende el LED -> @OUT 7 1');
  // GPIO6 es INPUT_PULLUP: en LOW el firmware lo lee como pulsado y hace
  // output.turn_on del LED (GPIO7), que el puente debe reportar (7.2).
  send('@WATCH 7');
  await sleep(300);
  send('@IN 6 0');
  const out = await waitLine(/^@OUT 7 1/, 6000).catch((e) => `ERR: ${(e as Error).message}`);
  ok('la entrada inyectada llega al firmware y produce la salida', out.startsWith('@OUT 7 1'), String(out));
  send('@IN 6 1');
  const outOff = await waitLine(/^@OUT 7 0/, 6000).catch((e) => `ERR: ${(e as Error).message}`);
  ok('al soltar el botón el LED se apaga', outOff.startsWith('@OUT 7 0'), String(outOff));

  console.log('\n== E4: captura de RF (remote_transmitter emite cada 8 s)');
  send('@WATCH 5');  // GPIO5 = DATA del transmisor
  let tx = '';
  try {
    tx = await waitLine(/^@TX /, 12000);
  } catch (e) {
    tx = `ERR: ${(e as Error).message}`;
  }
  const bits = tx.match(/^@TX \S+ ([01]+) /);
  ok('llega una trama RF capturada', /^@TX /.test(tx) && !!bits, String(tx));
  if (bits) {
    console.log(`       bits: ${bits[1]}  (${bits[1]!.length} pulsos)`);
    // NEC: 32 bits con los últimos 8 invertidos.
    const b = bits[1]!;
    ok('la trama parece NEC (32 bits)', b.length === 32, `largo ${b.length}`);
  }

  console.log('\n== PING');
  send('@PING');
  const pong = await waitLine(/^@PONG/, 5000).catch((e) => `ERR: ${(e as Error).message}`);
  ok('responde @PONG', pong.startsWith('@PONG'), String(pong));

  console.log(`\n== Resultado: ${pass} pass, ${fail} fail`);
  sock.end();
  process.exit(fail === 0 ? 0 : 1);
}
