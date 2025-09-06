import React from 'react';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import Link from '@docusaurus/Link';
import SEO from '@site/src/components/SEO';

const structuredData = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'AdCP vs Traditional Advertising APIs',
  description: 'Compare AdCP with traditional advertising platform APIs. See why unified advertising automation is better than platform-specific integrations.',
  url: 'https://adcontextprotocol.org/api-comparison'
};

export default function APIComparison() {
  return (
    <>
      <SEO 
        title="AdCP vs Traditional Advertising APIs"
        description="Compare AdCP with traditional advertising platform APIs. See why unified advertising automation is better than platform-specific integrations."
        keywords="advertising API comparison, AdCP vs Google Ads API, AdCP vs Meta API, unified advertising API, advertising platform comparison"
        url="/api-comparison"
        structuredData={structuredData}
      />
      <Layout>
        <div className="container margin-vert--lg">
          <div className="row">
            <div className="col col--10 col--offset-1">
              <Heading as="h1">
                AdCP vs Traditional Advertising APIs
              </Heading>
              <p className="margin-bottom--lg">
                <strong>Why settle for 15+ different API integrations when you can have one?</strong> See how AdCP compares to traditional platform-specific advertising APIs.
              </p>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>The Integration Challenge</h2>
                </div>
                <div className="card__body">
                  <p>Modern advertising requires integration with multiple platforms, each with their own APIs, data formats, and authentication methods. AdCP solves this complexity.</p>
                </div>
              </div>

              <table className="table table-striped margin-bottom--lg">
                <thead>
                  <tr>
                    <th>Feature</th>
                    <th>Traditional APIs</th>
                    <th>AdCP</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><strong>Integration Effort</strong></td>
                    <td style={{color: '#d32f2f'}}>15+ separate integrations, months of development</td>
                    <td style={{color: '#2e7d32'}}>Single integration, deploy in days</td>
                  </tr>
                  <tr>
                    <td><strong>Data Formats</strong></td>
                    <td style={{color: '#d32f2f'}}>Different schemas, manual data mapping</td>
                    <td style={{color: '#2e7d32'}}>Unified schema across all platforms</td>
                  </tr>
                  <tr>
                    <td><strong>AI Integration</strong></td>
                    <td style={{color: '#d32f2f'}}>Custom AI wrappers for each platform</td>
                    <td style={{color: '#2e7d32'}}>Native MCP support, built for AI</td>
                  </tr>
                  <tr>
                    <td><strong>Natural Language</strong></td>
                    <td style={{color: '#d32f2f'}}>Not supported, complex parameter mapping</td>
                    <td style={{color: '#2e7d32'}}>Built-in natural language processing</td>
                  </tr>
                  <tr>
                    <td><strong>Cross-Platform Analytics</strong></td>
                    <td style={{color: '#d32f2f'}}>Manual data aggregation and normalization</td>
                    <td style={{color: '#2e7d32'}}>Unified reporting across all platforms</td>
                  </tr>
                  <tr>
                    <td><strong>Authentication</strong></td>
                    <td style={{color: '#d32f2f'}}>Different auth methods per platform</td>
                    <td style={{color: '#2e7d32'}}>Unified authentication system</td>
                  </tr>
                  <tr>
                    <td><strong>Error Handling</strong></td>
                    <td style={{color: '#d32f2f'}}>Platform-specific error codes</td>
                    <td style={{color: '#2e7d32'}}>Standardized error responses</td>
                  </tr>
                  <tr>
                    <td><strong>Documentation</strong></td>
                    <td style={{color: '#d32f2f'}}>15+ different documentation sets</td>
                    <td style={{color: '#2e7d32'}}>Single comprehensive documentation</td>
                  </tr>
                </tbody>
              </table>

              <div className="row margin-bottom--lg">
                <div className="col col--6">
                  <div className="card">
                    <div className="card__header">
                      <h3>Google Ads API vs AdCP</h3>
                    </div>
                    <div className="card__body">
                      <h4>Google Ads API</h4>
                      <ul>
                        <li>Complex gRPC/REST setup</li>
                        <li>Google-specific data models</li>
                        <li>Limited to Google ecosystem</li>
                        <li>Requires OAuth 2.0 setup</li>
                      </ul>
                      <h4>AdCP</h4>
                      <ul>
                        <li>Simple MCP integration</li>
                        <li>Unified data models</li>
                        <li>Works with Google + all other platforms</li>
                        <li>Standardized authentication</li>
                      </ul>
                    </div>
                  </div>
                </div>
                <div className="col col--6">
                  <div className="card">
                    <div className="card__header">
                      <h3>Meta Marketing API vs AdCP</h3>
                    </div>
                    <div className="card__body">
                      <h4>Meta Marketing API</h4>
                      <ul>
                        <li>Facebook-specific Graph API</li>
                        <li>Platform-locked data formats</li>
                        <li>Limited to Meta properties</li>
                        <li>Custom integration required</li>
                      </ul>
                      <h4>AdCP</h4>
                      <ul>
                        <li>Protocol-agnostic interface</li>
                        <li>Cross-platform data formats</li>
                        <li>Works with Meta + all platforms</li>
                        <li>One integration for everything</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>Real-World Integration Comparison</h2>
                </div>
                <div className="card__body">
                  <div className="row">
                    <div className="col col--6">
                      <h3>Traditional Approach</h3>
                      <div style={{background: '#fff3e0', padding: '20px', borderRadius: '4px'}}>
                        <h4>Time to Market: 6-12 months</h4>
                        <ol>
                          <li>Research 15+ platform APIs</li>
                          <li>Set up OAuth for each platform</li>
                          <li>Build custom integrations</li>
                          <li>Create data normalization layer</li>
                          <li>Build unified dashboard</li>
                          <li>Handle rate limits differently</li>
                          <li>Maintain 15+ integrations</li>
                        </ol>
                        <p><strong>Ongoing Cost:</strong> High maintenance, frequent API changes</p>
                      </div>
                    </div>
                    <div className="col col--6">
                      <h3>AdCP Approach</h3>
                      <div style={{background: '#e8f5e8', padding: '20px', borderRadius: '4px'}}>
                        <h4>Time to Market: 1-2 weeks</h4>
                        <ol>
                          <li>Install AdCP MCP server</li>
                          <li>Configure platform credentials</li>
                          <li>Start using unified API</li>
                          <li>Build on standardized data</li>
                          <li>Deploy AI-powered workflows</li>
                        </ol>
                        <p><strong>Ongoing Cost:</strong> Minimal maintenance, stable API</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>Code Comparison: Campaign Creation</h2>
                </div>
                <div className="card__body">
                  <div className="row">
                    <div className="col col--6">
                      <h3>Traditional Multi-Platform Campaign</h3>
                      <pre style={{background: '#f5f5f5', padding: '15px', fontSize: '12px'}}>
{`// Google Ads API
const googleCampaign = await googleAds.createCampaign({
  customerId: 'xxx',
  campaign: {
    name: 'Campaign',
    advertisingChannelType: 'SEARCH',
    // ... 50+ lines of config
  }
});

// Meta Marketing API  
const metaCampaign = await metaAPI.post('/campaigns', {
  account_id: 'xxx',
  name: 'Campaign',
  objective: 'CONVERSIONS',
  // ... different config structure
});

// Amazon DSP API
const amazonCampaign = await amazonDSP.createCampaign({
  // ... yet another different structure
});

// Repeat for 15+ platforms...`}
                      </pre>
                    </div>
                    <div className="col col--6">
                      <h3>AdCP Unified Campaign</h3>
                      <pre style={{background: '#f5f5f5', padding: '15px', fontSize: '12px'}}>
{`// Natural language with AI
"Create a $50,000 campaign targeting 
sports enthusiasts across all platforms"

// Or programmatic API
const campaign = await adcp.create_media_buy({
  brief: {
    target_audience: "sports enthusiasts",
    budget: 50000,
    objectives: ["brand_awareness"]
  },
  platforms: "all_available"
});

// Works across Google, Meta, Amazon, 
// and all AdCP-compatible platforms`}
                      </pre>
                    </div>
                  </div>
                </div>
              </div>

              <div className="alert alert--info margin-bottom--lg">
                <h3>💡 Migration Path</h3>
                <p>Already have existing API integrations? AdCP can work alongside your current setup. Migrate platforms one by one or use AdCP for new functionality while maintaining existing integrations.</p>
              </div>

              <div className="text--center margin-top--xl">
                <Link 
                  className="button button--primary button--lg margin-right--md"
                  to="/docs/intro"
                >
                  Get Started with AdCP
                </Link>
                <Link 
                  className="button button--outline button--secondary button--lg"
                  to="/advertising-automation-api"
                >
                  Learn About AdCP APIs
                </Link>
              </div>
            </div>
          </div>
        </div>
      </Layout>
    </>
  );
}