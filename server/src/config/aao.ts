export const AAO_HOST = 'agenticadvertising.org';

export function aaoHostedBrandJsonUrl(domain: string): string {
  return `https://${AAO_HOST}/brands/${domain}/brand.json`;
}
