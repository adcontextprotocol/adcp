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

/**
 * Check whether Certifier integration is configured.
 */
export function isCertifierConfigured(): boolean {
  return !!CERTIFIER_API_TOKEN;
}
