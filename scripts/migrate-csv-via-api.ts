#!/usr/bin/env npx tsx
/**
 * CSV Migration via Admin API
 *
 * This script imports prospect data from a CSV file by calling the admin API.
 * This ensures all prospects get real WorkOS organization IDs and proper enrichment.
 *
 * Usage:
 *   npx tsx scripts/migrate-csv-via-api.ts --file <path-to-csv> --api-url <url> --cookie <session-cookie> [--dry-run]
 *
 * For local testing:
 *   npx tsx scripts/migrate-csv-via-api.ts --file prospects.csv --api-url http://localhost:3000 --cookie "wos-session=xxx"
 *
 * Options:
 *   --file      Path to the CSV file (columns: name, company_type, domain, contact_name, contact_email, notes, source)
 *   --api-url   Base URL of the API (e.g., http://localhost:3000 or https://your-app.fly.dev)
 *   --cookie    Session cookie for authentication (must be admin)
 *   --dry-run   Show what would be imported without actually importing
 */

import * as fs from 'fs';

// Category to company_type mapping (for legacy Google Sheet format)
const CATEGORY_TO_TYPE: Record<string, string> = {
  'Ad Tech': 'adtech',
  'Agency': 'agency',
  'Brand': 'brand',
  'Publisher': 'publisher',
  'Consulting': 'other',
  adtech: 'adtech',
  agency: 'agency',
  brand: 'brand',
  publisher: 'publisher',
  other: 'other',
};

interface ParsedRow {
  name: string;
  company_type?: string;
  domain?: string;
  contact_name?: string;
  contact_email?: string;
  notes?: string;
  source?: string;
}

interface ImportResult {
  name: string;
  status: 'created' | 'exists' | 'error';
  orgId?: string;
  error?: string;
}

/**
 * Parse CSV with proper handling of quoted fields
 */
function parseCSV(content: string): string[][] {
  const rows: string[][] = [];
  const lines = content.split('\n');

  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        currentRow.push(currentCell.trim());
        currentCell = '';
      } else {
        currentCell += char;
      }
    }

    if (inQuotes) {
      currentCell += '\n';
      lineIndex++;
    } else {
      currentRow.push(currentCell.trim());
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
      lineIndex++;
    }
  }

  if (currentRow.length > 0 || currentCell.trim()) {
    currentRow.push(currentCell.trim());
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Parse CSV file into structured data
 */
function parseFile(filePath: string): ParsedRow[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const rows = parseCSV(content);

  if (rows.length < 2) {
    throw new Error('File must have at least a header row and one data row');
  }

  // First row is header
  const headerRow = rows[0];
  const colMap: Record<string, number> = {};
  headerRow.forEach((h, i) => {
    colMap[h.toLowerCase().replace(/\s+/g, '_')] = i;
  });

  console.log('Found columns:', Object.keys(colMap));

  // Required column: name or company
  const nameCol = colMap['name'] ?? colMap['company'];
  if (nameCol === undefined) {
    throw new Error('Could not find "name" or "company" column');
  }

  // Optional columns
  const typeCol = colMap['company_type'] ?? colMap['category'] ?? colMap['type'];
  const domainCol = colMap['domain'] ?? colMap['email_domain'];
  const contactNameCol = colMap['contact_name'] ?? colMap['contact'];
  const contactEmailCol = colMap['contact_email'] ?? colMap['email'];
  const notesCol = colMap['notes'] ?? colMap['description'];
  const sourceCol = colMap['source'] ?? colMap['source_list'];

  const results: ParsedRow[] = [];
  const seenNames = new Set<string>();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = row[nameCol]?.trim();

    if (!name || name.length < 2) continue;

    // Skip duplicates
    const normalizedName = name.toLowerCase();
    if (seenNames.has(normalizedName)) continue;
    seenNames.add(normalizedName);

    const categoryValue = typeCol !== undefined ? row[typeCol]?.trim() : undefined;
    const companyType = categoryValue ? CATEGORY_TO_TYPE[categoryValue] || 'other' : undefined;

    results.push({
      name,
      company_type: companyType,
      domain: domainCol !== undefined ? row[domainCol]?.trim() || undefined : undefined,
      contact_name: contactNameCol !== undefined ? row[contactNameCol]?.trim() || undefined : undefined,
      contact_email: contactEmailCol !== undefined ? row[contactEmailCol]?.trim() || undefined : undefined,
      notes: notesCol !== undefined ? row[notesCol]?.trim() || undefined : undefined,
      source: sourceCol !== undefined ? row[sourceCol]?.trim() || 'csv_import' : 'csv_import',
    });
  }

  return results;
}

/**
 * Create a prospect via the admin API
 */
