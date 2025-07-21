import Anthropic from '@anthropic-ai/sdk';

export class AnthropicProvider {
  constructor(config) {
    this.config = config;
    this.client = new Anthropic({
      apiKey: process.env[config.api_key_env || 'ANTHROPIC_API_KEY']
    });
  }

  async generateAudiences(audienceSpec, catalogData) {
    const { audiences, catalog } = catalogData;
    
    const prompt = `Given this catalog of available audiences:
${JSON.stringify(audiences, null, 2)}

Find audiences matching this specification:
${JSON.stringify(audienceSpec, null, 2)}

Return a JSON array of up to ${audienceSpec.max_results || 10} audience objects that best match the specification. 
Include existing audiences from the catalog and optionally create 1-2 custom audiences if needed.
Custom audiences should have unique IDs starting with 'custom_' and include is_custom: true.

Return only valid JSON, no explanations.`;

    try {
      const response = await this.client.messages.create({
        model: this.config.model || 'claude-3-haiku-20240307',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: this.config.max_tokens || 1000,
        temperature: this.config.temperature || 0.7
      });

      const content = response.content[0].text;
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      throw new Error('No valid JSON array found in response');
    } catch (error) {
      console.error('Anthropic API error:', error);
      
      const fallbackResults = audiences
        .filter(a => {
          const text = `${a.name} ${a.description}`.toLowerCase();
          const searchTerms = [
            ...(audienceSpec.keywords || []),
            audienceSpec.description || ''
          ].join(' ').toLowerCase().split(' ').filter(t => t);
          
          return searchTerms.some(term => text.includes(term));
        })
        .slice(0, audienceSpec.max_results || 10);
      
      return fallbackResults;
    }
  }
}