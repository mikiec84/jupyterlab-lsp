export import CodeMirror = require('codemirror');
import { CodeMirrorAdapter, ITextEditorOptions } from 'lsp-editor-adapter';
import * as lsProtocol from 'vscode-languageserver-protocol';
import { FreeTooltip } from '../free_tooltip';
import { DefaultMap, getModifierState, until_ready } from '../utils';
import { PositionConverter } from '../converter';
import {
  CompletionTriggerKind,
  diagnosticSeverityNames,
  documentHighlightKindNames
} from '../lsp';
import { VirtualEditor } from '../virtual/editor';
import { VirtualDocument } from '../virtual/document';
import {
  IEditorPosition,
  is_equal,
  IRootPosition,
  IVirtualPosition
} from '../positioning';
import { LSPConnection } from '../connection';

export type KeyModifier = 'Alt' | 'Control' | 'Shift' | 'Meta' | 'AltGraph';
// TODO: settings
const hover_modifier: KeyModifier = 'Control';
const default_severity = 2;

interface IEditorRange {
  start: IEditorPosition;
  end: IEditorPosition;
  editor: CodeMirror.Editor;
}

export class CodeMirrorAdapterExtension extends CodeMirrorAdapter {
  public connection: LSPConnection;
  public editor: VirtualEditor;

  protected highlight_markers: CodeMirror.TextMarker[] = [];
  private marked_diagnostics: Map<string, CodeMirror.TextMarker> = new Map();
  private _tooltip: FreeTooltip;
  private show_next_tooltip: boolean;
  private last_hover_response: lsProtocol.Hover;
  private last_hover_character: CodeMirror.Position;

  private unique_editor_ids: DefaultMap<CodeMirror.Editor, number>;
  private signature_character: IRootPosition;
  private last_change: CodeMirror.EditorChange;

  constructor(
    connection: LSPConnection,
    options: ITextEditorOptions,
    editor: VirtualEditor,
    protected create_tooltip: (
      markup: lsProtocol.MarkupContent,
      cm_editor: CodeMirror.Editor,
      position: IEditorPosition
    ) => FreeTooltip,
    protected invoke_completer: (kind: CompletionTriggerKind) => void,
    private virtual_document: VirtualDocument
  ) {
    super(connection, options, editor);
    this.unique_editor_ids = new DefaultMap(() => this.unique_editor_ids.size);

    // @ts-ignore
    let listeners = this.editorListeners;

    let wrapper = this.editor.getWrapperElement();
    this.editor.addEventListener(
      'mouseleave',
      // TODO: remove_tooltip() but allow the mouse to leave if it enters the tooltip
      //  (a bit tricky: normally we would just place the tooltip within, but it was designed to be attached to body)
      this.remove_range_highlight.bind(this)
    );
    wrapper.addEventListener(
      'mouseleave',
      this.remove_range_highlight.bind(this)
    );
    // detach the adapters contextmenu
    wrapper.removeEventListener('contextmenu', listeners.contextmenu);

    // TODO: actually we only need the connection...
    //  the tooltips and suggestions will need re-writing to JL standards anyway

    // show hover after pressing the modifier key
    wrapper.addEventListener('keydown', (event: KeyboardEvent) => {
      if (
        (!hover_modifier || getModifierState(event, hover_modifier)) &&
        this.hover_character === this.last_hover_character
      ) {
        this.show_next_tooltip = true;
        this.handleHover(this.last_hover_response);
      }
    });

    this.editor.off('cursorActivity', listeners.cursorActivity);
    this.editor.on('cursorActivity', this.onCursorActivity.bind(this));

    this.editor.off('change', listeners.changeListener);
    // due to an unknown reason the default listener (as defined in the base class) is not invoked on file editors
    // the workaround - setting it at doc instead - works, thus the original one is first disabled (above) and a new
    // one is added (below); this however can have devastating effect on the editor synchronization - be careful!
    CodeMirror.on(this.editor.getDoc(), 'change', (doc, change) => {
      this.handleChange(this.editor, change);
    });
  }

  private _completionCharacters: string[];
  private _signatureCharacters: string[];

  get completionCharacters() {
    if (
      typeof this._completionCharacters === 'undefined' ||
      !this._completionCharacters.length
    ) {
      this._completionCharacters = this.connection.getLanguageCompletionCharacters();
    }
    return this._completionCharacters;
  }

  get signatureCharacters() {
    if (
      typeof this._signatureCharacters === 'undefined' ||
      !this._signatureCharacters.length
    ) {
      this._signatureCharacters = this.connection.getLanguageSignatureCharacters();
    }
    return this._signatureCharacters;
  }

