/**
 * Centralized company type definitions
 * All company type values and labels should be imported from here
 */

export const COMPANY_TYPES = {
  adtech: {
    value: 'adtech',
    label: 'Ad Tech',
    description: 'DSPs, SSPs, ad servers, programmatic platforms',
  },
  agency: {
    value: 'agency',
    label: 'Agency',
    description: 'Media agencies, creative agencies, performance marketing',
  },
  brand: {
    value: 'brand',
    label: 'Brand',
    description: 'Advertisers and marketers who buy advertising',
  },
  publisher: {
    value: 'publisher',
    label: 'Publisher',
    description: 'Media owners who sell advertising inventory',
  },
  data: {
    value: 'data',
    label: 'Data & Measurement',
    description: 'Clean rooms, CDPs, identity, measurement, analytics',
  },
  ai: {
    value: 'ai',
    label: 'AI & Tech Platforms',
    description: 'LLM providers, agent builders, cloud AI, ML platforms',
  },
  other: {
    value: 'other',
    label: 'Other',
    description: 'Commerce media, retail media, consulting, CTV/streaming platforms, and other digital advertising ecosystem participants',
  },
} as const;

export type CompanyTypeValue = keyof typeof COMPANY_TYPES;

export const COMPANY_TYPE_VALUES = Object.keys(COMPANY_TYPES) as CompanyTypeValue[];

export function getCompanyTypeLabel(value: string): string {
  const type = COMPANY_TYPES[value as CompanyTypeValue];
  return type?.label || value;
}

export function getCompanyTypeDescription(value: string): string {
  const type = COMPANY_TYPES[value as CompanyTypeValue];
  return type?.description || '';
}

export function formatCompanyTypes(types: string[] | null | undefined): string {
  if (!types || types.length === 0) return '-';
  return types.map(t => getCompanyTypeLabel(t)).join(', ');
}

/**
 * Generate markdown documentation for company types (for AI prompts)
 */
export function getCompanyTypesDocumentation(): string {
  const lines = Object.entries(COMPANY_TYPES).map(([key, config]) => {
    return `- **${key}**: ${config.label} (${config.description})`;
  });
  return lines.join('\n');
}
