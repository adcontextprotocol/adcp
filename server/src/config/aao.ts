export const AAO_HOST = 'agenticadvertising.org';

export function aaoHostedBrandJsonUrl(domain: string): string {
  return `https://${AAO_HOST}/brands/${domain}/brand.json`;
}

export function aaoHostedAdagentsJsonUrl(domain: string): string {
  return `https://${AAO_HOST}/publisher/${domain}/.well-known/adagents.json`;
}

export function expectedAdagentsJsonUrl(domain: string): string {
  return `https://${domain}/.well-known/adagents.json`;
}
