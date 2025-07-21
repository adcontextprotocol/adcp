import { parse } from 'csv-parse/sync';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function loadAudiences() {
  const csvContent = await fs.readFile(
    path.join(__dirname, '../data/audiences.csv'),
    'utf-8'
  );
  
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });
  
  return records;
}

export async function loadCatalogs() {
  const csvContent = await fs.readFile(
    path.join(__dirname, '../data/catalogs.csv'),
    'utf-8'
  );
  
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    cast: (value, context) => {
      if (context.column === 'cpm' || context.column === 'pct_of_media') {
        return parseFloat(value);
      }
      return value;
    }
  });
  
  return records;
}