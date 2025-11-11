import React from 'react';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import Link from '@docusaurus/Link';
import SEO from '@site/src/components/SEO';

const structuredData = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'MCP Advertising Integration - AdCP',
  description: 'AdCP brings advertising automation to the Model Context Protocol (MCP) ecosystem. Enable AI assistants to manage advertising campaigns naturally.',
  url: 'https://adcontextprotocol.org/mcp-advertising-integration',
  mainEntity: {
    '@type': 'SoftwareApplication',
    name: 'AdCP MCP Integration',
    description: 'Model Context Protocol integration for advertising automation',
    applicationCategory: 'DeveloperApplication'
  }
};

export default function MCPAdvertisingIntegration() {
  return (
    <>
      <SEO 
        title="MCP Advertising Integration"
        description="AdCP brings advertising automation to the Model Context Protocol (MCP) ecosystem. Enable AI assistants to manage advertising campaigns naturally."
        keywords="MCP advertising integration, Model Context Protocol advertising, AI assistant advertising, MCP advertising automation, AI advertising workflows"
        url="/mcp-advertising-integration"
        structuredData={structuredData}
      />
      <Layout>
        <div className="container margin-vert--lg">
          <div className="row">
            <div className="col col--8 col--offset-2">
              <Heading as="h1">
                MCP Advertising Integration
              </Heading>
              <p className="margin-bottom--lg">
                <strong>The first advertising protocol built natively for the Model Context Protocol (MCP).</strong> AdCP enables AI assistants to manage advertising campaigns, discover inventory, and optimize performance across all major platforms.
              </p>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>Why AdCP is Perfect for MCP</h2>
                </div>
                <div className="card__body">
                  <p>AdCP was designed from the ground up for AI-powered workflows:</p>
                  <ul>
                    <li><strong>Native MCP Support</strong>: Built as MCP tools, not retrofitted</li>
                    <li><strong>Natural Language Interface</strong>: Describe campaigns in plain English</li>
                    <li><strong>Context-Aware</strong>: AI assistants understand advertising domain knowledge</li>
                    <li><strong>Asynchronous by Design</strong>: Handles long-running advertising operations</li>
                  </ul>
                </div>
              </div>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>MCP Advertising Ecosystem</h2>
                </div>
                <div className="card__body">
                  <div className="row">
                    <div className="col col--4">
                      <h3>🤖 AI Assistants</h3>
                      <ul>
                        <li>Claude (Anthropic)</li>
                        <li>ChatGPT (OpenAI)</li>
                        <li>Custom AI agents</li>
                        <li>Business automation tools</li>
                      </ul>
                    </div>
                    <div className="col col--4">
                      <h3>🔌 AdCP Protocol</h3>
                      <ul>
                        <li>MCP-native tools</li>
                        <li>Standardized interfaces</li>
                        <li>JSON Schema validation</li>
                        <li>Type-safe operations</li>
                      </ul>
                    </div>
                    <div className="col col--4">
                      <h3>📊 Ad Platforms</h3>
                      <ul>
                        <li>Google Ads</li>
                        <li>Meta Advertising</li>
                        <li>Amazon DSP</li>
                        <li>Any AdCP-compatible platform</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>Natural Language Advertising with MCP</h2>
                </div>
                <div className="card__body">
                  <p>See how AI assistants can manage advertising campaigns through AdCP:</p>
                  
                  <div className="margin-bottom--md">
                    <h4>Campaign Discovery</h4>
                    <code style={{display: 'block', padding: '15px', background: '#f0f8ff', border: '1px solid #e1e8ed', borderRadius: '4px'}}>
                      👤 User: "Find advertising inventory for fitness enthusiasts who are likely to buy running shoes"<br/><br/>
                      🤖 AI: Using AdCP to search across platforms...<br/>
                      ✅ Found 12 audience segments across 5 platforms with 2.3M total reach
                    </code>
                  </div>

                  <div className="margin-bottom--md">
                    <h4>Campaign Creation</h4>
                    <code style={{display: 'block', padding: '15px', background: '#f0f8ff', border: '1px solid #e1e8ed', borderRadius: '4px'}}>
                      👤 User: "Create a $10,000 campaign targeting the best audience from the search"<br/><br/>
                      🤖 AI: Creating media buy on Platform B (best CPM at $9.50)...<br/>
                      ✅ Campaign created: ID mb-2024-001, estimated reach 1.8M users
                    </code>
                  </div>

                  <div className="margin-bottom--md">
                    <h4>Performance Monitoring</h4>
                    <code style={{display: 'block', padding: '15px', background: '#f0f8ff', border: '1px solid #e1e8ed', borderRadius: '4px'}}>
                      👤 User: "How are my running shoe campaigns performing this week?"<br/><br/>
                      🤖 AI: Fetching performance data across all platforms...<br/>
                      ✅ 3 active campaigns, 145K impressions, 2.3% CTR, $8.20 avg CPC
                    </code>
                  </div>
                </div>
              </div>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>MCP Tools Included in AdCP</h2>
                </div>
                <div className="card__body">
                  <div className="row">
                    <div className="col col--6">
                      <h3>Discovery Tools</h3>
                      <ul>
                        <li><code>get_products</code> - Find advertising inventory</li>
                        <li><code>list_creative_formats</code> - Supported ad formats</li>
                        <li><code>get_signals</code> - Audience insights</li>
                      </ul>
                    </div>
                    <div className="col col--6">
                      <h3>Campaign Management</h3>
                      <ul>
                        <li><code>create_media_buy</code> - Launch campaigns</li>
                        <li><code>update_media_buy</code> - Modify campaigns</li>
                        <li><code>get_media_buy_delivery</code> - Track performance</li>
                      </ul>
                    </div>
                  </div>
                  <div className="row">
                    <div className="col col--6">
                      <h3>Creative Management</h3>
                      <ul>
                        <li><code>add_creative_assets</code> - Upload creatives</li>
                        <li><code>validate_creative</code> - Check compliance</li>
                        <li><code>optimize_creative</code> - Format optimization</li>
                      </ul>
                    </div>
                    <div className="col col--6">
                      <h3>Analytics & Insights</h3>
                      <ul>
                        <li><code>get_campaign_metrics</code> - Performance data</li>
                        <li><code>generate_reports</code> - Custom reporting</li>
                        <li><code>get_recommendations</code> - AI optimization</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>Getting Started with MCP + AdCP</h2>
                </div>
                <div className="card__body">
                  <ol>
                    <li><strong>Install AdCP MCP Server</strong>: Add AdCP to your MCP configuration</li>
                    <li><strong>Connect Ad Platforms</strong>: Configure platform credentials</li>
                    <li><strong>Start Natural Conversations</strong>: Ask AI assistants to manage your advertising</li>
                  </ol>
                  <p>AdCP works with any MCP-compatible AI assistant, including Claude, ChatGPT, and custom agents.</p>
                </div>
              </div>

              <div className="text--center margin-top--xl">
                <Link
                  className="button button--primary button--lg margin-right--md"
                  href="https://docs.adcontextprotocol.org/docs/protocols/mcp-guide"
                >
                  MCP Integration Guide
                </Link>
                <Link
                  className="button button--outline button--secondary button--lg"
                  href="https://docs.adcontextprotocol.org/docs/intro"
                >
                  Get Started
                </Link>
              </div>
            </div>
          </div>
        </div>
      </Layout>
    </>
  );
}