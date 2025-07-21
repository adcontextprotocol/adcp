import OpenAI from 'openai';

export class OpenAIProvider {
  constructor(config) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: process.env[config.api_key_env || 'OPENAI_API_KEY']
    });
  }

  async generateAudiences(audienceSpec, catalogData) {
    const { audiences, catalog } = catalogData;
    
    const systemPrompt = `You are an audience targeting assistant. Given a catalog of available audiences and a user specification, suggest the most relevant audiences. 
    
Available audiences:
${JSON.stringify(audiences, null, 2)}

Return a JSON array of audience objects that match the specification. Include existing audiences from the catalog and optionally create 1-2 custom audiences if needed.
Custom audiences should have unique IDs starting with 'custom_' and is_custom: true.`;

    const userPrompt = `Find audiences matching this specification:
${JSON.stringify(audienceSpec, null, 2)}

Return up to ${audienceSpec.max_results || 10} results as a JSON array.`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.config.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: this.config.temperature || 0.7,
        max_tokens: this.config.max_tokens || 1000,
        response_format: { type: 'json_object' }
      });

      const result = JSON.parse(response.choices[0].message.content);
      return result.audiences || result;
    } catch (error) {
      console.error('OpenAI API error:', error);
      
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