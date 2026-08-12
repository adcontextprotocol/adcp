import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const PUBLIC_COMPLIANCE_NOTICE_LIMITS = {
  maxNotices: 50,
  maxScan: 100,
  severity: 64,
  code: 200,
  message: 1_000,
  effectiveVersion: 64,
  requirement: 500,
  capabilityPath: 512,
  capabilityPointer: 1_024,
  referenceUrl: 2_048,
} as const;

export const PublicComplianceNoticeSchema = z
  .object({
    severity: z.string().min(1).max(PUBLIC_COMPLIANCE_NOTICE_LIMITS.severity),
    code: z.string().min(1).max(PUBLIC_COMPLIANCE_NOTICE_LIMITS.code),
    message: z.string().min(1).max(PUBLIC_COMPLIANCE_NOTICE_LIMITS.message),
    effective_version: z
      .string()
      .min(1)
      .max(PUBLIC_COMPLIANCE_NOTICE_LIMITS.effectiveVersion)
      .optional(),
    requirement: z
      .string()
      .min(1)
      .max(PUBLIC_COMPLIANCE_NOTICE_LIMITS.requirement)
      .optional(),
    capability_path: z
      .string()
      .min(1)
      .max(PUBLIC_COMPLIANCE_NOTICE_LIMITS.capabilityPath)
      .optional(),
    capability_pointer: z
      .string()
      .min(1)
      .max(PUBLIC_COMPLIANCE_NOTICE_LIMITS.capabilityPointer)
      .optional(),
    reference_url: z
      .string()
      .url()
      .max(PUBLIC_COMPLIANCE_NOTICE_LIMITS.referenceUrl)
      .optional(),
  })
  .strict();

export type PublicComplianceNotice = z.infer<
  typeof PublicComplianceNoticeSchema
>;
