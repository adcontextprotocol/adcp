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

export interface CertifierCredential {
  id: string;
  publicId: string;
  groupId: string;
  status: string;
  recipient: CertifierRecipient;
  issueDate: string;
  expiryDate: string | null;
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
