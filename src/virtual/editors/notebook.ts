import { Notebook, NotebookPanel } from '@jupyterlab/notebook';
import { Cell } from '@jupyterlab/cells';
import { CodeMirrorEditor } from '@jupyterlab/codemirror';
import { ShowHintOptions } from 'codemirror';
import { IOverridesRegistry } from '../../magics/overrides';
import { IForeignCodeExtractorsRegistry } from '../../extractors/types';
import { VirtualEditor } from '../editor';
import CodeMirror = require('codemirror');
import {
  IEditorPosition,
  IRootPosition,
  IVirtualPosition
} from '../../positioning';

// @ts-ignore
class DocDispatcher implements CodeMirror.Doc {
  virtual_editor: VirtualEditorForNotebook;

  constructor(virtual_notebook: VirtualEditorForNotebook) {
    this.virtual_editor = virtual_notebook;
  }

  markText(
    from: IRootPosition,
    to: IRootPosition,
    options?: CodeMirror.TextMarkerOptions
  ): CodeMirror.TextMarker {
    // TODO: edgecase: from and to in different cells
    let editor = this.virtual_editor.virtual_document.get_editor_at_source_line(from);
    let notebook_map = this.virtual_editor;
    return editor
      .getDoc()
      .markText(
        notebook_map.transform_from_root_to_editor(from),
        notebook_map.transform_from_root_to_editor(to),
        options
      );
  }

  getValue(seperator?: string): string {
    return this.virtual_editor.getValue();
  }

  getCursor(start?: string): CodeMirror.Position {
    let cell = this.virtual_editor.notebook.activeCell;
    let active_editor = cell.editor as CodeMirrorEditor;
    let cursor = active_editor.editor.getDoc().getCursor(start);
    return this.virtual_editor.transform_from_notebook_to_root(cell, cursor);
  }
}

export class VirtualEditorForNotebook extends VirtualEditor {
  notebook: Notebook;
  notebook_panel: NotebookPanel;

  cell_to_corresponding_source_line: Map<Cell, number>;
  cm_editor_to_cell: Map<CodeMirror.Editor, Cell>;
  language: string;

  constructor(
    notebook_panel: NotebookPanel,
    language: string,
    overrides_registry: IOverridesRegistry,
    foreign_code_extractors: IForeignCodeExtractorsRegistry,
    path: string
  ) {
    super(language, path, overrides_registry, foreign_code_extractors);
    this.notebook_panel = notebook_panel;
    this.notebook = notebook_panel.content;
    this.cell_to_corresponding_source_line = new Map();
    this.cm_editor_to_cell = new Map();
    this.overrides_registry = overrides_registry;
    this.code_extractors = foreign_code_extractors;
    this.language = language;
    let handler = {
      get: function(
        target: VirtualEditorForNotebook,
        prop: keyof CodeMirror.Editor,
        receiver: any
      ) {
        if (!(prop in target)) {
          console.warn(
            `Unimplemented method ${prop} for VirtualEditorForNotebook`
          );
          return;
        } else {
          return Reflect.get(target, prop, receiver);
        }
      }
    };
    return new Proxy(this, handler);
  }

  transform_from_notebook_to_root(
    cell: Cell,
    position: CodeMirror.Position
  ): IRootPosition {
    // TODO: if cell is not known, refresh
    let shift = this.cell_to_corresponding_source_line.get(cell);
    if (shift === undefined) {
      throw Error('Cell not found in cell_line_map');
    }
    return {
      ...position,
      line: position.line + shift
    } as IRootPosition;
  }

  public transform_editor_to_root(
    cm_editor: CodeMirror.Editor,
    position: IEditorPosition
  ): IRootPosition {
    let cell = this.cm_editor_to_cell.get(cm_editor);
    return this.transform_from_notebook_to_root(cell, position);
  }

  transform_from_root_to_editor(pos: IRootPosition): CodeMirror.Position {
    // from notebook to editor space
    return this.virtual_document.transform_source_to_editor(pos);
  }

  public get_editor_index(position: IVirtualPosition): number {
    let cell = this.get_cell_at(position);
    return this.notebook.widgets.findIndex(other_cell => {
      return cell === other_cell;
    });
  }

  get_cm_editor(position: IRootPosition) {
    return this.get_editor_at_root_line(position);
  }

  showHint: (options: ShowHintOptions) => void;
  state: any;

  addKeyMap(map: string | CodeMirror.KeyMap, bottom?: boolean): void {}

  addLineClass(
    line: any,
    where: string,
    _class_: string
  ): CodeMirror.LineHandle {
    return undefined;
  }

  addLineWidget(
    line: any,
    node: HTMLElement,
    options?: CodeMirror.LineWidgetOptions
  ): CodeMirror.LineWidget {
    return undefined;
  }

  addOverlay(mode: any, options?: any): void {
    for (let cell of this.notebook.widgets) {
      // TODO: use some more intelligent strategy to determine editors to test
      let cm_editor = cell.editor as CodeMirrorEditor;
      cm_editor.editor.addOverlay(mode, options);
    }
  }

  addPanel(
    node: HTMLElement,
    // @ts-ignore
    options?: CodeMirror.ShowPanelOptions
    // @ts-ignore
  ): CodeMirror.Panel {
    return undefined;
  }

