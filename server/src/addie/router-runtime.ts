import { AddieRouter } from './router.js';
import {
  OPENAI_ROUTER_MODEL,
  OpenAIResponsesProvider,
} from './model-providers/openai-responses-provider.js';
import { ProviderHealthController } from './model-providers/provider-health.js';

export const LUNA_ROUTER_PRIMARY_DEADLINE_MS = 15_000;

export interface ProductionRouterRuntime {
  router: AddieRouter;
  primaryProvider: 'openai';
}

/** Builds the production Luna router. Routing failures propagate to the caller. */
export function createProductionRouter(
  openAiApiKey: string | undefined,
  providerHealth: ProviderHealthController = new ProviderHealthController(),
): ProductionRouterRuntime {
  const normalizedOpenAiKey = openAiApiKey?.trim();
  if (!normalizedOpenAiKey) {
    throw new Error('OPENAI_API_KEY is required for the production Addie router');
  }

  return {
    primaryProvider: 'openai',
    router: new AddieRouter(
      normalizedOpenAiKey,
      new OpenAIResponsesProvider(normalizedOpenAiKey),
      providerHealth,
      {
        model: OPENAI_ROUTER_MODEL,
        reasoning: { effort: 'none' },
        strictOutput: true,
        primaryDeadlineMs: LUNA_ROUTER_PRIMARY_DEADLINE_MS,
      },
    ),
  };
}
