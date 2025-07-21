import { OpenAIProvider } from './openaiProvider.js';
import { AnthropicProvider } from './anthropicProvider.js';

export class AIProvider {
  async generateAudiences(audienceSpec, catalogData) {
    throw new Error('generateAudiences must be implemented by subclass');
  }
}

export class AIProviderFactory {
  static create(provider, config) {
    switch (provider) {
      case 'openai':
        return new OpenAIProvider(config);
      case 'anthropic':
        return new AnthropicProvider(config);
      case 'stub':
        return new StubProvider(config);
      default:
        throw new Error(`Unknown AI provider: ${provider}`);
    }
  }
}

class StubProvider extends AIProvider {
  constructor(config) {
    super();
    this.config = config;
  }

  async generateAudiences(audienceSpec, catalogData) {
    const { audiences, catalog } = catalogData;
    
    const keywords = audienceSpec.keywords || [];
    const description = audienceSpec.description || '';
    const searchText = [...keywords, description].join(' ').toLowerCase();
    
    const matches = audiences.filter(audience => {
      const audienceText = `${audience.name} ${audience.description}`.toLowerCase();
      return searchText.split(' ').some(term => 
        term && audienceText.includes(term)
      );
    });

    const results = matches.slice(0, audienceSpec.max_results || 10);
    
    if (results.length < 5 && audienceSpec.keywords) {
      const customAudience = {
        audience_id: `custom_${Date.now()}`,
        name: `Custom: ${audienceSpec.keywords.join(', ')}`,
        description: `Custom audience based on keywords: ${audienceSpec.keywords.join(', ')}`,
        is_custom: true
      };
      results.push(customAudience);
    }
    
    return results;
  }
}