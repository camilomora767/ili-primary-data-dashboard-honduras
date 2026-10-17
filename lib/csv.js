// Keep fields positional: Qualtrics export tags need not be unique.
export function parseCsvRecords(input) {
  const text = String(input).replace(/^\uFEFF/, '');
  const records = [];
  let values = [], value = '', quoted = false, afterQuote = false, start = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; afterQuote = true; }
      } else value += char;
      continue;
    }

    if (char === ',' || char === '\r' || char === '\n') {
      values.push(value);
      value = '';
      afterQuote = false;
      if (char !== ',') {
        records.push({ values, raw: text.slice(start, i) });
        values = [];
        if (char === '\r' && text[i + 1] === '\n') i++;
        start = i + 1;
      }
    } else if (char === '"' && value === '' && !afterQuote) {
      quoted = true;
    } else {
      if (char === '"' || afterQuote) throw new Error('Malformed Qualtrics CSV quoting');
      value += char;
    }
  }

  if (quoted) throw new Error('Unclosed quoted field in Qualtrics CSV');
  if (start < text.length) {
    values.push(value);
    records.push({ values, raw: text.slice(start) });
  }
  return records;
}

export function completedResponsesCsv(text) {
  const records = parseCsvRecords(text);
  if (records.length < 2) throw new Error('Qualtrics CSV is missing its header rows');
  const headers = records[0].values;
  const finishedIndex = headers.findIndex(value => value.toLowerCase() === 'finished');
  const responseIdIndex = headers.findIndex(value => value.toLowerCase() === 'responseid');
  if (finishedIndex < 0 || responseIdIndex < 0) {
    throw new Error('Qualtrics CSV is missing Finished or ResponseId');
  }

  let metadataRows = 2;
  try {
    // CSV adds an ImportId row; keep it out of the native two-row Excel header.
    const importId = JSON.parse(records[2]?.values[finishedIndex] ?? 'null');
    if (typeof importId?.ImportId === 'string') metadataRows = 3;
  } catch { /* Without ImportId metadata, record three is a response. */ }

  const selected = [];
  for (const [index, record] of records.entries()) {
    if (index >= metadataRows && record.raw === '') continue;
    if (record.values.length !== headers.length) {
      throw new Error(`Qualtrics CSV record ${index + 1} has an unexpected column count`);
    }
    if (index < metadataRows) { selected.push(record.raw); continue; }
    const finished = record.values[finishedIndex].trim().toLowerCase();
    if (['true', '1', 'yes'].includes(finished)) selected.push(record.raw);
    else if (!['', 'false', '0', 'no'].includes(finished)) {
      throw new Error(`Qualtrics CSV record ${index + 1} has an unexpected Finished value`);
    }
  }
  // One BOM keeps Spanish text and emoji readable in Excel.
  return '\uFEFF' + selected.join('\r\n') + '\r\n';
}
