import { safeFetchAxiosLike } from '../utils/url-security.js';
import { AAO_UA_VALIDATOR } from '../config/user-agents.js';
import { supplyPathAdsTxtPolicy, parseInventoryPartnerDomains, type SupplyPathInput } from './supply-path-verifier.js';

/** Bounded IAB evidence from the applicable host surfaces; redirect delegation is not accepted here. */
export async function fetchHostInventoryPartnerDomains(input: SupplyPathInput): Promise<NonNullable<SupplyPathInput['hostInventoryPartnerDomainsByFile']>> {
  const policy = supplyPathAdsTxtPolicy(input);
  const contents = await Promise.all(policy.files.map(async file => {
    try {
      const response = await safeFetchAxiosLike(`https://${input.hostDomain}/${file}`, {
        timeoutMs: 5000,
        maxResponseBytes: 256 * 1024,
        maxRedirects: 0,
        headers: { Accept: "text/plain", "User-Agent": AAO_UA_VALIDATOR },
      });
      if (response.status === 404) return "";
      const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      return response.status === 200 && contentType === 'text/plain' ? response.data.toString("utf-8") : null;
    } catch { return null; }
  }));
  return Object.fromEntries(policy.files.map((file, index) => [file, contents[index] === null ? null : parseInventoryPartnerDomains(contents[index]!)]));
}
