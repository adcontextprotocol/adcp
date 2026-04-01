import { describe, it, expect } from 'vitest';
import * as zlib from 'zlib';
import { _testing } from '../../src/addie/jobs/committee-document-indexer.js';

const {
  decodeXmlEntities,
  extractTextFromSlideXml,
  parseSharedStrings,
  parseSheetXml,
  parsePptxContent,
  parseXlsxContent,
  parseDocxContent,
} = _testing;

// ---------------------------------------------------------------------------
// ZIP builder helper: creates minimal ZIP buffers for OOXML testing
// ---------------------------------------------------------------------------

function createZipBuffer(entries: Record<string, string | Buffer>): Buffer {
  const files: Array<{
    name: Buffer;
    data: Buffer;
    crc: number;
    compressedData: Buffer;
  }> = [];

  for (const [name, content] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, 'utf-8');
    const data = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const compressedData = zlib.deflateRawSync(data);
    const crc = crc32(data);
    files.push({ name: nameBuffer, data, crc, compressedData });
  }

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;

  // Local file headers + data
  for (const file of files) {
    offsets.push(offset);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header signature
    header.writeUInt16LE(20, 4);         // version needed
    header.writeUInt16LE(0, 6);          // general purpose bit flag
    header.writeUInt16LE(8, 8);          // compression method: deflate
    header.writeUInt16LE(0, 10);         // last mod file time
    header.writeUInt16LE(0, 12);         // last mod file date
    header.writeUInt32LE(file.crc, 14);  // crc-32
    header.writeUInt32LE(file.compressedData.length, 18); // compressed size
    header.writeUInt32LE(file.data.length, 22);           // uncompressed size
    header.writeUInt16LE(file.name.length, 26);           // file name length
    header.writeUInt16LE(0, 28);                          // extra field length
    chunks.push(header, file.name, file.compressedData);
    offset += 30 + file.name.length + file.compressedData.length;
  }

  // Central directory
  const centralDirStart = offset;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);  // central directory file header signature
    cdHeader.writeUInt16LE(20, 4);          // version made by
    cdHeader.writeUInt16LE(20, 6);          // version needed
    cdHeader.writeUInt16LE(0, 8);           // general purpose bit flag
    cdHeader.writeUInt16LE(8, 10);          // compression method: deflate
    cdHeader.writeUInt16LE(0, 12);          // last mod file time
    cdHeader.writeUInt16LE(0, 14);          // last mod file date
    cdHeader.writeUInt32LE(file.crc, 16);   // crc-32
    cdHeader.writeUInt32LE(file.compressedData.length, 20); // compressed size
    cdHeader.writeUInt32LE(file.data.length, 24);           // uncompressed size
    cdHeader.writeUInt16LE(file.name.length, 28);           // file name length
    cdHeader.writeUInt16LE(0, 30);          // extra field length
    cdHeader.writeUInt16LE(0, 32);          // file comment length
    cdHeader.writeUInt16LE(0, 34);          // disk number start
    cdHeader.writeUInt16LE(0, 36);          // internal file attributes
    cdHeader.writeUInt32LE(0, 38);          // external file attributes
    cdHeader.writeUInt32LE(offsets[i], 42); // relative offset of local header
    chunks.push(cdHeader, file.name);
    offset += 46 + file.name.length;
  }

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);  // end of central directory signature
  eocd.writeUInt16LE(0, 4);           // disk number
  eocd.writeUInt16LE(0, 6);           // disk with central directory
  eocd.writeUInt16LE(files.length, 8);  // number of entries on disk
  eocd.writeUInt16LE(files.length, 10); // total number of entries
  eocd.writeUInt32LE(offset - centralDirStart, 12); // size of central directory
  eocd.writeUInt32LE(centralDirStart, 16);          // offset of central directory
  eocd.writeUInt16LE(0, 20);                        // comment length
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

/** Simple CRC-32 implementation for ZIP file creation */
function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------------------
// decodeXmlEntities
// ---------------------------------------------------------------------------

