import { useEffect, useState } from 'react';
import { acciones, estado } from './puente.js';
import { useEstado } from './estado.js';
import { rutaNuevaEntrada, type EntryCreationContext } from '../file-tree.js';
/** Formulario nativo reutilizable dentro de un dialog; el controlador recibe su returnValue. */
export function FileNameForm({ title, label, hint, inputId, placeholder, resetKey, create, accept = 'Crear' }: {
  title: string; label: string; hint: string; inputId: string; placeholder?: string; accept?: string;
  resetKey?: unknown; create: (name: string) => Promise<void>;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => { setError(''); }, [resetKey]);
  return <form method="dialog" onSubmit={async event => {
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value !== 'crear') { setError(''); return; }
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const input = form.elements.namedItem('nombre') as HTMLInputElement | null;
    const name = input?.value.trim() ?? '';
    setPending(true); setError('');
    try { await create(name); form.closest('dialog')?.close('crear'); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  }}>
    <h2>{title}</h2>
    <label htmlFor={inputId}>{label}</label>
    <input name="nombre" id={inputId} required disabled={pending} placeholder={placeholder} autoComplete="off" />
    <p>{hint}</p>
    {error && <p role="alert">{error}</p>}
    <div className="acciones"><button value="cancelar" formNoValidate disabled={pending}>Cancelar</button><button value="crear" disabled={pending}>{pending ? 'Creando…' : accept}</button></div>
  </form>;
}
export function NewFileDialog() {
  const context = useEstado(() => estado().creacionEntrada as EntryCreationContext | null);
  const folder = context?.kind === 'directory';
  return <FileNameForm title={folder ? 'Nueva carpeta' : context?.language === 'micropython' ? 'Nuevo archivo MicroPython' : 'Nuevo archivo'}
    label={folder ? 'Nombre de la carpeta' : 'Nombre del archivo'} inputId="nuevo-archivo-nombre" resetKey={context}
    placeholder={folder ? 'sensores' : context?.language === 'micropython' ? 'movimiento.py' : 'archivo'}
    hint={`Destino: ${context?.parent || 'raíz de la placa'}. Podés usar / para crear subcarpetas.${!folder && context?.language === 'micropython' ? ' La extensión .py se agrega si no indicás otra.' : ''}`}
    create={async name => {
      if (!context) throw new Error('Seleccioná una placa.');
      rutaNuevaEntrada(context.parent, name, context.kind, context.language);
      await acciones().crearEntrada(name, context.kind);
    }} />;
}
