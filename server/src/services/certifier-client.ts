/**
 * Certifier API client for issuing digital credentials.
 *
 * API Docs: https://developers.certifier.io/reference
 */

import axios, { AxiosInstance } from 'axios';
import { createLogger } from '../logger.js';

const logger = createLogger('certifier');

const CERTIFIER_API_TOKEN = process.env.CERTIFIER_API_TOKEN;
const CERTIFIER_API_URL = 'https://api.certifier.io/v1';
const CERTIFIER_VERSION = '2022-10-26';

export interface CertifierRecipient {
  name: string;
  email: string;
}

/**
 * Build a Certifier recipient name from possibly-missing user fields.
 * Returns "first last" trimmed, or the email when neither name field is set.
 * Guards against the "undefined undefined" literal that plain interpolation
 * produces when first_name and last_name are null/undefined.
 */
export function buildRecipientName(user: {
  first_name?: string | null;
  last_name?: string | null;
  email: string;
}): string {
  const first = (user.first_name ?? '').trim();
  const last = (user.last_name ?? '').trim();
  const name = `${first} ${last}`.trim();
  return name || user.email;
}

export interface CertifierCredential {
  id: string;
  publicId: string;
  groupId: string;
  status: string;
  /**
   * Denormalized snapshot of the recipient resource at issuance time. The
   * recipient is a separate resource with its own ID (`recipient.id`).
   * **This snapshot is NOT what drives certificate rendering** — Certifier's
   * design template resolves `{recipient.name}` placeholders against the
   * `attributes` map below (an override layer), falling back to the
   * snapshot only when the attribute is absent. To update the rendered
   * name post-issuance, PATCH `/credentials/{id}` with
   * `{ recipient: { name, email } }` — Certifier writes the new value into
   * `attributes['recipient.name']`. The snapshot field stays stale; the
   * cert re-renders from the attribute override.
   */
  recipient: CertifierRecipient;
  issueDate: string;
  expiryDate: string | null;
  /**
   * Render-time override map. Keys are dotted paths matching design-template
   * placeholders (e.g., `recipient.name`); values override the corresponding
   * resource snapshot at render time. Populated by PATCH /credentials/{id}
   * post-issuance — that's how the recipient-name repair workflow lands a
   * corrected name on already-issued certs.
   */
  attributes?: Record<string, string>;
  customAttributes: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface IssueCredentialOptions {
  groupId: string;
  recipient: CertifierRecipient;
  issueDate?: string;
  expiryDate?: string;
  customAttributes?: Record<string, string>;
}

function getClient(): AxiosInstance {
  if (!CERTIFIER_API_TOKEN) {
    throw new Error('CERTIFIER_API_TOKEN is not configured');
  }
  return axios.create({
    baseURL: CERTIFIER_API_URL,
    headers: {
      'Authorization': `Bearer ${CERTIFIER_API_TOKEN}`,
      'Certifier-Version': CERTIFIER_VERSION,
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Create, issue, and send a credential in one call.
 */
export async function issueCredential(options: IssueCredentialOptions): Promise<CertifierCredential> {
  const client = getClient();
  const body: Record<string, unknown> = {
    groupId: options.groupId,
    recipient: options.recipient,
  };
  if (options.issueDate) body.issueDate = options.issueDate;
  if (options.expiryDate) body.expiryDate = options.expiryDate;
  if (options.customAttributes) body.customAttributes = options.customAttributes;

  logger.info({ groupId: options.groupId, recipientEmail: options.recipient.email }, 'Issuing credential');

  const response = await client.post<CertifierCredential>('/credentials/create-issue-send', body);
  logger.info({ credentialId: response.data.id, publicId: response.data.publicId }, 'Credential issued');
  return response.data;
}

/**
 * Get a credential by ID.
 */
export async function getCredential(credentialId: string): Promise<CertifierCredential> {
  const client = getClient();
  const response = await client.get<CertifierCredential>(`/credentials/${credentialId}`);
  return response.data;
}

export interface UpdateCredentialOptions {
  recipient?: CertifierRecipient;
  customAttributes?: Record<string, string>;
}

/**
 * Update a previously-issued credential — typically used to correct the
 * recipient name on a credential that was issued before the user's profile
 * populated (see escalation #382). PATCHing `recipient: { name, email }`
 * does NOT mutate the recipient resource snapshot on the credential;
 * Certifier instead writes the new value into the credential's `attributes`
 * map (e.g., `attributes['recipient.name']`). That override is what the
 * design template reads at render time, so the corrected name appears on
 * the cert even though the snapshot field stays stale. Verification of a
 * successful repair MUST read `attributes['recipient.name']`, not
 * `recipient.name`.
 */
export async function updateCredential(
  credentialId: string,
  options: UpdateCredentialOptions,
): Promise<CertifierCredential> {
  const client = getClient();
  const body: Record<string, unknown> = {};
  if (options.recipient) body.recipient = options.recipient;
  if (options.customAttributes) body.customAttributes = options.customAttributes;

  logger.info({ credentialId, recipientEmail: options.recipient?.email }, 'Updating credential');
  const response = await client.patch<CertifierCredential>(`/credentials/${credentialId}`, body);
  logger.info({ credentialId: response.data.id }, 'Credential updated');
  return response.data;
}

export interface CertifierDesignPreview {
  format: string;
  url: string;
}

export interface CertifierDesign {
  id: string;
  name: string;
  previews: CertifierDesignPreview[];
}

/**
 * Get credential designs (certificate and badge images).
 */
export async function getCredentialDesigns(credentialId: string): Promise<CertifierDesign[]> {
  const client = getClient();
  const response = await client.get<CertifierDesign[]>(`/credentials/${credentialId}/designs`);
  return response.data;
}

/**
 * Get the badge image PNG URL for a credential.
 * Looks for a design with "badge" in its name, falls back to the first design.
 */
export async function getCredentialBadgeUrl(credentialId: string): Promise<string | null> {
  const designs = await getCredentialDesigns(credentialId);
  if (!designs.length) return null;

  const badge = designs.find(d => d.name.toLowerCase().includes('badge')) || designs[0];
  const png = badge.previews.find(p => p.format === 'png');
  return png?.url || null;
}

/**
 * Check whether Certifier integration is configured.
 */
export function isCertifierConfigured(): boolean {
  return !!CERTIFIER_API_TOKEN;
}