describe('decodeXmlEntities', () => {
  it('decodes standard named entities', () => {
    expect(decodeXmlEntities('P&amp;G')).toBe('P&G');
    expect(decodeXmlEntities('a &lt; b &gt; c')).toBe('a < b > c');
    expect(decodeXmlEntities('&quot;hello&quot;')).toBe('"hello"');
    expect(decodeXmlEntities('it&apos;s')).toBe("it's");
  });

  it('decodes numeric character references', () => {
    expect(decodeXmlEntities('&#65;')).toBe('A');
    expect(decodeXmlEntities('&#x41;')).toBe('A');
    expect(decodeXmlEntities('&#8212;')).toBe('\u2014'); // em dash
  });

  it('decodes supplementary plane characters (above U+FFFF)', () => {
    expect(decodeXmlEntities('&#128512;')).toBe('\u{1F600}');  // grinning face emoji
    expect(decodeXmlEntities('&#x1F600;')).toBe('\u{1F600}');
  });

  it('strips null bytes and surrogate codepoints', () => {
    expect(decodeXmlEntities('&#0;')).toBe('');
    expect(decodeXmlEntities('&#x0;')).toBe('');
    expect(decodeXmlEntities('&#55296;')).toBe('');  // U+D800 lone surrogate
    expect(decodeXmlEntities('&#xD800;')).toBe('');
  });

  it('passes through plain text unchanged', () => {
    expect(decodeXmlEntities('hello world')).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// extractTextFromSlideXml (PPTX)
// ---------------------------------------------------------------------------

describe('extractTextFromSlideXml', () => {
  it('extracts text from <a:t> tags', () => {
    const xml = `
      <p:sp><p:txBody>
        <a:p><a:r><a:t>Hello</a:t></a:r></a:p>
        <a:p><a:r><a:t>World</a:t></a:r></a:p>
      </p:txBody></p:sp>
    `;
    expect(extractTextFromSlideXml(xml)).toBe('Hello World');
  });

  it('skips empty text runs', () => {
    const xml = '<a:t>Real</a:t><a:t>  </a:t><a:t>Content</a:t>';
    expect(extractTextFromSlideXml(xml)).toBe('Real Content');
  });

  it('decodes XML entities in slide text', () => {
    const xml = '<a:t>P&amp;G Revenue &gt; $1B</a:t>';
    expect(extractTextFromSlideXml(xml)).toBe('P&G Revenue > $1B');
  });

  it('returns empty string for no text', () => {
    expect(extractTextFromSlideXml('<p:sp></p:sp>')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseSharedStrings (XLSX)
// ---------------------------------------------------------------------------

describe('parseSharedStrings', () => {
  it('extracts strings from <si><t> elements', () => {
    const xml = `<?xml version="1.0"?>
      <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <si><t>Name</t></si>
        <si><t>Revenue</t></si>
        <si><t>Year</t></si>
      </sst>`;
    expect(parseSharedStrings(xml)).toEqual(['Name', 'Revenue', 'Year']);
  });

  it('concatenates rich text runs within a single <si>', () => {
    const xml = `<sst>
      <si><r><t>Bold</t></r><r><t> Normal</t></r></si>
    </sst>`;
    expect(parseSharedStrings(xml)).toEqual(['Bold Normal']);
  });

  it('decodes XML entities', () => {
    const xml = '<sst><si><t>P&amp;G</t></si></sst>';
    expect(parseSharedStrings(xml)).toEqual(['P&G']);
  });

  it('returns empty array for no strings', () => {
    expect(parseSharedStrings('<sst></sst>')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseSheetXml (XLSX)
// ---------------------------------------------------------------------------

describe('parseSheetXml', () => {
  const sharedStrings = ['Name', 'Alice', 'Bob', 'Revenue'];

  it('resolves shared string references', () => {
    const xml = `<sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>3</v></c></row>
      <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>100</v></c></row>
      <row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3"><v>200</v></c></row>
    </sheetData>`;
    const rows = parseSheetXml(xml, sharedStrings);
    expect(rows).toEqual(['Name\tRevenue', 'Alice\t100', 'Bob\t200']);
  });

  it('handles inline string cells (t="inlineStr")', () => {
    const xml = `<sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Inline Value</t></is></c></row>
    </sheetData>`;
    const rows = parseSheetXml(xml, []);
    expect(rows).toEqual(['Inline Value']);
  });

  it('handles cells without attributes', () => {
    const xml = `<sheetData>
      <row r="1"><c><v>42</v></c></row>
    </sheetData>`;
    const rows = parseSheetXml(xml, []);
    expect(rows).toEqual(['42']);
  });

  it('decodes XML entities in values', () => {
    const xml = `<sheetData>
      <row r="1"><c><v>100 &amp; counting</v></c></row>
    </sheetData>`;
    const rows = parseSheetXml(xml, []);
    expect(rows).toEqual(['100 & counting']);
  });

  it('skips empty rows', () => {
    const xml = `<sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c></row>
      <row r="2"></row>
      <row r="3"><c r="A3" t="s"><v>1</v></c></row>
    </sheetData>`;
    const rows = parseSheetXml(xml, sharedStrings);
    expect(rows).toEqual(['Name', 'Alice']);
  });

  it('falls back to raw value for out-of-bounds shared string index', () => {
    const xml = `<sheetData>
      <row r="1"><c r="A1" t="s"><v>999</v></c></row>
    </sheetData>`;
    const rows = parseSheetXml(xml, ['only one']);
    expect(rows).toEqual(['999']);
  });
});

// ---------------------------------------------------------------------------
// parsePptxContent (full ZIP-based test)
// ---------------------------------------------------------------------------

describe('parsePptxContent', () => {
  it('extracts text from a minimal PPTX', async () => {
    const slide1Xml = `<?xml version="1.0" encoding="UTF-8"?>
      <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p><a:r><a:t>Campaign Overview</a:t></a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>`;

    const slide2Xml = `<?xml version="1.0" encoding="UTF-8"?>
      <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p><a:r><a:t>Gold Peak Tea Q3 2026</a:t></a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>`;

    const buffer = createZipBuffer({
      'ppt/slides/slide1.xml': slide1Xml,
      'ppt/slides/slide2.xml': slide2Xml,
    });

    const result = await parsePptxContent(buffer);
    expect(result.status).toBe('success');
    expect(result.content).toContain('Campaign Overview');
    expect(result.content).toContain('Gold Peak Tea Q3 2026');
  });

  it('returns error for invalid ZIP', async () => {
    const result = await parsePptxContent(Buffer.from('not a zip file'));
    expect(result.status).toBe('error');
  });

  it('returns error for PPTX with no slides', async () => {
    const buffer = createZipBuffer({
      'ppt/presentation.xml': '<Presentation/>',
    });
    const result = await parsePptxContent(buffer);
    expect(result.status).toBe('error');
    expect(result.error).toContain('no extractable content');
  });
});

// ---------------------------------------------------------------------------
// parseXlsxContent (full ZIP-based test)
// ---------------------------------------------------------------------------

describe('parseXlsxContent', () => {
  it('extracts text from a minimal XLSX with shared strings', async () => {
    const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8"?>
      <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <si><t>Vendor</t></si>
        <si><t>Channel</t></si>
        <si><t>Scope3</t></si>
        <si><t>Programmatic</t></si>
        <si><t>PubMatic</t></si>
        <si><t>Display</t></si>
      </sst>`;

    const sheet1Xml = `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetData>
          <row r="1">
            <c r="A1" t="s"><v>0</v></c>
            <c r="B1" t="s"><v>1</v></c>
          </row>
          <row r="2">
            <c r="A2" t="s"><v>2</v></c>
            <c r="B2" t="s"><v>3</v></c>
          </row>
          <row r="3">
            <c r="A3" t="s"><v>4</v></c>
            <c r="B3" t="s"><v>5</v></c>
          </row>
        </sheetData>
      </worksheet>`;

    const buffer = createZipBuffer({
      'xl/sharedStrings.xml': sharedStringsXml,
      'xl/worksheets/sheet1.xml': sheet1Xml,
    });

    const result = await parseXlsxContent(buffer);
    expect(result.status).toBe('success');
    expect(result.content).toContain('Vendor\tChannel');
    expect(result.content).toContain('Scope3\tProgrammatic');
    expect(result.content).toContain('PubMatic\tDisplay');
  });

  it('handles numeric values alongside shared strings', async () => {
    const sharedStringsXml = `<sst><si><t>Amount</t></si></sst>`;
    const sheet1Xml = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c></row>
      <row r="2"><c r="A2"><v>1500.50</v></c></row>
    </sheetData></worksheet>`;

    const buffer = createZipBuffer({
      'xl/sharedStrings.xml': sharedStringsXml,
      'xl/worksheets/sheet1.xml': sheet1Xml,
    });

    const result = await parseXlsxContent(buffer);
    expect(result.status).toBe('success');
    expect(result.content).toContain('Amount');
    expect(result.content).toContain('1500.50');
  });

  it('handles XLSX with entities in shared strings', async () => {
    const sharedStringsXml = `<sst><si><t>P&amp;G</t></si></sst>`;
    const sheet1Xml = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c></row>
    </sheetData></worksheet>`;

    const buffer = createZipBuffer({
      'xl/sharedStrings.xml': sharedStringsXml,
      'xl/worksheets/sheet1.xml': sheet1Xml,
    });

    const result = await parseXlsxContent(buffer);
    expect(result.status).toBe('success');
    expect(result.content).toContain('P&G');
  });

  it('handles multiple sheets', async () => {
    const sharedStringsXml = `<sst>
      <si><t>Sheet1Data</t></si>
      <si><t>Sheet2Data</t></si>
    </sst>`;
    const sheet1Xml = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c></row>
    </sheetData></worksheet>`;
    const sheet2Xml = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>1</v></c></row>
    </sheetData></worksheet>`;

    const buffer = createZipBuffer({
      'xl/sharedStrings.xml': sharedStringsXml,
      'xl/worksheets/sheet1.xml': sheet1Xml,
      'xl/worksheets/sheet2.xml': sheet2Xml,
    });

    const result = await parseXlsxContent(buffer);
    expect(result.status).toBe('success');
    expect(result.content).toContain('Sheet1Data');
    expect(result.content).toContain('Sheet2Data');
    expect(result.content).toContain('--- Sheet 1 ---');
    expect(result.content).toContain('--- Sheet 2 ---');
  });

  it('returns error for invalid ZIP', async () => {
    const result = await parseXlsxContent(Buffer.from('not a zip'));
    expect(result.status).toBe('error');
  });

  it('handles XLSX with no shared strings file (numeric only)', async () => {
    const sheet1Xml = `<worksheet><sheetData>
      <row r="1"><c r="A1"><v>42</v></c><c r="B1"><v>3.14</v></c></row>
    </sheetData></worksheet>`;

    const buffer = createZipBuffer({
      'xl/worksheets/sheet1.xml': sheet1Xml,
    });

    const result = await parseXlsxContent(buffer);
    expect(result.status).toBe('success');
    expect(result.content).toContain('42\t3.14');
  });

  it('returns error for empty XLSX', async () => {
    const sheet1Xml = `<worksheet><sheetData></sheetData></worksheet>`;
    const buffer = createZipBuffer({
      'xl/worksheets/sheet1.xml': sheet1Xml,
    });

    const result = await parseXlsxContent(buffer);
    expect(result.status).toBe('error');
    expect(result.error).toContain('no extractable content');
  });
});

// ---------------------------------------------------------------------------
// parseDocxContent (full ZIP-based test)
// ---------------------------------------------------------------------------

describe('parseDocxContent', () => {
  it('extracts text from a minimal DOCX', async () => {
    // mammoth expects a valid DOCX structure with [Content_Types].xml,
    // word/document.xml, and _rels/.rels at minimum
    const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/word/document.xml"
          ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`;

    const rels = `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1"
          Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
          Target="word/document.xml"/>
      </Relationships>`;

    const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>Gold Peak 2026 Brand Brief</w:t></w:r></w:p>
          <w:p><w:r><w:t>Target audience: health-conscious tea drinkers aged 25-45</w:t></w:r></w:p>
        </w:body>
      </w:document>`;

    const buffer = createZipBuffer({
      '[Content_Types].xml': contentTypes,
      '_rels/.rels': rels,
      'word/document.xml': documentXml,
    });

    const result = await parseDocxContent(buffer);
    expect(result.status).toBe('success');
    expect(result.content).toContain('Gold Peak 2026 Brand Brief');
    expect(result.content).toContain('health-conscious tea drinkers');
  });

  it('returns error for invalid buffer', async () => {
    const result = await parseDocxContent(Buffer.from('not a docx'));
    expect(result.status).toBe('error');
  });
});
