import {
  PUBLIC_COMPLIANCE_NOTICE_LIMITS,
  type PublicComplianceNotice,
} from "../schemas/public-compliance-notice.js";

export {
  PUBLIC_COMPLIANCE_NOTICE_LIMITS,
  type PublicComplianceNotice,
} from "../schemas/public-compliance-notice.js";

function boundedIdentifier(
  value: unknown,
  maxLength: number
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    return undefined;
  }
  if (value.trim().length === 0) return undefined;
  return value;
}

function boundedDisplayString(
  value: unknown,
  maxLength: number
): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.length <= maxLength) {
    return value.trim().length > 0 ? value : undefined;
  }

  let prefix = value.slice(0, maxLength - 1);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }
  if (prefix.trim().length === 0) return undefined;
  return `${prefix}…`;
}

function normalizedReferenceUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > PUBLIC_COMPLIANCE_NOTICE_LIMITS.referenceUrl ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    return undefined;
  }
  if (value.trim().length === 0) return undefined;

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      return undefined;
    }
    const normalized = parsed.toString();
    return normalized.length <= PUBLIC_COMPLIANCE_NOTICE_LIMITS.referenceUrl
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

export function toPublicComplianceNotice(
  value: unknown
): PublicComplianceNotice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const severity = boundedIdentifier(
    record.severity,
    PUBLIC_COMPLIANCE_NOTICE_LIMITS.severity
  );
  const code = boundedIdentifier(
    record.code,
    PUBLIC_COMPLIANCE_NOTICE_LIMITS.code
  );
  const message = boundedDisplayString(
    record.message,
    PUBLIC_COMPLIANCE_NOTICE_LIMITS.message
  );
  if (!severity || !code || !message) return null;

  const notice: PublicComplianceNotice = { severity, code, message };
  const effectiveVersion = boundedDisplayString(
    record.effective_version,
    PUBLIC_COMPLIANCE_NOTICE_LIMITS.effectiveVersion
  );
  const requirement = boundedDisplayString(
    record.requirement,
    PUBLIC_COMPLIANCE_NOTICE_LIMITS.requirement
  );
  const capabilityPath = boundedDisplayString(
    record.capability_path,
    PUBLIC_COMPLIANCE_NOTICE_LIMITS.capabilityPath
  );
  const capabilityPointer = boundedDisplayString(
    record.capability_pointer,
    PUBLIC_COMPLIANCE_NOTICE_LIMITS.capabilityPointer
  );
  const referenceUrl = normalizedReferenceUrl(record.reference_url);

  if (effectiveVersion) notice.effective_version = effectiveVersion;
  if (requirement) notice.requirement = requirement;
  if (capabilityPath) notice.capability_path = capabilityPath;
  if (capabilityPointer) notice.capability_pointer = capabilityPointer;
  if (referenceUrl) notice.reference_url = referenceUrl;
  return notice;
}

export function projectPublicComplianceNotices(
  value: unknown
): PublicComplianceNotice[] {
  if (!Array.isArray(value)) return [];

  const projected: PublicComplianceNotice[] = [];
  for (const candidate of value.slice(
    0,
    PUBLIC_COMPLIANCE_NOTICE_LIMITS.maxScan
  )) {
    const notice = toPublicComplianceNotice(candidate);
    if (notice) projected.push(notice);
    if (projected.length >= PUBLIC_COMPLIANCE_NOTICE_LIMITS.maxNotices) break;
  }
  return projected;
}
