import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import { EditorView, Decoration, GutterMarker, gutter, lineNumbers, highlightActiveLine, highlightActiveLineGutter, keymap, drawSelection, rectangularSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { search, searchKeymap } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { linter, lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { tags } from '@lezer/highlight';
import { editorPreferences, type EditorPreferences } from './editor-preferences.js';
import { micropythonCompletionSource, micropythonSyntaxDiagnostics } from './micropython-language.js';

type DebugMarks = { breakpoints: Set<number>; verified: Set<number>; stopped: number | null };
const debugEffect = StateEffect.define<DebugMarks>();
const debugField = StateField.define<DebugMarks>({
  create: () => ({ breakpoints: new Set(), verified: new Set(), stopped: null }),
  update: (value, tr) => tr.effects.reduce((v, e) => e.is(debugEffect) ? e.value : v, value),
});
class BreakpointMarker extends GutterMarker {
  constructor(readonly verified: boolean) { super(); }
  eq(other: BreakpointMarker) { return other.verified === this.verified; }
  toDOM() {
    const el = document.createElement('span');
    el.className = `cm-breakpoint${this.verified ? ' verified' : ''}`;
    el.textContent = '●';
    el.title = this.verified ? 'Breakpoint verificado (click para quitar)' : 'Breakpoint: se activa al ejecutar';
    return el;
  }
}
const darcula = HighlightStyle.define([
  { tag: tags.keyword, color: '#cf8e6d' },
  { tag: [tags.string, tags.special(tags.string)], color: '#6aab73' },
  { tag: tags.number, color: '#2aacb8' },
  { tag: tags.comment, color: '#7a7e85', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: '#56a8f5' },
  { tag: [tags.bool, tags.null], color: '#c77dbb' },
]);

/** CodeMirror se monta solo para .py; los otros archivos conservan el editor legacy. */
export function crearEditorMicroPython(parent: HTMLElement, callbacks: {
  change: (text: string) => void; cursor: (line: number, column: number) => void;
  breakpoint: (line: number) => void;
}) {
  let view: EditorView | null = null;
  let current = '';
  let revision = 0;
  const preferences = new Compartment();
  function preferenceExtensions(p: EditorPreferences) {
    const dark = p.theme === 'dark';
    return [indentUnit.of(' '.repeat(p.indentWidth)), EditorState.tabSize.of(p.indentWidth), EditorView.theme({
      '&': { height: '100%', color: dark ? '#bcbec4' : '#202124', backgroundColor: dark ? '#27292d' : '#fafafa', fontSize: `${p.fontSize}px` },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: `${p.fontSize * 1.5}px` },
      '.cm-content': { padding: '8px 0', caretColor: dark ? '#ced0d6' : '#202124' },
      '.cm-gutters': { backgroundColor: dark ? '#27292d' : '#f0f0f0', color: dark ? '#7a7e85' : '#666', borderRight: '1px solid #393b40' },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: dark ? '#1f2124' : '#e9edf4' },
      '.cm-cursor': { borderLeftColor: dark ? '#ced0d6' : '#202124' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: dark ? '#264faa' : '#b8d1ff' },
      '.cm-panels input, .cm-panels button': { backgroundColor: dark ? '#383a3e' : '#fff', color: dark ? '#bcbec4' : '#202124' },
      '.cm-panels, .cm-tooltip': { backgroundColor: dark ? '#2b2d30' : '#f5f5f5', color: dark ? '#bcbec4' : '#202124', borderColor: '#43454a' },
    }, { dark }), syntaxHighlighting(dark ? darcula : HighlightStyle.define([
      { tag: tags.keyword, color: '#994200' }, { tag: tags.string, color: '#287235' },
      { tag: tags.comment, color: '#687080', fontStyle: 'italic' }, { tag: tags.number, color: '#087885' },
      { tag: tags.function(tags.variableName), color: '#0057a5' },
    ]))];
  }

  let loading = false;
  let buildErrors: { line: number; message: string }[] = [];
  const sessions = new Map<string, { state: EditorState; top: number; left: number }>();
  // Límite de historial retenido: evita acumular documentos de todos los proyectos visitados.
  function saveSession() {
    if (!view) return;
    sessions.delete(current);
    sessions.set(current, { state: view.state, top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft });
    const oldest = sessions.keys().next().value;
    if (sessions.size > 32 && oldest !== undefined) sessions.delete(oldest);
  }
  function buildDiagnostics(v: EditorView): Diagnostic[] {
    return buildErrors.filter(e => e.line >= 1 && e.line <= v.state.doc.lines).map(e => {
      const line = v.state.doc.line(e.line);
      return { from: line.from, to: line.to, severity: 'error', message: e.message, source: 'Build' };
    });
  }
  function position() {
    if (!view) return;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    callbacks.cursor(line.number, head - line.from + 1);
  }
  const extensions = [
    EditorState.transactionExtender.of(tr => tr.docChanged ? { effects: setDiagnostics(tr.state, []).effects } : null),
    python(), lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), history(),
    drawSelection(), rectangularSelection(), EditorState.allowMultipleSelections.of(true),
    indentOnInput(), bracketMatching(), closeBrackets(), foldGutter(),
    EditorState.phrases.of({
      'Find': 'Buscar', 'Replace': 'Reemplazar', 'next': 'siguiente', 'previous': 'anterior',
      'all': 'todos', 'match case': 'mayúsculas', 'regexp': 'regex', 'by word': 'palabra completa',
      'replace': 'reemplazar', 'replace all': 'reemplazar todo', 'close': 'cerrar',
      'Fold line': 'Plegar línea', 'Unfold line': 'Desplegar línea',
    }),
    search({ top: true }), autocompletion({ override: [micropythonCompletionSource] }),
    linter(v => [...micropythonSyntaxDiagnostics(v), ...buildDiagnostics(v)], { delay: 350 }), lintGutter(),
    keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...foldKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    debugField,
    gutter({ class: 'cm-breakpointGutter', initialSpacer: () => new BreakpointMarker(false),
      lineMarker(v, line) { const n = v.state.doc.lineAt(line.from).number; const marks = v.state.field(debugField); return marks.breakpoints.has(n) ? new BreakpointMarker(marks.verified.has(n)) : null; },
      lineMarkerChange: update => update.transactions.some(tr => tr.effects.some(e => e.is(debugEffect))),
      domEventHandlers: { mousedown(v, line, event) { event.preventDefault(); callbacks.breakpoint(v.state.doc.lineAt(line.from).number); return true; } },
    }),
    EditorView.decorations.compute(['doc', debugField], state => {
      const n = state.field(debugField).stopped;
      return n && n <= state.doc.lines ? Decoration.set([Decoration.line({ class: 'cm-debug-stopped' }).range(state.doc.line(n).from)]) : Decoration.none;
    }),
    preferences.of(preferenceExtensions(editorPreferences())),
    EditorView.contentAttributes.of({ 'aria-label': 'Código MicroPython', spellcheck: 'false' }),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !loading) { revision++; buildErrors = []; callbacks.change(update.state.doc.toString()); }
      if (update.selectionSet || update.docChanged || update.focusChanged) position();
    }),
  ];
  return {
    open(key: string, text: string) {
      revision++;
      saveSession();
      const saved = sessions.get(key);
      const state = saved && saved.state.doc.toString() === text ? saved.state : EditorState.create({ doc: text, extensions });
      // La entrada activa vive en la vista; al salir se vuelve a insertar como la más reciente.
      sessions.delete(key);
      loading = true; buildErrors = []; current = key;
      if (view) view.setState(state); else view = new EditorView({ state, parent });
      view.dispatch({ effects: [debugEffect.of({ breakpoints: new Set(), verified: new Set(), stopped: null }), preferences.reconfigure(preferenceExtensions(editorPreferences()))] });
      if (saved) view.requestMeasure({
        read: () => ({ top: saved.top, left: saved.left }),
        write: ({ top, left }, v) => { v.scrollDOM.scrollTop = top; v.scrollDOM.scrollLeft = left; },
      });
      loading = false; position();
    },
    hide() { if (view) { saveSession(); view.destroy(); view = null; } },
    text: () => view?.state.doc.toString() ?? '',
    version: () => revision,
    preferences(p: EditorPreferences) { if (view) view.dispatch({ effects: preferences.reconfigure(preferenceExtensions(p)) }); },
    format(text: string) { if (view && text !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.format', annotations: isolateHistory.of('full') }); },
    line: () => view ? view.state.doc.lineAt(view.state.selection.main.head).number : 1,
    scroll: () => view?.scrollDOM.scrollTop ?? 0,
    setScroll(value: number) { if (view) view.scrollDOM.scrollTop = value; },
    go(line: number) { if (!view) return; const n = Math.max(1, Math.min(line, view.state.doc.lines)); const pos = view.state.doc.line(n).from; view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) }); view.focus(); },
    errors(errors: { line: number; message: string }[]) {
      buildErrors = errors;
      if (view) view.dispatch(setDiagnostics(view.state, [...micropythonSyntaxDiagnostics(view), ...buildDiagnostics(view)]));
    },
    debug(marks: DebugMarks) { if (view) view.dispatch({ effects: debugEffect.of(marks) }); },
  };
}
