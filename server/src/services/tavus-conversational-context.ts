const UNTRUSTED_CONTEXT_OPEN = '<user_supplied_context trust="untrusted">';
const UNTRUSTED_CONTEXT_CLOSE = "</user_supplied_context>";

export const TAVUS_SETTING_LIMITS = {
  displayName: 100,
  greeting: 500,
  extraContext: 2_000,
} as const;

function boundedPrefix(value: string, maxLength: number): string {
  let prefix = value.slice(0, maxLength);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }
  return prefix;
}

export function boundedTrimmedTavusSetting(
  value: unknown,
  maxLength: number
): string {
  if (typeof value !== "string" || value.length === 0) return "";
  // Bound work before trim: content beyond the accepted prefix must not make
  // an otherwise-whitespace setting nonempty or force an unbounded scan.
  return boundedPrefix(value, maxLength).trim();
}

export function escapeTavusContextText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;");
}

export function sanitizeTavusDisplayName(value: string): string {
  const normalized = boundedPrefix(value, TAVUS_SETTING_LIMITS.displayName)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\[\]<>{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "User";
}

export function buildTavusConversationalContext(input: {
  threadId: string;
  displayName: string;
  extraContext: unknown;
}): string {
  const baseContext = `[conductor:thread_id=${input.threadId}] The user's name is ${input.displayName}.`;
  const extraContext = boundedTrimmedTavusSetting(
    input.extraContext,
    TAVUS_SETTING_LIMITS.extraContext
  );
  if (!extraContext) return baseContext;

  return `${baseContext}\n\n${UNTRUSTED_CONTEXT_OPEN}\n${escapeTavusContextText(
    extraContext
  )}\n${UNTRUSTED_CONTEXT_CLOSE}`;
}

export type TavusRawMessage = { role: string; content: unknown };

export function extractTavusText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          typeof (block as Record<string, unknown>)?.text === "string"
      )
      .map((block) => block.text)
      .join(" ");
  }
  return String(content);
}

/**
 * Build user/assistant history for Addie. Tavus system-role content stays out
 * of the application-owned prompt and request context.
 */
export function buildTavusThreadContext(messages: TavusRawMessage[]): {
  currentMessage: string;
  threadContext: Array<{ user: string; text: string }>;
} | null {
  const chatMessages = messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant"
    )
    .map((message) => ({
      role: message.role,
      content: extractTavusText(message.content),
    }));

  let lastUserIndex = -1;
  for (let index = chatMessages.length - 1; index >= 0; index--) {
    if (chatMessages[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex === -1) return null;

  return {
    currentMessage: chatMessages[lastUserIndex].content,
    threadContext: chatMessages
      .slice(0, lastUserIndex)
      .slice(-10)
      .map((message) => ({
        user: message.role === "user" ? "User" : "Addie",
        text: message.content,
      })),
  };
}
