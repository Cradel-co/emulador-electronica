export function Settings() {
  const open = (id: string) => {
    (document.getElementById('dlg-ajustes') as HTMLDialogElement).close();
    (document.getElementById(id) as HTMLDialogElement).showModal();
  };
  return <form method="dialog" className="editor-preferences">
    <h2>Configuración</h2>
    <div className="layout-settings-actions">
      <button type="button" onClick={() => open('dlg-editor-preferences')}>Ajustes del editor</button>
      <button type="button" onClick={() => open('dlg-layout-settings')}>Distribución de ventanas</button>
    </div>
    <div className="editor-preferences-actions"><button>Cerrar</button></div>
  </form>;
}
