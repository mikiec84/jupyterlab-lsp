import { expect } from 'chai';
import { position_at_offset, RegExpForeignCodeExtractor } from './regexp';

let R_CELL_MAGIC_EXISTS = `%%R
some text
`;

let NO_CELL_MAGIC = `%R
some text
%%R
some text
`;

let R_LINE_MAGICS = `%R df = data.frame()
print("df created")
%R ggplot(df)
print("plotted")
`;

let HTML_IN_PYTHON = `
x = """<a href="#">
<b>important</b> link
</a>""";
print(x)`;

describe('positionAtOffset', () => {
  it('works with single line', () => {
    let position = position_at_offset(0, ['']);
    expect(position).deep.equal({ column: 0, line: 0 });

    position = position_at_offset(0, ['abc']);
    expect(position).deep.equal({ column: 0, line: 0 });

    position = position_at_offset(1, ['abc']);
    expect(position).deep.equal({ column: 1, line: 0 });

    position = position_at_offset(2, ['abc']);
    expect(position).deep.equal({ column: 2, line: 0 });
  });

  it('works two lines', () => {
    let two_empty_lines = '\n'.split('\n');
    let two_single_character_lines = 'a\nb'.split('\n');

    let position = position_at_offset(0, two_empty_lines);
    expect(position).deep.equal({ column: 0, line: 0 });

    position = position_at_offset(1, two_empty_lines);
    expect(position).deep.equal({ column: 0, line: 1 });

    position = position_at_offset(1, two_single_character_lines);
    expect(position).deep.equal({ column: 1, line: 0 });

    position = position_at_offset(2, two_single_character_lines);
    expect(position).deep.equal({ column: 0, line: 1 });

    position = position_at_offset(3, two_single_character_lines);
    expect(position).deep.equal({ column: 1, line: 1 });
  });
});

