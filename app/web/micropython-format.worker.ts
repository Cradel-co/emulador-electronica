import init, { format } from '@wasm-fmt/ruff_fmt/vite';
import type { FormatRequest, FormatResponse } from './micropython-format.js';

// La misma promesa evita inicializaciones WASM simultáneas al recibir varios pedidos.
let ready: Promise<unknown> | null = null;
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FormatRequest>) => void) | null;
  postMessage: (response: FormatResponse) => void;
};
scope.onmessage = async ({ data }) => {
  try {
    ready ??= init();
    await ready;
    const formatted = format(data.source, data.filename, {
      indent_style: 'space',
      indent_width: data.indentWidth,
      line_width: 88,
      quote_style: 'preserve',
      magic_trailing_comma: 'respect',
    });
    scope.postMessage({ id: data.id, formatted });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    scope.postMessage({ id: data.id, error: `No se pudo formatear Python: ${detail}` });
  }
};