  protected hover_character: IRootPosition;

  public handleGoTo(locations: any) {
    // do NOT handle GoTo actions here
    this.remove_tooltip();
  }

  public handleCompletion(completions: lsProtocol.CompletionItem[]) {
    // do NOT handle completion here
  }

  protected static get_markup_for_hover(
    response: lsProtocol.Hover
  ): lsProtocol.MarkupContent {
    let contents = response.contents;

    // this causes the webpack to fail "Module not found: Error: Can't resolve 'net'" for some reason
    // if (lsProtocol.MarkedString.is(contents))
    ///  contents = [contents];

    if (typeof contents === 'string') {
      contents = [contents as lsProtocol.MarkedString];
    }

    if (!Array.isArray(contents)) {
      return contents as lsProtocol.MarkupContent;
    }

    // now we have MarkedString
    let content = contents[0];

    if (typeof content === 'string') {
      // coerce to MarkedString  object
      return {
        kind: 'plaintext',
        value: content
      };
    } else {
      return {
        kind: 'markdown',
        value: '```' + content.language + '\n' + content.value + '```'
      };
    }
  }

  protected remove_range_highlight() {
    // @ts-ignore
    this._removeHover(); // this removes underlines
    this.last_hover_character = null;
  }

  protected remove_tooltip() {
    this.remove_range_highlight();

    if (this._tooltip !== undefined) {
      this._tooltip.dispose();
    }
  }

  public handleHover(response: lsProtocol.Hover) {
    this.remove_tooltip();
    this.last_hover_character = null;
    this.last_hover_response = null;

    if (
      !this.hover_character ||
      !response ||
      !response.contents ||
      (Array.isArray(response.contents) && response.contents.length === 0)
    ) {
      return;
    }

    // @ts-ignore
    this.hoverMarker = this.highlight_range(
      this.editor_range_for_hover(response.range),
      'cm-lsp-hover-available'
    );

    if (!this.show_next_tooltip) {
      this.last_hover_response = response;
      this.last_hover_character = this.hover_character;
      return;
    }

    const markup = CodeMirrorAdapterExtension.get_markup_for_hover(response);
    let root_position = this.hover_character;
    let cm_editor = this.get_cm_editor(root_position);
    let editor_position = this.editor.root_position_to_editor_position(
      root_position
    );

    this._tooltip = this.create_tooltip(markup, cm_editor, editor_position);
  }

  get_cm_editor(position: IRootPosition) {
    return this.editor.get_cm_editor(position);
  }

  get_language_at(position: IEditorPosition, editor: CodeMirror.Editor) {
    return editor.getModeAt(position).name;
  }

  protected get_markup_for_signature_help(
    response: lsProtocol.SignatureHelp,
    language: string
  ): lsProtocol.MarkupContent {
    let signatures = new Array<string>();

    response.signatures.forEach(item => {
      let markdown = this.markdown_from_signature(item, language);
      signatures.push(markdown);
    });

    return {
      kind: 'markdown',
      value: signatures.join('\n\n')
    };
  }

  /**
   * A temporary workaround for the LSP servers returning plain text (e.g. docstrings)
   * (providing not-the-best UX) instead of markdown and me being unable to force
   * them to return markdown instead.
   */
  private markdown_from_signature(
    item: lsProtocol.SignatureInformation,
    language: string
  ): string {
    let markdown = '```' + language + '\n' + item.label + '\n```';
    if (item.documentation) {
      markdown += '\n';

      let in_text_block = false;
      // TODO: make use of the MarkupContent object instead
      for (let line of item.documentation.toString().split('\n')) {
        if (line.trim() === item.label.trim()) {
          continue;
        }

        if (line.startsWith('>>>')) {
          if (in_text_block) {
            markdown += '```\n\n';
            in_text_block = false;
          }
          line = '```' + language + '\n' + line.substr(3) + '\n```';
        } else {
          // start new text block
          if (!in_text_block) {
            markdown += '```\n';
            in_text_block = true;
          }
        }
        markdown += line + '\n';
      }
      // close off the text block - if any
      if (in_text_block) {
        markdown += '```';
      }
    }
    return markdown;
  }

  public handleSignature(response: lsProtocol.SignatureHelp) {
    this.remove_tooltip();

    if (!this.signature_character || !response || !response.signatures.length) {
      return;
    }

    let root_position = this.signature_character;
    let cm_editor = this.get_cm_editor(root_position);
    let editor_position = this.editor.root_position_to_editor_position(
      root_position
    );
    let language = this.get_language_at(editor_position, cm_editor);
    let markup = this.get_markup_for_signature_help(response, language);

    this._tooltip = this.create_tooltip(markup, cm_editor, editor_position);
  }

