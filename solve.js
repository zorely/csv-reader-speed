// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Returns exactly csv-reader 1.0.0's answer {columns, rows, errors} for an
// input {text, header}, following its written broken-row policy:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, and each CRLF or lone CR inside it read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends); a quote that
//     never closes is a literal character, and the text after it is read again
//     as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (short_row, with fields: its count) or cut (long_row, with
//     extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met, a field's quote_junk
//     when the field ends and a record's short_row or long_row when the record
//     ends: line the 1-based line its record starts on, counting every LF,
//     CRLF and lone CR inside quotes, and row its record's index in rows,
//     null for the header.
//
// Speed: the reference reads one character at a time and builds every field
// a character at a time. This one instead slices fields out of the text:
// a record whose first physical line holds no quote and no stray CR is split
// in one native split(','), and every other field is found with a regex
// delimiter scan (unquoted) or indexOf (quoted), so no per-character loop
// runs over the bulk of the text. Pure: no clock, no randomness, no locale,
// nothing kept from one call to the next.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0; // a U+FEFF at the very start is dropped
  let line = 1; // the line the character at pos is on

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The next delimiter of an unquoted field: a comma, a CR or an LF.
  const delim = /[,\r\n]/g;

  // How the field just read ended (COMMA, LINE_BREAK or END).
  let ended = END;

  // Reads unquoted characters from pos onto `value` up to the next comma or
  // line break: a CR not followed by LF is dropped (stray_cr). Returns
  // {value, added}, `added` counting the characters kept.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      delim.lastIndex = pos;
      const m = delim.exec(text);
      if (m === null) {
        if (pos < len) {
          value += text.slice(pos);
          added += len - pos;
        }
        pos = len;
        ended = END;
        return { value, added };
      }
      const i = m.index;
      if (i > pos) {
        value += text.slice(pos, i);
        added += i - pos;
      }
      const c = m[0];
      if (c === ',') {
        pos = i + 1;
        ended = COMMA;
        return { value, added };
      }
      if (c === '\n') {
        pos = i + 1;
        line += 1;
        ended = LINE_BREAK;
        return { value, added };
      }
      // A CR: a line break when followed by LF, else dropped (stray_cr).
      if (text.charCodeAt(i + 1) === 10) {
        pos = i + 2;
        line += 1;
        ended = LINE_BREAK;
        return { value, added };
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = i + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns {value, added}
  // (added only ever counts for the junk path, as the reference's readUnquoted
  // does) and sets `ended`.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let segStart = open + 1;
    let parts = null; // segments kept when "" doubling splits the field
    let close = -1;
    let q = text.indexOf('"', segStart);
    while (q !== -1) {
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one literal quote, and the field goes on.
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, q));
        parts.push('"');
        segStart = q + 2;
        q = text.indexOf('"', segStart);
      } else {
        close = q;
        break;
      }
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted.
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      pos = open + 1;
      line = openLine;
      return readUnquoted('"');
    }
    // The closing quote is at close. Count the line breaks inside it so the
    // line stays exact: every LF, and every CR not followed by LF.
    let breaks = 0;
    let ni = text.indexOf('\n', open + 1);
    while (ni !== -1 && ni < close) {
      breaks += 1;
      ni = text.indexOf('\n', ni + 1);
    }
    const ri = text.indexOf('\r', open + 1);
    let value;
    if (parts === null) value = text.slice(open + 1, close);
    else {
      parts.push(text.slice(segStart, close));
      value = parts.join('');
    }
    if (ri !== -1 && ri < close) {
      // CRLF and a lone CR inside quotes are each one LF, in the value and in
      // the line count.
      let rj = ri;
      while (rj !== -1 && rj < close) {
        if (text.charCodeAt(rj + 1) !== 10) breaks += 1;
        rj = text.indexOf('\r', rj + 1);
      }
      value = value.replace(/\r\n?/g, '\n');
    }
    line += breaks;
    pos = close + 1;
    if (pos >= len) {
      ended = END;
      return { value, added: 0 };
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      ended = COMMA;
      return { value, added: 0 };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      ended = LINE_BREAK;
      return { value, added: 0 };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      ended = LINE_BREAK;
      return { value, added: 0 };
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // Reads one record starting at pos, whose first physical line holds a quote
  // or a stray CR, field by field.
  function readRecordSlow() {
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    for (;;) {
      let field;
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        field = readQuoted();
      } else {
        quoted = false;
        field = readUnquoted('');
      }
      fields.push(field.value);
      if (ended !== COMMA) break;
    }
    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    finishRecord(fields);
  }

  // Widths, the header, and short/long rows for a record just read.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (pos < len) {
    // The record's first physical line, up to its LF (or the end of the text).
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    const q = text.indexOf('"', pos);
    if (q !== -1 && q < lineEnd) {
      readRecordSlow();
      continue;
    }
    const cr = text.indexOf('\r', pos);
    if (cr !== -1 && cr < lineEnd && !(cr === lineEnd - 1 && nl !== -1)) {
      // A stray CR on the first line: the record needs the slow read.
      readRecordSlow();
      continue;
    }
    // A plain record: no quote, no stray CR. Its line is split in one go;
    // a trailing CR here is the CRLF line break's.
    let segEnd = lineEnd;
    if (nl !== -1 && cr !== -1 && cr === lineEnd - 1) segEnd = lineEnd - 1;
    if (segEnd === pos) {
      // A line left with no characters is no record.
      pos = nl === -1 ? len : nl + 1;
      line += 1;
      continue;
    }
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = text.slice(pos, segEnd).split(',');
    line += 1;
    pos = nl === -1 ? len : nl + 1;
    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
