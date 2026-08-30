import { AddieRouter } from './router.js';
import {
  OPENAI_ROUTER_MODEL,
  OpenAIResponsesProvider,
} from './model-providers/openai-responses-provider.js';
import { ProviderHealthController } from './model-providers/provider-health.js';

export const LUNA_ROUTER_PRIMARY_DEADLINE_MS = 15_000;

export interface ProductionRouterRuntime {
  router: AddieRouter;
  primaryProvider: 'openai' | 'anthropic';
}

/** Builds the production Luna router with an independent Haiku fallback. */
export function createProductionRouter(
  anthropicApiKey: string,
  openAiApiKey: string | undefined,
  providerHealth: ProviderHealthController = new ProviderHealthController(),
): ProductionRouterRuntime {
  const haikuRouter = new AddieRouter(anthropicApiKey, undefined, providerHealth);
  const normalizedOpenAiKey = openAiApiKey?.trim();
  if (!normalizedOpenAiKey) {
    return { router: haikuRouter, primaryProvider: 'anthropic' };
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
        fallbackRouter: haikuRouter,
        primaryDeadlineMs: LUNA_ROUTER_PRIMARY_DEADLINE_MS,
      },
    ),
  };
}