  public async updateAfterChange() {
    this.remove_tooltip();
    await until_ready(() => this.last_change != null, 30, 22).catch(() => {
      this.invalidateLastChange();
      throw Error(
        'No change obtained from CodeMirror editor within the expected time of 0.66s'
      );
    });
    let change: CodeMirror.EditorChange = this.last_change;

    try {
      const root_position = this.editor
        .getDoc()
        .getCursor('end') as IRootPosition;

      let document = this.editor.document_at_root_position(root_position);

      if (this.virtual_document !== document) {
        return true;
      }

      if (!change || !change.text.length || !change.text[0].length) {
        // deletion - ignore
        return true;
      }

      let last_character: string;

      if (change.origin === 'paste') {
        last_character = change.text[0][change.text.length - 1];
      } else {
        last_character = change.text[0][0];
      }

      // TODO: maybe the completer could be kicked off in the handleChange() method directly; signature help still
      //  requires an up-to-date virtual document on the LSP side, so we need to wait for sync.
      if (this.completionCharacters.indexOf(last_character) > -1) {
        this.invoke_completer(CompletionTriggerKind.TriggerCharacter);
      } else if (this.signatureCharacters.indexOf(last_character) > -1) {
        this.signature_character = root_position;
        let virtual_position = this.editor.root_position_to_virtual_position(
          root_position
        );
        this.connection.getSignatureHelp(virtual_position);
      }
      return true;
    } catch (e) {
      console.log(
        'handleChange failure - silent as to prevent editor going out of sync'
      );
      console.error(e);
    }
    this.invalidateLastChange();
  }

  public invalidateLastChange() {
    this.last_change = null;
  }

  public handleChange(cm: CodeMirror.Editor, change: CodeMirror.EditorChange) {
    this.last_change = change;
  }

  public handleHighlight(items: lsProtocol.DocumentHighlight[]) {
    for (let marker of this.highlight_markers) {
      marker.clear();
    }
    this.highlight_markers = [];

    if (!items) {
      return;
    }

    for (let item of items) {
      let range = this.range_to_editor_range(item.range);
      let kind_class = item.kind
        ? 'cm-lsp-highlight-' + documentHighlightKindNames[item.kind]
        : '';
      let marker = this.highlight_range(
        range,
        'cm-lsp-highlight ' + kind_class
      );
      this.highlight_markers.push(marker);
    }
  }

  protected onCursorActivity() {
    let root_position = this.editor
      .getDoc()
      .getCursor('start') as IRootPosition;
    let document: VirtualDocument;
    try {
      document = this.editor.document_at_root_position(root_position);
    } catch (e) {
      console.warn(
        'Could not obtain virtual document from position',
        root_position
      );
      return;
    }
    if (document !== this.virtual_document) {
      return;
    }
    let virtual_position = this.editor.root_position_to_virtual_position(
      root_position
    );
    this.connection.getDocumentHighlights(virtual_position);
  }

  protected range_to_editor_range(
    range: lsProtocol.Range,
    cm_editor?: CodeMirror.Editor
  ): IEditorRange {
    let start = PositionConverter.lsp_to_cm(range.start) as IVirtualPosition;
    let end = PositionConverter.lsp_to_cm(range.end) as IVirtualPosition;

    if (typeof cm_editor === 'undefined') {
      let start_in_root = this.transform_virtual_position_to_root_position(
        start
      );
      cm_editor = this.editor.get_editor_at_root_position(start_in_root);
    }

    return {
      start: this.virtual_document.transform_virtual_to_editor(start),
      end: this.virtual_document.transform_virtual_to_editor(end),
      editor: cm_editor
    };
  }

  protected editor_range_for_hover(range: lsProtocol.Range): IEditorRange {
    let character = this.hover_character;
    // NOTE: foreign document ranges are checked before the request is sent,
    // no need to to this again here.

    if (range) {
      let cm_editor = this.editor.get_editor_at_root_position(character);
      return this.range_to_editor_range(range, cm_editor);
    } else {
      // construct range manually using the token information
      let cm_editor = this.virtual_document.root.get_editor_at_source_line(
        character
      );
      let token = this.editor.getTokenAt(character);

      let start_in_root = {
        line: character.line,
        ch: token.start
      } as IRootPosition;
      let end_in_root = {
        line: character.line,
        ch: token.end
      } as IRootPosition;

      return {
        start: this.editor.root_position_to_editor_position(start_in_root),
        end: this.editor.root_position_to_editor_position(end_in_root),
        editor: cm_editor
      };
    }
  }