describe('RegExpForeignCodeExtractor', () => {
  let r_cell_extractor = new RegExpForeignCodeExtractor({
    language: 'R',
    pattern: '^%%R( .*?)?\n([^]*)',
    extract_to_foreign: '$2',
    keep_in_host: true,
    is_standalone: false
  });

  let r_line_extractor = new RegExpForeignCodeExtractor({
    language: 'R',
    pattern: '(^|\n)%R (.*)\n?',
    extract_to_foreign: '$2',
    keep_in_host: true,
    is_standalone: false
  });

  describe('#has_foreign_code()', () => {
    it('detects cell magics', () => {
      let result = r_cell_extractor.has_foreign_code(R_CELL_MAGIC_EXISTS);
      expect(result).to.equal(true);

      result = r_cell_extractor.has_foreign_code(R_LINE_MAGICS);
      expect(result).to.equal(false);

      result = r_cell_extractor.has_foreign_code(NO_CELL_MAGIC);
      expect(result).to.equal(false);
    });

    it('is not stateful', () => {
      // stateful implementation of regular expressions in JS can easily lead to
      // an error manifesting it two consecutive checks giving different results,
      // as the last index was moved in between:
      let result = r_cell_extractor.has_foreign_code(R_CELL_MAGIC_EXISTS);
      expect(result).to.equal(true);

      result = r_cell_extractor.has_foreign_code(R_CELL_MAGIC_EXISTS);
      expect(result).to.equal(true);
    });

    it('detects line magics', () => {
      let result = r_line_extractor.has_foreign_code(R_LINE_MAGICS);
      expect(result).to.equal(true);

      result = r_line_extractor.has_foreign_code(R_CELL_MAGIC_EXISTS);
      expect(result).to.equal(false);
    });
  });

  describe('#extract_foreign_code()', () => {
    it('should work with non-line magic and non-cell magic code snippets as well', () => {
      // Note: in the real application, one should NOT use regular expressions for HTML extraction

      let html_extractor = new RegExpForeignCodeExtractor({
        language: 'HTML',
        pattern: '<(.*?)( .*?)?>([^]*?)</\\1>',
        extract_to_foreign: '<$1$2>$3</$1>',
        keep_in_host: false,
        is_standalone: false
      });

      let results = html_extractor.extract_foreign_code(HTML_IN_PYTHON);
      expect(results.length).to.equal(2);
      let result = results[0];
      // TODO: is tolerating the new line added here ok?
      expect(result.host_code).to.equal('\nx = """\n');
      expect(result.foreign_code).to.equal(
        '<a href="#">\n<b>important</b> link\n</a>'
      );
      expect(result.range.start.line).to.equal(1);
      expect(result.range.start.column).to.equal(7);
      expect(result.range.end.line).to.equal(3);
      expect(result.range.end.column).to.equal(4);
      let last_bit = results[1];
      expect(last_bit.host_code).to.equal('""";\nprint(x)');
    });

    it('should extract cell magics and keep in host', () => {
      let results = r_cell_extractor.extract_foreign_code(R_CELL_MAGIC_EXISTS);
      expect(results.length).to.equal(1);
      let result = results[0];

      expect(result.host_code).to.equal(R_CELL_MAGIC_EXISTS);
      expect(result.foreign_code).to.equal('some text\n');
      expect(result.range.start.line).to.equal(1);
      expect(result.range.start.column).to.equal(0);
    });

    it('should extract and remove from host', () => {
      let extractor = new RegExpForeignCodeExtractor({
        language: 'R',
        pattern: '^%%R( .*?)?\n([^]*)',
        extract_to_foreign: '$2',
        keep_in_host: false,
        is_standalone: false
      });
      let results = extractor.extract_foreign_code(R_CELL_MAGIC_EXISTS);
      expect(results.length).to.equal(1);

      let result = results[0];

      expect(result.foreign_code).to.equal('some text\n');
      expect(result.host_code).to.equal('');
    });

    it('should extract multiple line magics deleting them from host', () => {
      let r_line_extractor = new RegExpForeignCodeExtractor({
        language: 'R',
        pattern: '(^|\n)%R (.*)\n?',
        extract_to_foreign: '$2',
        keep_in_host: false,
        is_standalone: false
      });
      let results = r_line_extractor.extract_foreign_code(R_LINE_MAGICS);

      // 2 line magics to be extracted + the unprocessed host code
      expect(results.length).to.eq(3);

      let first_magic = results[0];

      expect(first_magic.foreign_code).to.equal('df = data.frame()');
      expect(first_magic.host_code).to.equal('');

      let second_magic = results[1];

      expect(second_magic.foreign_code).to.equal('ggplot(df)');
      expect(second_magic.host_code).to.equal('print("df created")\n');

      let final_bit = results[2];

      expect(final_bit.foreign_code).to.equal(null);
      expect(final_bit.host_code).to.equal('print("plotted")\n');
    });

    it('should extract multiple line magics preserving them in host', () => {
      let results = r_line_extractor.extract_foreign_code(R_LINE_MAGICS);

      // 2 line magics to be extracted + the unprocessed host code
      expect(results.length).to.eq(3);

      let first_magic = results[0];

      expect(first_magic.foreign_code).to.equal('df = data.frame()');
      expect(first_magic.host_code).to.equal('%R df = data.frame()\n');
      expect(first_magic.range.end.line).to.equal(0);
      expect(first_magic.range.end.column).to.equal(20);

      let second_magic = results[1];

      expect(second_magic.foreign_code).to.equal('ggplot(df)');
      expect(second_magic.host_code).to.equal(
        'print("df created")\n%R ggplot(df)\n'
      );

      let final_bit = results[2];

      expect(final_bit.foreign_code).to.equal(null);
      expect(final_bit.host_code).to.equal('print("plotted")\n');
    });

    it('should extract single line magic which does not end with a blank line', () => {
      let results = r_line_extractor.extract_foreign_code('%R test');

      expect(results.length).to.eq(1);
      let result = results[0];
      expect(result.foreign_code).to.equal('test');
    });

    it('should not extract magic-like text from the middle of the cell', () => {
      let results = r_cell_extractor.extract_foreign_code(NO_CELL_MAGIC);

      expect(results.length).to.eq(1);
      let result = results[0];
      expect(result.foreign_code).to.equal(null);
      expect(result.host_code).to.equal(NO_CELL_MAGIC);
      expect(result.range).to.equal(null);
    });
  });
});
