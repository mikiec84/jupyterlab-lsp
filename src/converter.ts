import * as lsProtocol from 'vscode-languageserver-protocol';
import { CodeEditor } from '@jupyterlab/codeeditor';
import CodeMirror = require('codemirror');

export class PositionConverter {
  static lsp_to_cm(position: lsProtocol.Position): CodeMirror.Position {
    return { line: position.line, ch: position.character };
  }

  static lsp_to_ce(position: lsProtocol.Position): CodeEditor.IPosition {
    return { line: position.line, column: position.character };
  }

  static cm_to_ce(position: CodeMirror.Position): CodeEditor.IPosition {
    return { line: position.line, column: position.ch };
  }

  static ce_to_cm(position: CodeEditor.IPosition): CodeMirror.Position {
    return { line: position.line, ch: position.column };
  }
}