  protected highlight_range(
    range: IEditorRange,
    class_name: string
  ): CodeMirror.TextMarker {
    return range.editor
      .getDoc()
      .markText(range.start, range.end, { className: class_name });
  }

  protected position_from_mouse(ev: MouseEvent): IRootPosition {
    return this.editor.coordsChar(
      {
        left: ev.clientX,
        top: ev.clientY
      },
      'window'
    ) as IRootPosition;
  }

  protected is_token_empty(token: CodeMirror.Token) {
    return token.string.length === 0;
    // TODO  || token.type.length === 0? (sometimes the underline is shown on meaningless tokens)
  }

  public _handleMouseOver(event: MouseEvent) {
    // currently the events are coming from notebook panel; ideally these would be connected to individual cells,
    // (only cells with code) instead, but this is more complex to implement right. In any case filtering
    // is needed to determine in hovered character belongs to this virtual document

    let root_position = this.position_from_mouse(event);

    // happens because mousemove is attached to panel, not individual code cells,
    // and because some regions of the editor (between lines) have no characters
    if (typeof root_position === 'undefined') {
      this.remove_range_highlight();
      this.hover_character = null;
      return;
    }

    let token = this.editor.getTokenAt(root_position);

    let document = this.editor.document_at_root_position(root_position);
    let virtual_position = this.editor.root_position_to_virtual_position(
      root_position
    );

    if (
      this.is_token_empty(token) ||
      document !== this.virtual_document ||
      // @ts-ignore
      !this._isEventInsideVisible(event)
    ) {
      this.remove_range_highlight();
      this.hover_character = null;
      return;
    }

    if (!is_equal(root_position, this.hover_character)) {
      this.hover_character = root_position;
      // @ts-ignore
      this.debouncedGetHover(virtual_position);
    }
  }

  public handleMouseOver(event: MouseEvent) {
    // proceed when no hover modifier or hover modifier pressed
    this.show_next_tooltip =
      !hover_modifier || getModifierState(event, hover_modifier);

    try {
      return this._handleMouseOver(event);
    } catch (e) {
      if (
        !(
          e.message === 'Cell not found in cell_line_map' ||
          e.message === "Cannot read property 'string' of undefined"
        )
      ) {
        throw e;
      }
    }
  }

  protected collapse_overlapping_diagnostics(
    diagnostics: lsProtocol.Diagnostic[]
  ): Map<lsProtocol.Range, lsProtocol.Diagnostic[]> {
    // because Range is not a primitive type, the equality of the objects having
    // the same parameters won't be compared (thus considered equal) in Map.

    // instead, a intermediate step of mapping through a stringified representation of Range is needed:
    // an alternative would be using nested [start line][start character][end line][end character] structure,
    // which would increase the code complexity, but reduce memory use and may be slightly faster.
    type RangeID = string;
    const range_id_to_range = new Map<RangeID, lsProtocol.Range>();
    const range_id_to_diagnostics = new Map<RangeID, lsProtocol.Diagnostic[]>();

    function get_range_id(range: lsProtocol.Range): RangeID {
      return (
        range.start.line +
        ',' +
        range.start.character +
        ',' +
        range.end.line +
        ',' +
        range.end.character
      );
    }

    diagnostics.forEach((diagnostic: lsProtocol.Diagnostic) => {
      let range = diagnostic.range;
      let range_id = get_range_id(range);
      range_id_to_range.set(range_id, range);
      if (range_id_to_diagnostics.has(range_id)) {
        let ranges_list = range_id_to_diagnostics.get(range_id);
        ranges_list.push(diagnostic);
      } else {
        range_id_to_diagnostics.set(range_id, [diagnostic]);
      }
    });

    let map = new Map<lsProtocol.Range, lsProtocol.Diagnostic[]>();

    range_id_to_diagnostics.forEach(
      (range_diagnostics: lsProtocol.Diagnostic[], range_id: RangeID) => {
        let range = range_id_to_range.get(range_id);
        map.set(range, range_diagnostics);
      }
    );

    return map;
  }

