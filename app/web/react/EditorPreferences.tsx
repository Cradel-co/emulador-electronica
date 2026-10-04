import { useState, useSyncExternalStore } from 'react';
import { editorPreferences, setEditorPreferences, subscribeEditorPreferences } from '../editor-preferences.js';

export function EditorPreferences() {
  const p = useSyncExternalStore(subscribeEditorPreferences, editorPreferences);
  const [fontDraft, setFontDraft] = useState(String(p.fontSize));
  return <form method="dialog" className="editor-preferences">
    <h2>Ajustes del editor MicroPython</h2>
    <p>Se aplican a los archivos Python y se guardan en este navegador.</p>
    <label htmlFor="editor-theme">Tema</label>
    <select id="editor-theme" value={p.theme} onChange={e => setEditorPreferences({ theme: e.target.value as 'dark' | 'light' })}>
      <option value="dark">Oscuro (Darcula)</option><option value="light">Claro</option>
    </select>
    <label htmlFor="editor-font-size">Tamaño de fuente</label>
    <input id="editor-font-size" type="number" min="10" max="24" value={fontDraft} onChange={e => {
      const draft = e.target.value;
      setFontDraft(draft);
      const size = Number(draft);
      if (draft && Number.isFinite(size) && size >= 10 && size <= 24) setEditorPreferences({ fontSize: size });
    }} onBlur={() => {
      if (fontDraft.trim()) setEditorPreferences({ fontSize: Number(fontDraft) });
      setFontDraft(String(editorPreferences().fontSize));
    }} />
    <label htmlFor="editor-indent-width">Espacios por sangría y tabulación</label>
    <select id="editor-indent-width" value={p.indentWidth} onChange={e => setEditorPreferences({ indentWidth: Number(e.target.value) })}>
      <option value="2">2 espacios</option><option value="4">4 espacios (Python)</option><option value="8">8 espacios</option>
    </select>
    <div className="editor-preferences-actions"><button type="submit">Cerrar</button></div>
  </form>;
}
