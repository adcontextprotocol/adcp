import type { ToolExecution } from './model-providers/tool-orchestration.js';

/** These are application-owned receipt formats, not assertions from chat history. */
const CERTIFICATION_TOOLS = new Set([
  'complete_certification_module', 'complete_certification_exam', 'test_out_modules',
  'get_learner_progress', 'check_credentials',
]);
const MODULE_ID = /\b[A-Z]{1,2}\d{1,2}\b/gi;
const CERTIFICATION_CONTEXT = /\b(?:certification|capstone|credential|certificate)\b|\bmodule\s+[A-Z]{1,2}\d{1,2}\b/i;
const COMPLETION = /\b(?:completed?|concludes?|concluded|finished|mastered|passed|earned|certified|awarded|issued|done|locked in|in the books|wrapped up|wraps? up|you(?:'re| are) through)\b/gi;
const CREDENTIAL = /\b(?:credential|certificate|badge|certified|certification)\b/i;
const ESCALATION_CLAIM = /\b(?:I(?:'ve| have| just| will|'ll| am going to|'m going to|'m| am)?|we(?:'ve| have| will|'ll| are going to|'re going to|'re| are)?)\s+(?:(?:will|have|already|just)\s+)?(flag(?:ged|ging)?|escalat(?:e|ed|ing)|notif(?:y|ied|ying)|rais(?:e|ed|ing)|fil(?:e|ed|ing)|creat(?:e|ed|ing)|open(?:ed|ing)?|send(?:ing)?|sent|pass(?:ed|ing)?|forward(?:ed|ing)?|hand(?:ed|ing)?|contact(?:ed|ing)?|reach(?:ed|ing)? out)\b/i;
const SUPPORT_OBJECT = /\b(?:ticket|support request|team|admins?|support|github issue)\b/i;
const SUPPORT_DESTINATION = /\b(?:ticket|support request|github issue)\b|\b(?:for|to|with)\s+(?:(?:the|our|your|support)\s+){0,2}(?:team|admins?|support)\b/i;
const PASSIVE_ESCALATION = /\b(?:(?:team|admins?) (?:has been|have been|will be|is being|was|were) (?:notified|alerted)|(?:ticket|support request|escalation)(?: #\d+)? (?:has been |was |is |will be )?(?:created|filed|opened|raised|saved)|(?:this|it|issue|request|problem|bug) (?:has been|was|will be|is being) (?:flagged|escalated|forwarded|passed|sent))\b/gi;
const GUARANTEED_NOTIFICATION = /\b(?:I(?:'ll| will)|we(?:'ll| will))\s+(?:make sure|ensure|let)\b/i;

export const UNCONFIRMED_CERTIFICATION = "You're making progress. I haven't confirmed a saved completion for this module or credential yet. We can keep working; completion needs to be recorded before I can confirm it.";
export const DIRECT_SUPPORT = "I haven't created or escalated a support request. For help, email support@agenticadvertising.org with a brief description of what went wrong. Don't include passwords or sign-in codes.";

/** Generic tool/sign-in boilerplate is not evidence of a teaching conversation. */
export function outcomeClaimContext(messages: readonly string[], requestContext = ''): string {
  const activeCertification = /^## Active certification modules\r?$/m.test(requestContext)
    || /^### Certification\r?\nCurrently working on:/m.test(requestContext);
  return [...messages, ...(activeCertification ? ['Active certification module.'] : [])].join('\n');
}

/** Qualifiers apply to the claimed predicate, not every other clause in a sentence. */
function hasSupportClaim(text: string, context: string): boolean {
  const actionMatch = ESCALATION_CLAIM.exec(text);
  const action = actionMatch?.[1]?.toLowerCase();
  const supportContext = /\b(?:registration|sign[ -]?up|verification|support)\b/i.test(`${context}\n${text}`);
  const directObject = actionMatch ? text.slice(actionMatch.index + actionMatch[0].length) : '';
  const contextualRequest = supportContext && /^\s+(?:(?:this|that|it)|(?:(?:this|the|your|an?)\s+)?(?:(?:registration|sign[ -]?up|verification|support)\s+)?(?:issue|problem|bug|request))(?=\s*(?:[.!?,;:]|$)|\s+(?:because|for you)\b)/i.test(directObject);
  if (action && (action.startsWith('escalat')
    || (action.startsWith('flag') ? SUPPORT_DESTINATION.test(text) : SUPPORT_OBJECT.test(text))
    || contextualRequest)) return true;
  if (GUARANTEED_NOTIFICATION.test(text) && /\b(?:team|admins?|support)\b/i.test(text)
    && /\b(?:hears?|sees?|receives?|notified|alerted|knows?)\b/i.test(text)) return true;
  for (const match of text.matchAll(PASSIVE_ESCALATION)) {
    const prefix = text.slice(0, match.index);
    if (/\b(?:no|not|never)\s+(?:(?:a|the|any)\s+)?$/i.test(prefix)) continue;
    if (/\b(?:can't|cannot|couldn't|could not|haven't|have not|unable to)\s+(?:confirm|verify|say)\s+(?:(?:that|whether)\s+)?(?:(?:the|a)\s+)?$/i.test(prefix)) continue;
    if (/\b(?:not sure|unclear)\s+(?:(?:that|whether|if)\s+)?(?:(?:the|a)\s+)?$/i.test(prefix)) continue;
    if (/(?:^|[,;:]\s*)\s*(?:if|whether|when|once|until)\s+(?:(?:the|a)\s+)?$/i.test(prefix)) continue;
    const genericAction = /\b(?:flagged|forwarded|passed|sent)$/i.test(match[0]);
    if (genericAction && !SUPPORT_DESTINATION.test(text)
      && !(supportContext && /^\s*(?:[.!?,;:]|$|because\b)/i.test(text.slice(match.index + match[0].length)))) continue;
    return true;
  }
  return false;
}

interface CertificationEvidence {
  modules: Set<string>;
  credentials: Set<string>;
  issuedCredentials: Map<string, string>;
}

/** Only anchored, application-generated lines from successful certification tools count. */
function certificationEvidence(executions: readonly ToolExecution[]): CertificationEvidence {
  const evidence: CertificationEvidence = { modules: new Set(), credentials: new Set(), issuedCredentials: new Map() };
  for (const execution of executions) {
    if (execution.is_error || !CERTIFICATION_TOOLS.has(execution.tool_name)) continue;
    const text = execution.result;
    if (text.startsWith('NOT COMPLETED')) continue;
    const lines = text.split('\n');
    if (execution.tool_name === 'complete_certification_module') {
      const match = /^Module ([A-Z]{1,2}\d{1,2}) completed!/.exec(lines[0] ?? '');
      if (match) evidence.modules.add(match[1]!);
    }
    if (execution.tool_name === 'complete_certification_exam' && text.startsWith('# Congratulations! The learner passed the capstone!')) {
      // The module receipt is emitted only after its separate persistence succeeds.
      for (const line of lines) {
        const match = /^Module ([A-Z]{1,2}\d{1,2}) completed!$/.exec(line);
        if (match) evidence.modules.add(match[1]!);
      }
    }
    if (execution.tool_name === 'get_learner_progress' && text.startsWith('# Your certification progress')) {
      let section = '';
      for (const line of lines) {
        if (line.startsWith('## ')) section = line;
        const module = section === '## Module details' && /^- ([A-Z]{1,2}\d{1,2}): (?:completed|tested out)$/.exec(line);
        if (module) evidence.modules.add(module[1]!);
        const credential = section === '## Earned credentials' && /^- \*\*(.+)\*\* \(Level \d+\) — earned .+$/.exec(line);
        if (credential) evidence.credentials.add(credential[1]!);
      }
    }
    if (execution.tool_name === 'test_out_modules' && /^Marked \d+ module\(s\) as tested out:/.test(text)) {
      // Stop before the user-supplied assessment notes.
      for (const line of lines.slice(2)) {
        if (!line.startsWith('- ')) break;
        const match = /^- ([A-Z]{1,2}\d{1,2}): (?:tested out|already completed \(kept existing status\))$/.exec(line);
        if (match) evidence.modules.add(match[1]!);
      }
    }
    // Credential award and external badge issuance are separate outcomes.
    // These lines originate in checkAndFormatCredentials, after database writes.
    if (execution.tool_name !== 'get_learner_progress' && execution.tool_name !== 'test_out_modules') {
      let credential: string | undefined;
      for (const line of lines) {
        const match = /^\*\*Credential earned: (.+)!\*\*$/.exec(line);
        if (match) { credential = match[1]!; evidence.credentials.add(credential); }
        const share = /^- \[View and share your credential\]\((https:\/\/credsverse\.com\/credentials\/[A-Za-z0-9._~!%'*+-]+)\)$/.exec(line);
        const sharePath = share ? new URL(share[1]!).pathname : '';
        if (credential && share && sharePath.startsWith('/credentials/') && sharePath.length > '/credentials/'.length) {
          evidence.issuedCredentials.set(credential, share[1]!);
        }
      }
    }
  }
  return evidence;
}

/** A singular generic reference can bind to one receipt, never a different named award. */
function hasOnlyGenericCredentialReferences(text: string): boolean {
  const mentions = [...text.matchAll(/\b(?:credential|certificate|badge|certification|certified)\b/gi)];
  return mentions.length > 0 && mentions.every(match => {
    const prefix = text.slice(0, match.index);
    const suffix = text.slice(match.index + match[0].length);
    if (/^\s+(?:in|for|of|as)\b/i.test(suffix)) return false;
    return match[0].toLowerCase() === 'certified'
      ? /\byou(?:'re| are)(?:\s+now)?\s+$/i.test(prefix)
      : /\b(?:your|the|an?|this|that)\s+(?:(?:new|earned)\s+)?$/i.test(prefix);
  });
}

function supportReceipt(executions: readonly ToolExecution[]): { id: number; notified: boolean } | null {
  for (const execution of [...executions].reverse()) {
    if (execution.tool_name !== 'escalate_to_admin' || execution.is_error) continue;
    try {
      const receipt = JSON.parse(execution.result);
      if (receipt?.success === true && Number.isSafeInteger(receipt.escalation_id) && receipt.escalation_id > 0
        && typeof receipt.notification_sent === 'boolean') {
        return { id: receipt.escalation_id, notified: receipt.notification_sent };
      }
    } catch { /* Legacy prose is not a persisted receipt. */ }
  }
  return null;
}

/** Test each outcome predicate; an unrelated negation cannot exempt a claim. */
function assertsCertificationOutcome(text: string): boolean {
  if (/^(?:complete|finish|pass|master|earn)\b/i.test(text.trim())) return false;
  if (/^(?:have|has|is|are|did|can|could|would|will)\b/i.test(text.trim()) && text.endsWith('?')) return false;
  const predicates = [...text.matchAll(COMPLETION)];
  if (CREDENTIAL.test(text)) predicates.push(...text.matchAll(/\b(?:yours|ready(?=\s*[.!?]?$| to (?:download|share)| for (?:download|sharing)))/gi));
  if (/\bmastery\b/i.test(text)) predicates.push(...text.matchAll(/\b(?:confirmed|demonstrated|recorded)\b/gi));
  for (const match of predicates) {
    const prefix = text.slice(0, match.index);
    // Negation must apply to this predicate, not another clause.
    if (/\b(?:not|never|haven't|hasn't|isn't|aren't|cannot|can't)(?:\s+\w+){0,2}\s+$/i.test(prefix)) continue;
    const clause = prefix.split(/[,;:]|\b(?:but|and|so)\b/i).at(-1)!.trim();
    if (/^(?:once|if|when|until|before|to)\b/i.test(clause)) continue;
    if (/\bto\s+$/i.test(prefix)) continue;
    return true;
  }
  return false;
}

/**
 * Delivery backstop shared by streaming and non-streaming terminal responses.
 * History identifies teaching context only; it can never authorize a claim.
 * Replace unsupported outcome sentences, preserving teaching and next steps.
 */
export function enforceOutcomeClaims(
  text: string,
  executions: readonly ToolExecution[],
  conversationContext = '',
): { text: string; reason: string | null } {
  const evidence = certificationEvidence(executions);
  const support = supportReceipt(executions);
  const certificationContext = CERTIFICATION_CONTEXT.test(conversationContext)
    || executions.some(execution => CERTIFICATION_TOOLS.has(execution.tool_name));
  const reasons = new Set<string>();
  let certificationReplaced = false;
  let certificationRendered = false;
  let supportReplaced = false;
  const parts = text.split(/((?<=[.!?])\s+|\n+)/);
  const output: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (index % 2 === 1) { output.push(part); continue; }
    const plain = part.replace(/\[([^\[\]\n]*)\]\([^\[\]\s()]+\)/g, '$1')
      .replace(/[*_`]/g, '').replace(/[’‘]/g, "'");
    if (hasSupportClaim(plain, `${conversationContext}\n${text}${support ? '\nSupport request receipt.' : ''}`)) {
      if (!supportReplaced) output.push(support
        ? `Support request #${support.id} is saved.${support.notified ? ' The team notification was sent.' : ' I could not confirm a team notification.'}`
        : DIRECT_SUPPORT);
      supportReplaced = true;
      if (!support) reasons.add('Unconfirmed support escalation');
      continue;
    }
    const ids = [...plain.matchAll(MODULE_ID)].map(match => match[0].toUpperCase());
    const teachingSubtask = ids.length === 0 && !CREDENTIAL.test(plain)
      && !/\b(?:module|capstone|mastery)\b/i.test(plain)
      && [...plain.matchAll(COMPLETION)].length === 1
      && /\b(?:completed?|finished|passed|mastered)\s+(?:(?:the|this|that|an?|your)\s+)?(?:example|exercise|question|practice|tutorial|request|media buy|deployment)\b/i.test(plain);
    const isCertificationClaim = !teachingSubtask && assertsCertificationOutcome(plain)
      && (CREDENTIAL.test(plain) || /\bcapstone\b|\bmodule\s+[A-Z]{1,2}\d{1,2}\b/i.test(plain)
        || (certificationContext && (ids.length > 0 || /\b(?:module|you|your|we|that|this|it)\b/i.test(plain))));
    if (isCertificationClaim) {
      const credentialClaim = CREDENTIAL.test(plain);
      const externalIssuance = /\b(?:issued|sent|delivered|download|share|ready)\b/i.test(plain);
      const credentials = externalIssuance ? evidence.issuedCredentials : evidence.credentials;
      const modulesSupported = ids.every(id => evidence.modules.has(id));
      const claimedCredentials = [...credentials.keys()].filter(name => plain.toLowerCase().includes(name.toLowerCase()));
      if (claimedCredentials.length === 0 && credentials.size === 1 && hasOnlyGenericCredentialReferences(plain)) {
        claimedCredentials.push(...credentials.keys());
      }
      const modules = ids.length ? ids : [...evidence.modules];
      const supported = modulesSupported && (credentialClaim ? claimedCredentials.length > 0 : modules.length > 0);
      if (!supported) {
        if (!certificationReplaced) output.push(UNCONFIRMED_CERTIFICATION);
        certificationReplaced = true;
        reasons.add('Unconfirmed certification completion');
        continue;
      }
      // Render only the precise recorded outcomes. A valid receipt must not
      // license extra credentials, modules, or delivery claims in model prose.
      output.push([
        ...modules.filter(id => evidence.modules.has(id)).map(id => `${id} is recorded as complete.`),
        ...(credentialClaim ? claimedCredentials.map(name => {
          const shareUrl = evidence.issuedCredentials.get(name);
          return `Credential ${externalIssuance ? 'issued' : 'earned'}: ${name}.`
            + (shareUrl ? ` [View and share your credential](${shareUrl})` : '');
        }) : []),
      ].join(' '));
      certificationRendered = true;
      continue;
    }
    output.push(part);
  }
  return { text: reasons.size > 0 || supportReplaced || certificationRendered ? output.join('').trim() : text, reason: [...reasons].join('; ') || null };
}