  charCoords(
    pos: IRootPosition,
    mode?: 'window' | 'page' | 'local'
  ): { left: number; right: number; top: number; bottom: number } {
    try {
      let editor = this.get_editor_at_root_line(pos);
      return editor.charCoords(pos, mode);
    } catch (e) {
      console.log(e);
      return { bottom: 0, left: 0, right: 0, top: 0 };
    }
  }

  coordsChar(
    object: { left: number; top: number },
    mode?: 'window' | 'page' | 'local'
  ): IRootPosition {
    for (let cell of this.notebook.widgets) {
      // TODO: use some more intelligent strategy to determine editors to test
      let cm_editor = cell.editor as CodeMirrorEditor;
      let pos = cm_editor.editor.coordsChar(object, mode);

      // @ts-ignore
      if (pos.outside === true) {
        continue;
      }

      return this.transform_from_notebook_to_root(cell, pos);
    }
  }

  cursorCoords(
    where?: boolean,
    mode?: 'window' | 'page' | 'local'
  ): { left: number; top: number; bottom: number };
  cursorCoords(
    where?: IRootPosition | null,
    mode?: 'window' | 'page' | 'local'
  ): { left: number; top: number; bottom: number };
  cursorCoords(
    where?: boolean | IRootPosition | null,
    mode?: 'window' | 'page' | 'local'
  ): { left: number; top: number; bottom: number } {
    if (typeof where !== 'boolean') {
      let editor = this.get_editor_at_root_line(where);
      return editor.cursorCoords(this.transform_from_root_to_editor(where));
    }
    return { bottom: 0, left: 0, top: 0 };
  }

  get any_editor(): CodeMirror.Editor {
    return (this.notebook.widgets[0].editor as CodeMirrorEditor).editor;
  }

  defaultCharWidth(): number {
    return this.any_editor.defaultCharWidth();
  }

  defaultTextHeight(): number {
    return this.any_editor.defaultTextHeight();
  }

  endOperation(): void {
    for (let cell of this.notebook.widgets) {
      let cm_editor = cell.editor as CodeMirrorEditor;
      cm_editor.editor.endOperation();
    }
  }

  execCommand(name: string): void {
    for (let cell of this.notebook.widgets) {
      let cm_editor = cell.editor as CodeMirrorEditor;
      cm_editor.editor.execCommand(name);
    }
  }

  getDoc(): CodeMirror.Doc {
    let dummy_doc = new DocDispatcher(this);
    // @ts-ignore
    return dummy_doc;
  }

  get_editor_at_root_line(pos: IRootPosition): CodeMirror.Editor {
    return this.virtual_document.root.get_editor_at_source_line(pos);
  }

  getTokenAt(pos: IRootPosition, precise?: boolean): CodeMirror.Token {
    if (pos === undefined) {
      return;
    }
    let editor = this.get_editor_at_root_line(pos);
    return editor.getTokenAt(this.transform_from_root_to_editor(pos));
  }

  getTokenTypeAt(pos: IRootPosition): string {
    let editor = this.virtual_document.get_editor_at_source_line(pos);
    return editor.getTokenTypeAt(this.transform_from_root_to_editor(pos));
  }

  // TODO: make a mapper class, with mapping function only

  get_cell_at(pos: IVirtualPosition): Cell {
    let cm_editor = this.get_editor_at_virtual_line(pos);
    return this.cm_editor_to_cell.get(cm_editor);
  }

  get_editor_at_virtual_line(pos: IVirtualPosition): CodeMirror.Editor {
    return this.virtual_document.get_editor_at_virtual_line(pos);
  }

  protected perform_documents_update(): void {
    this.virtual_document.clear();
    this.cell_to_corresponding_source_line.clear();
    this.cm_editor_to_cell.clear();

    this.notebook.widgets.every(cell => {
      let codemirror_editor = cell.editor as CodeMirrorEditor;
      let cm_editor = codemirror_editor.editor;
      this.cm_editor_to_cell.set(cm_editor, cell);

      if (cell.model.type === 'code') {
        let cell_code = cm_editor.getValue();
        // every code cell is placed into the cell-map
        this.cell_to_corresponding_source_line.set(
          cell,
          this.virtual_document.last_source_line
        );

        this.virtual_document.append_code_block(cell_code, cm_editor);
      }
      return true;
    });
  }

  getWrapperElement(): HTMLElement {
    return this.notebook_panel.node;
  }

  heightAtLine(
    line: any,
    mode?: 'window' | 'page' | 'local',
    includeWidgets?: boolean
  ): number {
    return 0;
  }

  isReadOnly(): boolean {
    return false;
  }

  lineAtHeight(height: number, mode?: 'window' | 'page' | 'local'): number {
    return 0;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.forEveryBlockEditor(cm_editor => {
      cm_editor.getWrapperElement().addEventListener(type, listener);
    });
  }

  forEveryBlockEditor(
    callback: (cm_editor: CodeMirror.Editor) => any,
    monitor_for_new_blocks = true
  ) {
    const cells_with_handlers = new Set<Cell>();

    for (let cell of this.notebook.widgets) {
      let cm_editor = (cell.editor as CodeMirrorEditor).editor;
      if (cell.model.type === 'code') {
        cells_with_handlers.add(cell);
        callback(cm_editor);
      }
    }
    if (monitor_for_new_blocks) {
      this.notebook.activeCellChanged.connect((notebook, cell) => {
        let cm_editor = (cell.editor as CodeMirrorEditor).editor;
        if (!cells_with_handlers.has(cell) && cell.model.type === 'code') {
          callback(cm_editor);
        }
      });
    }
  }
}
