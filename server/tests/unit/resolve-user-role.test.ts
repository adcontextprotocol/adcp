import { describe, it, expect } from 'vitest';
import { resolveUserRole } from '../../src/utils/resolve-user-role.js';

describe('resolveUserRole', () => {
  it('returns owner for a single active owner membership', () => {
    expect(resolveUserRole([
      { status: 'active', role: { slug: 'owner' } },
    ])).toBe('owner');
  });

  it('returns admin for a single active admin membership', () => {
    expect(resolveUserRole([
      { status: 'active', role: { slug: 'admin' } },
    ])).toBe('admin');
  });

  it('returns member for a single active member membership', () => {
    expect(resolveUserRole([
      { status: 'active', role: { slug: 'member' } },
    ])).toBe('member');
  });

  it('returns null when no memberships exist', () => {
    expect(resolveUserRole([])).toBeNull();
  });

  it('returns null when all memberships are inactive or pending', () => {
    expect(resolveUserRole([
      { status: 'pending', role: { slug: 'owner' } },
      { status: 'inactive', role: { slug: 'admin' } },
    ])).toBeNull();
  });

  it('picks the highest-privilege active role when multiple memberships exist', () => {
    expect(resolveUserRole([
      { status: 'active', role: { slug: 'member' } },
      { status: 'active', role: { slug: 'owner' } },
    ])).toBe('owner');
  });

  it('ignores non-active memberships even if they have higher roles', () => {
    expect(resolveUserRole([
      { status: 'pending', role: { slug: 'owner' } },
      { status: 'active', role: { slug: 'member' } },
    ])).toBe('member');
  });

  it('defaults to member when role object is missing on an active membership', () => {
    expect(resolveUserRole([
      { status: 'active' } as any,
    ])).toBe('member');
  });

  it('defaults to member when role.slug is undefined on an active membership', () => {
    expect(resolveUserRole([
      { status: 'active', role: { slug: undefined } } as any,
    ])).toBe('member');
  });

  it('prefers active owner over active admin and member', () => {
    expect(resolveUserRole([
      { status: 'active', role: { slug: 'admin' } },
      { status: 'active', role: { slug: 'member' } },
      { status: 'active', role: { slug: 'owner' } },
    ])).toBe('owner');
  });

  it('skips unknown role slugs without escalating', () => {
    expect(resolveUserRole([
      { status: 'active', role: { slug: 'billing' } },
      { status: 'active', role: { slug: 'member' } },
    ])).toBe('member');
  });

  it('returns null when only unknown role slugs are active', () => {
    expect(resolveUserRole([
      { status: 'active', role: { slug: 'billing' } },
    ])).toBeNull();
  });
});