async function createProspectViaAPI(
  apiUrl: string,
  cookie: string,
  prospect: ParsedRow
): Promise<{ success: boolean; orgId?: string; alreadyExists?: boolean; error?: string }> {
  const response = await fetch(`${apiUrl}/api/admin/prospects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({
      name: prospect.name,
      company_type: prospect.company_type,
      domain: prospect.domain,
      prospect_contact_name: prospect.contact_name,
      prospect_contact_email: prospect.contact_email,
      prospect_notes: prospect.notes,
      prospect_source: prospect.source,
    }),
  });

  if (response.status === 409) {
    const data = await response.json();
    return { success: false, alreadyExists: true, orgId: data.organization?.workos_organization_id };
  }

  if (!response.ok) {
    const text = await response.text();
    return { success: false, error: `HTTP ${response.status}: ${text}` };
  }

  const data = await response.json();
  return { success: true, orgId: data.organization?.workos_organization_id };
}

/**
 * Main migration function
 */
async function migrate(options: {
  file: string;
  apiUrl: string;
  cookie: string;
  dryRun: boolean;
}): Promise<void> {
  console.log('='.repeat(60));
  console.log('CSV Migration via Admin API');
  console.log('='.repeat(60));
  console.log(`File: ${options.file}`);
  console.log(`API URL: ${options.apiUrl}`);
  console.log(`Dry run: ${options.dryRun}`);
  console.log('');

  // Parse the file
  console.log('Parsing CSV file...');
  const prospects = parseFile(options.file);
  console.log(`Found ${prospects.length} unique companies`);

  // Show breakdown by type
  const byType: Record<string, number> = {};
  prospects.forEach((p) => {
    const type = p.company_type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
  });
  console.log('\nBy company type:');
  Object.entries(byType).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
  });

  if (options.dryRun) {
    console.log('\n--- DRY RUN MODE ---');
    console.log('No changes will be made.\n');
    console.log('Sample prospects to import:');
    prospects.slice(0, 10).forEach((p) => {
      console.log(`  - ${p.name} (${p.company_type || 'unknown'})`);
      if (p.domain) console.log(`    Domain: ${p.domain}`);
      if (p.contact_name) console.log(`    Contact: ${p.contact_name}`);
    });
    return;
  }

  // Verify API access
  console.log('\nVerifying API access...');
  const testResponse = await fetch(`${options.apiUrl}/api/admin/prospects?limit=1`, {
    headers: { Cookie: options.cookie },
  });
  if (!testResponse.ok) {
    throw new Error(
      `API access failed: ${testResponse.status} ${testResponse.statusText}. Make sure you have admin access and the cookie is valid.`
    );
  }
  console.log('API access verified.\n');

  // Import prospects
  const results: ImportResult[] = [];
  let processed = 0;

  for (const prospect of prospects) {
    processed++;
    process.stdout.write(`\rProcessing ${processed}/${prospects.length}: ${prospect.name.substring(0, 30)}...`);

    try {
      const result = await createProspectViaAPI(options.apiUrl, options.cookie, prospect);

      if (result.success) {
        results.push({ name: prospect.name, status: 'created', orgId: result.orgId });
      } else if (result.alreadyExists) {
        results.push({ name: prospect.name, status: 'exists', orgId: result.orgId });
      } else {
        results.push({ name: prospect.name, status: 'error', error: result.error });
      }

      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      results.push({
        name: prospect.name,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  console.log('\n\n' + '='.repeat(60));
  console.log('MIGRATION COMPLETE');
  console.log('='.repeat(60));

  const created = results.filter((r) => r.status === 'created').length;
  const exists = results.filter((r) => r.status === 'exists').length;
  const errors = results.filter((r) => r.status === 'error').length;

  console.log(`Created: ${created}`);
  console.log(`Already exists: ${exists}`);
  console.log(`Errors: ${errors}`);

  if (errors > 0) {
    console.log('\nErrors:');
    results
      .filter((r) => r.status === 'error')
      .slice(0, 20)
      .forEach((r) => {
        console.log(`  - ${r.name}: ${r.error}`);
      });
    if (errors > 20) {
      console.log(`  ... and ${errors - 20} more errors`);
    }
  }
}

// Parse command line arguments
function parseArgs(): { file: string; apiUrl: string; cookie: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  const options = {
    file: '',
    apiUrl: '',
    cookie: '',
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      options.file = args[i + 1];
      i++;
    } else if (args[i] === '--api-url' && args[i + 1]) {
      options.apiUrl = args[i + 1];
      i++;
    } else if (args[i] === '--cookie' && args[i + 1]) {
      options.cookie = args[i + 1];
      i++;
    } else if (args[i] === '--dry-run') {
      options.dryRun = true;
    }
  }

  if (!options.file) {
    console.error('Usage: npx tsx scripts/migrate-csv-via-api.ts --file <path-to-csv> --api-url <url> --cookie <session-cookie> [--dry-run]');
    console.error('\nExample:');
    console.error('  npx tsx scripts/migrate-csv-via-api.ts --file prospects.csv --api-url http://localhost:3000 --cookie "wos-session=xxx" --dry-run');
    process.exit(1);
  }

  if (!options.apiUrl && !options.dryRun) {
    console.error('Error: --api-url is required (unless using --dry-run)');
    process.exit(1);
  }

  if (!options.cookie && !options.dryRun) {
    console.error('Error: --cookie is required (unless using --dry-run)');
    process.exit(1);
  }

  if (!fs.existsSync(options.file)) {
    console.error(`File not found: ${options.file}`);
    process.exit(1);
  }

  return options;
}

// Run
const options = parseArgs();
migrate(options).catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
