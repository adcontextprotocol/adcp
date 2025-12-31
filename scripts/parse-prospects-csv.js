#!/usr/bin/env node

/**
 * Parse prospects CSV from Google Sheets and convert to bulk import JSON format
 *
 * Usage: node scripts/parse-prospects-csv.js [input.csv] [output.json]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Map CSV Category values to database company_type values
const CATEGORY_MAP = {
  'Ad Tech': 'adtech',
  'Agency': 'agency',
  'Brand': 'brand',
  'Publisher': 'publisher',
  'Consulting': 'other',
};

// Parse "Who Owns Outreach" to extract the primary owner
function parseOwner(ownerField) {
  if (!ownerField) return null;

  // Strip parenthetical notes like "(Brian)" -> "Brian"
  const stripped = ownerField.replace(/[()]/g, '').trim();

  // Common patterns: "Randy", "Brian", "Matt", "Randy (Brian)", "Brian (Randy)"
  // Take the first name found
  const owners = ['Brian', 'Randy', 'Matt'];
  for (const owner of owners) {
    if (stripped.toLowerCase().includes(owner.toLowerCase())) {
      return owner;
    }
  }

  // Return first non-empty word if nothing matches
  const firstWord = stripped.split(/\s+/)[0];
  return firstWord || null;
}

// Parse the CSV content
function parseCSV(content) {
  const lines = content.split('\n');
  const prospects = [];

  // Skip header rows (first 2 lines based on the file structure)
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Parse CSV line (handling quoted fields with commas)
    const fields = parseCSVLine(line);

    // Extract relevant columns based on CSV structure:
    // Column 0: Company name
    // Column 1-3: Advisory Council, Steerco Priorities, Steerco Backlog (Yes/No)
    // Column 4: Seed Money Status
    // Column 5: Who Owns Outreach
    // Column 6-7: Interview Intro/Status
    // Column 8: Steerco - names
    // Column 9: Event - names
    // Column 10-12: Founders, Zoom Match, Other Boards
    // Column 13: Category
    // Column 14: Source List
    // Column 15: Description
    // Column 16: Executive Roster/AI Champions

    const company = fields[0]?.trim();
    const category = fields[13]?.trim();
    const ownerField = fields[5]?.trim();
    const steercoNames = fields[8]?.trim();
    const eventNames = fields[9]?.trim();
    const description = fields[15]?.trim();
    const executives = fields[16]?.trim();

    // Skip empty rows or header-like rows
    if (!company || company === 'Company' || company.toLowerCase() === 'count') {
      continue;
    }

    // Skip rows that are clearly notes/section headers
    if (company.includes('Note:') || company.includes('duplicates') ||
        company.includes('recommendation') || company.includes('attendees') ||
        company.startsWith('Other ')) {
      continue;
    }

    // Skip rows that are just "Yes" (from malformed parsing)
    if (company === 'Yes' || company === 'No') {
      continue;
    }

    // Skip rows that appear to be continuation lines from multi-line notes
    // These typically start with numbers (1., 2.), bullets (•, -), or are fragments
    if (/^\d+\.?\s/.test(company) || // Starts with "1." or "1 "
        /^•/.test(company) ||        // Starts with bullet
        /^-\s/.test(company) ||      // Starts with dash
        /^The "/.test(company) ||    // Starts with "The ""
        /^[a-z]/.test(company) && !(/^[a-z][A-Za-z]+$/.test(company)) || // Starts with lowercase (continuation) but allow single camelCase words
        company.length < 3 ||        // Too short to be a company name
        company.includes('CEO') ||   // Person name with title
        company.includes('CTO') ||   // Person name with title
        company.includes('Chairman') || // Person name with title
        company.includes('President') || // Person name with title
        company.includes('Officer') ||   // Person name with title
        company.includes('EVP') ||   // Executive title
        company.includes('SVP') ||   // Executive title
        company.includes('Founder')) {// Person name with title
      continue;
    }

    // Skip section headers and notes in the spreadsheet
    if (company.startsWith('Randall ') ||
        company.startsWith('Christina ') ||
        company.startsWith('Brian ') ||
        company.startsWith('CF.') ||
        company.startsWith('Key people') ||
        company.startsWith('Owns ') ||
        company.startsWith('A few ') ||
        company.includes(' adds') ||
        company.includes(' list') ||
        company.includes('Venkatesan') ||
        company.includes('Reinhard') ||
        company.includes('track down')) {
      continue;
    }

    // Map category to company_type
    const companyType = CATEGORY_MAP[category] || null;

    // Parse owner
    const owner = parseOwner(ownerField);

    // Use Steerco names as primary contact, fall back to Event names
    const contactName = steercoNames || eventNames || null;

    // Build notes from description and executives
    let notes = '';
    if (description) {
      notes += description;
    }
    if (executives) {
      if (notes) notes += '\n\n';
      notes += 'Key contacts: ' + executives;
    }

    prospects.push({
      name: company,
      company_type: companyType,
      prospect_owner: owner,
      prospect_contact_name: contactName,
      prospect_notes: notes || null,
      prospect_source: 'aao_launch_list',
    });
  }

  return prospects;
}

// Parse a single CSV line handling quoted fields
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);

  return fields;
}

// Main execution
const inputFile = process.argv[2] || path.join(__dirname, '../.context/attachments/AdCP target names - Top Targets - AI Centricity.csv');
const outputFile = process.argv[3] || path.join(__dirname, '../.context/prospects-import.json');

console.log(`Reading CSV from: ${inputFile}`);
const csvContent = fs.readFileSync(inputFile, 'utf-8');

const prospects = parseCSV(csvContent);

console.log(`Parsed ${prospects.length} prospects`);

// Filter out duplicates by company name (case-insensitive)
const seen = new Set();
const uniqueProspects = prospects.filter(p => {
  const key = p.name.toLowerCase();
  if (seen.has(key)) {
    console.log(`  Duplicate: ${p.name}`);
    return false;
  }
  seen.add(key);
  return true;
});

console.log(`After deduplication: ${uniqueProspects.length} unique prospects`);

// Write JSON output
const output = {
  prospects: uniqueProspects,
  metadata: {
    generated_at: new Date().toISOString(),
    source_file: path.basename(inputFile),
    total_count: uniqueProspects.length,
  }
};

fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
console.log(`JSON output written to: ${outputFile}`);

// Also write CSV output for admin UI
const csvOutputFile = outputFile.replace('.json', '.csv');
const csvHeaders = ['Company', 'Category', 'Who Owns Outreach', 'Steerco - names', 'Description'];
const csvRows = uniqueProspects.map(p => {
  // Map company_type back to display names
  const categoryDisplay = {
    'adtech': 'Ad Tech',
    'agency': 'Agency',
    'brand': 'Brand',
    'publisher': 'Publisher',
    'other': 'Other'
  }[p.company_type] || '';

  // Escape CSV fields (wrap in quotes if contains comma, quote, or newline)
  const escape = (val) => {
    if (!val) return '';
    val = String(val);
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
  };

  return [
    escape(p.name),
    escape(categoryDisplay),
    escape(p.prospect_owner || ''),
    escape(p.prospect_contact_name || ''),
    escape(p.prospect_notes || '')
  ].join(',');
});

const csvOutput = [csvHeaders.join(','), ...csvRows].join('\n');
fs.writeFileSync(csvOutputFile, csvOutput);
console.log(`CSV output written to: ${csvOutputFile}`);

// Print summary by category
const byCategory = {};
for (const p of uniqueProspects) {
  const cat = p.company_type || 'unknown';
  byCategory[cat] = (byCategory[cat] || 0) + 1;
}
console.log('\nBy category:');
for (const [cat, count] of Object.entries(byCategory)) {
  console.log(`  ${cat}: ${count}`);
}

// Print summary by owner
const byOwner = {};
for (const p of uniqueProspects) {
  const owner = p.prospect_owner || 'unassigned';
  byOwner[owner] = (byOwner[owner] || 0) + 1;
}
console.log('\nBy owner:');
for (const [owner, count] of Object.entries(byOwner)) {
  console.log(`  ${owner}: ${count}`);
}
