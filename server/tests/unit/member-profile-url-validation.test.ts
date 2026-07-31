import { describe, expect, it } from 'vitest';
import {
  MEMBER_PROFILE_URL_FIELDS,
  validateMemberProfileUrlFields,
} from '../../src/utils/member-profile-url.js';

describe('member profile URL validation', () => {
  it.each([
    ['linkedin_url', 'javascript:alert(1)'],
    ['linkedin_url', 'https://user:secret@linkedin.example/company/acme'],
    ['linkedin_url', 'https://linkedin.example" onmouseover="alert(1)'],
    ['twitter_url', 'javascript:alert(1)'],
    ['twitter_url', 'http://social.example/acme'],
    ['twitter_url', 'https://user:secret@social.example/acme'],
    ['contact_website', 'data:text/html,<script>alert(1)</script>'],
    ['contact_website', 'http://acme.example'],
    ['contact_website', 'https://acme.example" onclick="alert(1)'],
  ])('rejects an unsafe %s value', (field, value) => {
    expect(validateMemberProfileUrlFields({ [field]: value })).toBe(field);
  });

  it.each(MEMBER_PROFILE_URL_FIELDS)('rejects raw control characters in %s before URL parsing', (field) => {
    for (const control of ['\r', '\n', '\t', '\u007F']) {
      expect(validateMemberProfileUrlFields({
        [field]: `https://social.example/acme${control}profile`,
      })).toBe(field);
    }
  });

  it.each(MEMBER_PROFILE_URL_FIELDS)('rejects raw ambiguous URL delimiters in %s', (field) => {
    for (const delimiter of ['<', '>', '\\']) {
      expect(validateMemberProfileUrlFields({
        [field]: `https://social.example/acme${delimiter}profile`,
      })).toBe(field);
    }
  });

  it.each([
    ['linkedin_url', 'https://social.example/acme%0Dprofile'],
    ['twitter_url', 'https://social.example/acme%0Aprofile'],
    ['contact_website', 'https://acme.example/profile%09details'],
  ])('accepts encoded URL data in %s', (field, value) => {
    expect(validateMemberProfileUrlFields({ [field]: value })).toBeNull();
  });

  it('accepts valid HTTPS URLs for every profile URL field', () => {
    expect(validateMemberProfileUrlFields({
      linkedin_url: 'https://www.linkedin.com/company/acme-media',
      twitter_url: 'https://social.example/acme?ref=directory#profile',
      contact_website: 'https://acme.example/contact?from=directory#team',
    })).toBeNull();
  });

  it('allows omitted and cleared optional fields', () => {
    expect(validateMemberProfileUrlFields({})).toBeNull();
    expect(validateMemberProfileUrlFields({
      linkedin_url: null,
      twitter_url: '',
      contact_website: '',
    })).toBeNull();
  });
});
