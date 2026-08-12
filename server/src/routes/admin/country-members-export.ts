export interface CountryMemberExportRow {
  workos_user_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  city: string | null;
  country: string;
  location_source: string | null;
  registered_at: Date | string;
  organization_names: string[];
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  // Country exports are commonly opened in spreadsheet applications. Prevent
  // user-controlled names and organization values from becoming formulas.
  const spreadsheetSafe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${spreadsheetSafe.replace(/"/g, '""')}"`;
}

export function buildCountryMembersCsv(rows: CountryMemberExportRow[]): string {
  const header = [
    'Name',
    'Email',
    'City',
    'Country',
    'Location Source',
    'Account Registered At',
    'Organizations',
  ];
  const lines = rows.map((row) => {
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ');
    const registeredAt = new Date(row.registered_at).toISOString();
    return [
      name,
      row.email,
      row.city,
      row.country,
      row.location_source,
      registeredAt,
      row.organization_names.join('; '),
    ].map(csvCell).join(',');
  });
  return [header.map(csvCell).join(','), ...lines].join('\n');
}