  public handleDiagnostic(response: lsProtocol.PublishDiagnosticsParams) {
    /* TODO: gutters */
    try {
      // Note: no deep equal for Sets or Maps in JS
      const markers_to_retain: Set<string> = new Set<string>();

      // add new markers, keep track of the added ones

      // TODO: test for diagnostic messages not being over-writen
      //  test case: from statistics import mean, bisect_left
      //  and do not use either; expected: title has "mean imported but unused; bisect_left imported and unused'
      // TODO: test case for severity class always being set, even if diagnostic has no severity

      let diagnostics_by_range = this.collapse_overlapping_diagnostics(
        response.diagnostics
      );

      diagnostics_by_range.forEach(
        (diagnostics: lsProtocol.Diagnostic[], range: lsProtocol.Range) => {
          const start = PositionConverter.lsp_to_cm(
            range.start
          ) as IVirtualPosition;
          const end = PositionConverter.lsp_to_cm(
            range.end
          ) as IVirtualPosition;
          if (start.line > this.virtual_document.last_virtual_line) {
            console.log(
              'Malformed diagnostic was skipped (out of lines) ',
              diagnostics
            );
            return;
          }
          // assuming that we got a response for this document
          let start_in_root = this.transform_virtual_position_to_root_position(
            start
          );
          let document = this.editor.document_at_root_position(start_in_root);

          // TODO why do I get signals from the other connection in the first place?
          //  A: because each virtual document adds listeners AND if the extracted content
          //  is kept in the host document, it remains in the same editor.
          if (this.virtual_document !== document) {
            console.log(
              `Ignoring inspections from ${response.uri}`,
              ` (this region is covered by a another virtual document: ${document.uri})`,
              ` inspections: `,
              diagnostics
            );
            return;
          }

          if (
            document.virtual_lines
              .get(start.line)
              .skip_inspect.indexOf(document.id_path) !== -1
          ) {
            console.log(
              'Ignoring inspections silenced for this document:',
              diagnostics
            );
            return;
          }

          let highest_severity_code = diagnostics
            .map(diagnostic => diagnostic.severity || default_severity)
            .sort()[0];

          const severity = diagnosticSeverityNames[highest_severity_code];

          let cm_editor = document.get_editor_at_virtual_line(start);

          let start_in_editor = document.transform_virtual_to_editor(start);
          let end_in_editor = document.transform_virtual_to_editor(end);
          // what a pity there is no hash in the standard library...
          // we could use this: https://stackoverflow.com/a/7616484 though it may not be worth it:
          //   the stringified diagnostic objects are only about 100-200 JS characters anyway,
          //   depending on the message length; this could be reduced using some structure-aware
          //   stringifier; such a stringifier could also prevent the possibility of having a false
          //   negative due to a different ordering of keys
          // obviously, the hash would prevent recovery of info from the key.
          let diagnostic_hash = JSON.stringify({
            // diagnostics without ranges
            diagnostics: diagnostics.map(diagnostic => [
              diagnostic.severity,
              diagnostic.message,
              diagnostic.code,
              diagnostic.source,
              diagnostic.relatedInformation
            ]),
            // the apparent marker position will change in the notebook with every line change for each marker
            // after the (inserted/removed) line - but such markers should not be invalidated,
            // i.e. the invalidation should be performed in the cell space, not in the notebook coordinate space,
            // thus we transform the coordinates and keep the cell id in the hash
            range: {
              start: start_in_editor,
              end: end_in_editor
            },
            editor: this.unique_editor_ids.get(cm_editor)
          });
          markers_to_retain.add(diagnostic_hash);

          if (!this.marked_diagnostics.has(diagnostic_hash)) {
            let options: CodeMirror.TextMarkerOptions = {
              title: diagnostics
                .map(d => d.message + (d.source ? ' (' + d.source + ')' : ''))
                .join('\n'),
              className: 'cm-lsp-diagnostic cm-lsp-diagnostic-' + severity
            };
            let marker;
            try {
              marker = cm_editor
                .getDoc()
                .markText(start_in_editor, end_in_editor, options);
            } catch (e) {
              console.warn(
                'Marking inspection (diagnostic text) failed, see following logs (2):'
              );
              console.log(diagnostics);
              console.log(e);
              return;
            }
            this.marked_diagnostics.set(diagnostic_hash, marker);
          }
        }
      );

      // remove the markers which were not included in the new message
      this.marked_diagnostics.forEach(
        (marker: CodeMirror.TextMarker, diagnostic_hash: string) => {
          if (!markers_to_retain.has(diagnostic_hash)) {
            this.marked_diagnostics.delete(diagnostic_hash);
            marker.clear();
          }
        }
      );
    } catch (e) {
      console.warn(e);
    }
  }

  private transform_virtual_position_to_root_position(
    start: IVirtualPosition
  ): IRootPosition {
    let cm_editor = this.virtual_document.virtual_lines.get(start.line).editor;
    let editor_position = this.virtual_document.transform_virtual_to_editor(
      start
    );
    return this.editor.transform_editor_to_root(cm_editor, editor_position);
  }
}
