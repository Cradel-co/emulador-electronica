import { InformePrototipoDialog } from './InformePrototipo.js';
import { ConflictosGuardado } from './ConflictosGuardado.js';
import { createRoot } from 'react-dom/client';
import { createElement, type FunctionComponent } from 'react';
import { flushSync } from 'react-dom';
import { NewFileDialog } from './NewFileDialog.js';
import { ToolWindows } from './ToolWindows.js';
import { DockWorkspace } from './DockWorkspace.js';
import { LayoutSettings } from './LayoutSettings.js';
import { Settings } from './Settings.js';
import { ExplorerIcon } from './ExplorerIcon.js';
import { EditorPreferences } from './EditorPreferences.js';
import { Lienzo } from './Lienzo.js';
import { Avisos } from './Avisos.js';
import { Proyectos } from './Proyectos.js';
import { PanelDerecho } from './PanelDerecho.js';
import { Menu } from './Menu.js';
import { Paleta } from './Paleta.js';
import { Miga, Notificaciones, Pestanas } from './Barra.js';
import { DebugAlimentacion, ErroresCompilacion, Problemas, ResultadoImportacion } from './Problemas.js';
import { OpcionesLenguajePlaca, OpcionesPlacaNueva, OpcionesPlacas, OpcionesPlantillas, OpcionesProyectos } from './Selectores.js';
import { Aprendizaje } from './Aprendizaje.js';

/**
 * Monta las islas de React sobre la UI de `app.ts` (#9).
 *
 * Son raíces separadas, una por pedazo migrado, en vez de un árbol único: así cada panel se puede
 * mover cuando le toque, sin reordenar el `index.html` ni envolver lo que todavía es imperativo.
 * A medida que avance la migración, las islas se van juntando.
 *
 * El montaje es sincrónico (`flushSync` + `useLayoutEffect` en `<Lienzo>`): al volver de acá el
 * lienzo ya existe y `app.ts` puede seguir con su arranque como siempre.
 */
const ISLAS: [string, FunctionComponent, boolean][] = [
  // [id del nodo, componente, si es obligatorio]
  //
  // Las islas se montan **sobre los nodos que ya existían**, no sobre un div nuevo adentro:
  // `createRoot` conserva el contenedor y solo maneja sus hijos. Eso importa porque el CSS cuenta
  // con la jerarquía: `.lista-modulos` es un `flex: 1` con `overflow: auto` que tiene que ser hijo
  // directo de su panel. Un div envoltorio en el medio le saca la altura y la lista deja de
  // scrollear (ver el comentario de este arreglo).
  ['react-lienzo', Lienzo, true],
  ['avisos-dibujo', Avisos, false],
  ['tool-windows', ToolWindows, true],
  ['conflictos-guardado', ConflictosGuardado, true],
  ['dlg-informe-prototipo', InformePrototipoDialog, true],
  ['dock-layout', DockWorkspace, true],
  ['tw-explorador', ExplorerIcon, false],
  ['lista-proyectos', Proyectos, false],
  ['pantalla-aprender', Aprendizaje, false],
  ['panel-modulo', PanelDerecho, false],
  ['menu', Menu, false],
  ['dlg-buscar', Paleta, false],
  ['dlg-editor-preferences', EditorPreferences, false],
  ['dlg-ajustes', Settings, true],
  ['dlg-layout-settings', LayoutSettings, true],
  ['dlg-nuevo-archivo', NewFileDialog, false],
  ['tabs-archivos', Pestanas, false],
  ['miga', Miga, false],
  ['lista-notificaciones', Notificaciones, false],
  ['problemas', Problemas, false],
  ['avisos', ErroresCompilacion, false],
  ['dbg-alimentacion', DebugAlimentacion, false],
  ['imp-resultado', ResultadoImportacion, false],
  ['proyecto', OpcionesProyectos, false],
  ['nuevo-placa', OpcionesPlacaNueva, false],
  ['nuevo-plantilla', OpcionesPlantillas, false],
  ['placa-nueva', OpcionesPlacas, false],
  ['placa-lenguaje', OpcionesLenguajePlaca, false],
];

export function montarReact(): void {
  for (const [id, Componente, obligatorio] of ISLAS) {
    const nodo = document.getElementById(id);
    if (!nodo) {
      if (obligatorio) throw new Error(`falta #${id} en index.html: el canvas no tiene dónde montarse`);
      continue;
    }
    const root = createRoot(nodo);
    flushSync(() => root.render(createElement(Componente)));
  }
}
