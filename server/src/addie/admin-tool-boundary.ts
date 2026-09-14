/**
 * Platform-wide escalation tools are reserved to authenticated
 * AgenticAdvertising.org platform administrators. Keeping these names in an
 * application-owned boundary lets private surfaces reject explicit requests
 * before routing without adding either definition to an unauthorized catalog.
 */
export const RESERVED_PLATFORM_ADMIN_TOOL_NAMES = Object.freeze([
  'list_escalations',
  'resolve_escalation',
] as const);

const SENSITIVE_PLATFORM_ADMIN_READ_TOOL_NAMES = new Set<string>([
  'list_escalations',
]);

export const PLATFORM_ADMIN_TOOL_PERMISSION_DENIED_MESSAGE =
  'Permission denied: platform-wide escalation listing and resolution require AgenticAdvertising.org platform administrator access. Organization ownership does not grant access.';

export class PlatformAdminToolPermissionDeniedError extends Error {
  readonly code = 'platform_admin_permission_denied';
  readonly statusCode = 403;

  constructor() {
    super(PLATFORM_ADMIN_TOOL_PERMISSION_DENIED_MESSAGE);
    this.name = 'PlatformAdminToolPermissionDeniedError';
  }
}

export function isSensitivePlatformAdminReadTool(toolName: string): boolean {
  return SENSITIVE_PLATFORM_ADMIN_READ_TOOL_NAMES.has(toolName);
}

/** Exact reserved names only; descriptive escalation questions remain routable. */
export function explicitlyRequestsReservedPlatformAdminTool(message: string): boolean {
  const normalized = message.toLowerCase();
  return RESERVED_PLATFORM_ADMIN_TOOL_NAMES.some((name) => {
    let index = normalized.indexOf(name);
    while (index !== -1) {
      const before = index === 0 ? '' : normalized[index - 1];
      const afterIndex = index + name.length;
      const after = afterIndex === normalized.length ? '' : normalized[afterIndex];
      const isIdentifierCharacter = (value: string) => (
        (value >= 'a' && value <= 'z')
        || (value >= '0' && value <= '9')
        || value === '_'
      );
      if (!isIdentifierCharacter(before) && !isIdentifierCharacter(after)) return true;
      index = normalized.indexOf(name, index + name.length);
    }
    return false;
  });
}

/**
 * Reject a definitive non-admin request before any router or generation call.
 * Authority outages are represented separately by AAOAdminLookupUnavailableError
 * during request-local tool assembly and must never reach this function.
 */
export function enforceExplicitPlatformAdminToolRequest(input: {
  message: string;
  isAAOAdmin: boolean;
}): void {
  if (
    !input.isAAOAdmin
    && explicitlyRequestsReservedPlatformAdminTool(input.message)
  ) {
    throw new PlatformAdminToolPermissionDeniedError();
  }
}
