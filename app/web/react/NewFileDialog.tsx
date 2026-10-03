import { useState } from 'react';
/** Formulario nativo reutilizable dentro de un dialog; el controlador recibe su returnValue. */
export function FileNameForm({ title, label, hint, inputId, accept = 'Crear' }: {
  title: string; label: string; hint: string; inputId: string; accept?: string;
}) {
  const [error, setError] = useState('');
  return <form method="dialog" onSubmit={event => {
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value !== 'crear') { setError(''); return; }
    const form = event.currentTarget;
    const input = form.elements.namedItem('nombre') as HTMLInputElement | null;
    const name = input?.value.trim() ?? '';
    if (!name || /[\/\\]/.test(name) || name === '.' || name === '..') {
      event.preventDefault(); setError('Usá un nombre de archivo sin carpetas.');
    } else setError('');
  }}>
    <h2>{title}</h2>
    <label htmlFor={inputId}>{label}</label>
    <input name="nombre" id={inputId} required placeholder="sensores.py" autoComplete="off" />
    <p>{hint}</p>
    {error && <p role="alert">{error}</p>}
    <div className="acciones"><button value="cancelar" formNoValidate>Cancelar</button><button value="crear">{accept}</button></div>
  </form>;
}
export function NewFileDialog() {
  return <FileNameForm title="Nuevo archivo MicroPython" label="Nombre del archivo" inputId="nuevo-archivo-nombre"
    hint="Se crea junto al archivo abierto. La extensión .py se agrega automáticamente." />;
}
