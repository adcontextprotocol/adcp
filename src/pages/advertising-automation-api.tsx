import React from 'react';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import Link from '@docusaurus/Link';
import SEO from '@site/src/components/SEO';

const structuredData = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Advertising Automation API - AdCP',
  description: 'AdCP provides a unified advertising automation API that simplifies programmatic advertising across all platforms. Built for developers who want to automate advertising workflows.',
  url: 'https://adcontextprotocol.org/advertising-automation-api',
  mainEntity: {
    '@type': 'SoftwareApplication',
    name: 'AdCP Advertising Automation API',
    description: 'Unified API for advertising automation across all platforms',
    applicationCategory: 'DeveloperApplication',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD'
    }
  }
};

export default function AdvertisingAutomationAPI() {
  return (
    <>
      <SEO 
        title="Advertising Automation API"
        description="AdCP provides a unified advertising automation API that simplifies programmatic advertising across all platforms. Built for developers who want to automate advertising workflows."
        keywords="advertising automation API, programmatic advertising automation, unified advertising API, advertising platform integration, ad tech automation"
        url="/advertising-automation-api"
        structuredData={structuredData}
      />
      <Layout>
        <div className="container margin-vert--lg">
          <div className="row">
            <div className="col col--8 col--offset-2">
              <Heading as="h1">
                Advertising Automation API
              </Heading>
              <p className="margin-bottom--lg">
                <strong>Stop building custom integrations for every advertising platform.</strong> AdCP provides a unified advertising automation API that works across all major advertising platforms.
              </p>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>Why Choose AdCP for Advertising Automation?</h2>
                </div>
                <div className="card__body">
                  <ul>
                    <li><strong>One API, All Platforms</strong>: Instead of integrating with 15+ different APIs, integrate once with AdCP</li>
                    <li><strong>AI-Powered</strong>: Built on Model Context Protocol (MCP) for seamless AI assistant integration</li>
                    <li><strong>Standardized Responses</strong>: Get consistent data formats across all advertising platforms</li>
                    <li><strong>Open Standard</strong>: No vendor lock-in, community-driven development</li>
                  </ul>
                </div>
              </div>

              <div className="row margin-bottom--lg">
                <div className="col col--6">
                  <div className="card">
                    <div className="card__header">
                      <h3>Traditional Approach</h3>
                    </div>
                    <div className="card__body">
                      <ul style={{color: '#d32f2f'}}>
                        <li>15+ different API integrations</li>
                        <li>Months of development time</li>
                        <li>Inconsistent data formats</li>
                        <li>Constant maintenance overhead</li>
                        <li>Platform-specific documentation</li>
                      </ul>
                    </div>
                  </div>
                </div>
                <div className="col col--6">
                  <div className="card">
                    <div className="card__header">
                      <h3>With AdCP</h3>
                    </div>
                    <div className="card__body">
                      <ul style={{color: '#2e7d32'}}>
                        <li>Single unified API integration</li>
                        <li>Deploy in days, not months</li>
                        <li>Standardized data across platforms</li>
                        <li>Minimal maintenance required</li>
                        <li>Comprehensive unified docs</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>Core Advertising Automation Features</h2>
                </div>
                <div className="card__body">
                  <div className="row">
                    <div className="col col--6">
                      <h3>Product Discovery</h3>
                      <p>Find and compare advertising inventory across all connected platforms with natural language queries.</p>
                      <code style={{display: 'block', padding: '10px', background: '#f5f5f5', marginBottom: '1rem'}}>
                        "Find sports enthusiasts with high purchase intent"
                      </code>
                    </div>
                    <div className="col col--6">
                      <h3>Campaign Management</h3>
                      <p>Create, update, and manage campaigns across multiple platforms with a single API call.</p>
                      <code style={{display: 'block', padding: '10px', background: '#f5f5f5', marginBottom: '1rem'}}>
                        create_media_buy(audience, budget, platforms)
                      </code>
                    </div>
                  </div>
                  <div className="row">
                    <div className="col col--6">
                      <h3>Performance Tracking</h3>
                      <p>Get unified analytics and reporting across all platforms in standardized formats.</p>
                    </div>
                    <div className="col col--6">
                      <h3>Creative Management</h3>
                      <p>Upload and manage creative assets with automatic format optimization for each platform.</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>Built for Modern Ad Tech</h2>
                </div>
                <div className="card__body">
                  <p>AdCP is designed for the future of advertising automation:</p>
                  <ul>
                    <li><strong>Model Context Protocol (MCP)</strong>: Native support for AI assistants and agents</li>
                    <li><strong>JSON Schema Validation</strong>: Type-safe API interactions with auto-generated clients</li>
                    <li><strong>Asynchronous Operations</strong>: Handle long-running advertising operations efficiently</li>
                    <li><strong>Human-in-the-Loop</strong>: Optional approval workflows for compliance and control</li>
                  </ul>
                </div>
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
                  to="https://github.com/adcontextprotocol/adcp"
                >
                  View on GitHub
                </Link>
              </div>
            </div>
          </div>
        </div>
      </Layout>
    </>
  );
}