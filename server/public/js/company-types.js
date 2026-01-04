/**
 * Centralized company type definitions for frontend use
 *
 * IMPORTANT: Keep in sync with server/src/config/company-types.ts
 * When adding/changing types, update both files.
 */

window.COMPANY_TYPES = {
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
    description: 'Other industry participants',
  },
};

window.COMPANY_TYPE_VALUES = Object.keys(window.COMPANY_TYPES);

window.getCompanyTypeLabel = function(value) {
  const type = window.COMPANY_TYPES[value];
  return type?.label || value;
};

window.formatCompanyTypes = function(types) {
  if (!types || types.length === 0) return '-';
  return types.map(t => window.getCompanyTypeLabel(t)).join(', ');
};
