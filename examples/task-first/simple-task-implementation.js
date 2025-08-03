/**
 * Example: Implementing an AdCP Task
 * 
 * This shows how simple it is for developers to implement AdCP functionality
 * when using the task-first architecture. No protocol knowledge required!
 */

// ==============================================
// What developers implement (just business logic)
// ==============================================

class InventoryDiscoveryTask {
  async execute(input, ctx) {
    // Parse the input
    const { brief, filters = {} } = input;
    
    // Let users know what's happening
    await ctx.updateStatus('Analyzing your requirements...');
    
    // Extract intent from brief if provided
    if (brief) {
      const intent = await this.analyzeBrief(brief);
      await ctx.updateStatus(`Looking for ${intent.type} inventory...`);
      
      // Merge with explicit filters
      filters.formats = filters.formats || intent.suggestedFormats;
      filters.targeting = { ...intent.targeting, ...filters.targeting };
    }
    
    // Search inventory
    await ctx.setProgress(25, 'Searching across platforms...');
    const results = await this.searchInventory(filters);
    
    await ctx.setProgress(50, `Found ${results.length} products`);
    
    // Score and rank results
    await ctx.updateStatus('Ranking by relevance and performance...');
    const scored = await this.scoreResults(results, brief);
    
    await ctx.setProgress(75, 'Preparing recommendations...');
    
    // Prepare response
    const recommendations = scored.slice(0, 10).map(product => ({
      ...product,
      recommendation: this.generateRecommendation(product, brief)
    }));
    
    // Add artifacts
    await ctx.addArtifact({
      name: 'inventory_recommendations',
      type: 'application/json',
      data: {
        query: { brief, filters },
        total_found: results.length,
        products: recommendations
      }
    });
    
    // Add human-readable summary
    await ctx.addArtifact({
      name: 'summary',
      type: 'text/plain',
      data: this.generateSummary(recommendations, brief)
    });
    
    // Complete the task
    await ctx.complete();
  }
  
  // Business logic methods
  async analyzeBrief(brief) {
    // NLP or LLM analysis
    return {
      type: 'video',
      suggestedFormats: ['video_standard_30s'],
      targeting: { content_categories: ['sports'] }
    };
  }
  
  async searchInventory(filters) {
    // Query inventory systems
    return [/* products */];
  }
  
  async scoreResults(results, brief) {
    // Rank by relevance
    return results.sort((a, b) => b.score - a.score);
  }
  
  generateRecommendation(product, brief) {
    return `Recommended because: ${product.match_reason}`;
  }
  
  generateSummary(products, brief) {
    return `Found ${products.length} products matching "${brief}":\n` +
           products.map(p => `- ${p.name}: $${p.cpm} CPM`).join('\n');
  }
}

// ==============================================
// Another example: Creative Review Task
// ==============================================

class CreativeReviewTask {
  async execute(input, ctx) {
    const { creativeUrl, mediaBuyId } = input;
    
    // Download and analyze
    await ctx.updateStatus('Downloading creative...');
    const creative = await this.downloadCreative(creativeUrl);
    
    await ctx.updateStatus('Running automated checks...');
    await ctx.setProgress(20);
    
    // Technical validation
    const technical = await this.validateTechnical(creative);
    await ctx.setProgress(40);
    
    // Policy check
    const policy = await this.checkPolicy(creative);
    await ctx.setProgress(60);
    
    // Brand safety
    const brandSafety = await this.checkBrandSafety(creative);
    await ctx.setProgress(80);
    
    // Compile results
    const review = {
      technical,
      policy,
      brandSafety,
      overallStatus: this.determineStatus(technical, policy, brandSafety)
    };
    
    // Add review artifact
    await ctx.addArtifact({
      name: 'creative_review',
      type: 'application/json',
      data: review
    });
    
    // Need human review?
    if (review.overallStatus === 'needs_human_review') {
      await ctx.setState('pending_approval');
      await ctx.requestApproval({
        type: 'creative_review',
        reason: review.flaggedIssues[0],
        details: review
      });
      
      // When resumed after approval, continue...
    }
    
    // Auto-approved or human-approved
    if (review.overallStatus === 'approved' || ctx.task.state === 'working') {
      await ctx.updateStatus('Generating format variations...');
      
      const variations = await this.generateVariations(creative);
      
      await ctx.addArtifact({
        name: 'creative_package',
        type: 'application/json',
        data: {
          original: creative.id,
          variations: variations,
          assignedTo: mediaBuyId
        }
      });
    }
    
    await ctx.complete();
  }
  
  async downloadCreative(url) {
    // Download logic
  }
  
  async validateTechnical(creative) {
    // Check format, duration, resolution, etc.
    return { status: 'pass', details: {} };
  }
  
  async checkPolicy(creative) {
    // Check against ad policies
    return { status: 'pass', details: {} };
  }
  
  async checkBrandSafety(creative) {
    // Brand safety checks
    return { status: 'warning', issues: ['music_similarity'] };
  }
  
  determineStatus(technical, policy, brandSafety) {
    if (technical.status === 'fail' || policy.status === 'fail') {
      return 'rejected';
    }
    if (brandSafety.status === 'warning') {
      return 'needs_human_review';
    }
    return 'approved';
  }
  
  async generateVariations(creative) {
    // Create different sizes/formats
    return [
      { format: '16:9', url: '...' },
      { format: '9:16', url: '...' },
      { format: '1:1', url: '...' }
    ];
  }
}

// ==============================================
// Task Registry (Framework provides this)
// ==============================================

const taskRegistry = {
  'inventory_discovery': InventoryDiscoveryTask,
  'creative_review': CreativeReviewTask,
  'media_buy': MediaBuyTask,
  'performance_report': PerformanceReportTask
};

// ==============================================
// That's it! Developers just implement tasks.
// The framework handles:
// - Protocol translation (MCP/A2A/REST/etc)
// - State management
// - Status delivery
// - Error handling
// - Context persistence
// - Event streaming
// ==============================================

/**
 * Benefits for developers:
 * 
 * 1. No protocol knowledge needed
 * 2. Clear, simple interface (execute method)
 * 3. Built-in status/progress/HITL support
 * 4. Focus on business logic only
 * 5. Testable without protocol overhead
 * 
 * The same task automatically works with:
 * - MCP clients (sync or async)
 * - A2A agents (with streaming)
 * - REST APIs
 * - GraphQL
 * - Future protocols
 */