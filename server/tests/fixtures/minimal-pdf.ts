// Builds a small, valid one-page PDF: a line of text and, optionally, one
// solid-color RGB image. The cross-reference table is computed from real byte
// offsets, so strict parsers accept the file. Extends the zero-page fixture in
// tests/integration/perspective-assets.test.ts with content a parser can
// actually extract.

export interface MinimalPdfOptions {
  /** Text drawn on the page (ASCII; parentheses and backslashes are escaped). */
  text: string;
  /** Optional solid-color image painted on the page as an XObject. */
  image?: { width: number; height: number; rgb?: [number, number, number] };
}

export function buildMinimalPdf({ text, image }: MinimalPdfOptions): Buffer {
  const escaped = text.replace(/[\\()]/g, (c) => `\\${c}`);
  const drawImage = image ? `q ${image.width} 0 0 ${image.height} 72 500 cm /Im1 Do Q\n` : '';
  const content = Buffer.from(`${drawImage}BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET\n`, 'latin1');

  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R '
        + `/Resources << /Font << /F1 5 0 R >>${image ? ' /XObject << /Im1 6 0 R >>' : ''} >> >>`,
      'latin1',
    ),
    stream(`<< /Length ${content.length} >>`, content),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'latin1'),
  ];
  if (image) {
    const [r, g, b] = image.rgb ?? [26, 77, 143];
    const pixels = Buffer.alloc(image.width * image.height * 3);
    for (let i = 0; i < pixels.length; i += 3) {
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
    }
    objects.push(stream(
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} `
        + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>`,
      pixels,
    ));
  }

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0].length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    const obj = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    offsets.push(offset);
    parts.push(obj);
    offset += obj.length;
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(offset),
    '%%EOF',
  ].join('\n');
  parts.push(Buffer.from(`${xref}\n`, 'latin1'));
  return Buffer.concat(parts);
}

function stream(dictionary: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${dictionary}\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}
