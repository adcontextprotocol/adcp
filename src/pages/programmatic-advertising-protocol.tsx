import React from 'react';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import Link from '@docusaurus/Link';
import SEO from '@site/src/components/SEO';

const structuredData = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Programmatic Advertising Protocol - AdCP',
  description: 'AdCP is the next generation programmatic advertising protocol. Unified programmatic workflows across all major advertising platforms with AI-powered automation.',
  url: 'https://adcontextprotocol.org/programmatic-advertising-protocol',
  mainEntity: {
    '@type': 'TechArticle',
    headline: 'The Future of Programmatic Advertising Protocols',
    description: 'How AdCP revolutionizes programmatic advertising through unified protocols and AI automation',
    author: {
      '@type': 'Organization',
      name: 'AdCP Community'
    }
  }
};

export default function ProgrammaticAdvertisingProtocol() {
  return (
    <>
      <SEO 
        title="Programmatic Advertising Protocol"
        description="AdCP is the next generation programmatic advertising protocol. Unified programmatic workflows across all major advertising platforms with AI-powered automation."
        keywords="programmatic advertising protocol, programmatic advertising automation, unified programmatic advertising, programmatic ad tech, advertising protocol standard"
        url="/programmatic-advertising-protocol"
        structuredData={structuredData}
      />
      <Layout>
        <div className="container margin-vert--lg">
          <div className="row">
            <div className="col col--8 col--offset-2">
              <Heading as="h1">
                The Future of Programmatic Advertising
              </Heading>
              <p className="margin-bottom--lg">
                <strong>AdCP is the next-generation protocol that unifies programmatic advertising.</strong> Built for the AI era, AdCP enables seamless programmatic workflows across all major advertising platforms through a single, standardized interface.
              </p>

              <div className="alert alert--info margin-bottom--lg">
                <h3>🚀 Why Programmatic Advertising Needs AdCP</h3>
                <p>The programmatic advertising landscape is fragmented with 15+ different APIs, inconsistent data formats, and complex integration requirements. AdCP solves this with a unified protocol that works everywhere.</p>
              </div>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>The Programmatic Advertising Protocol Revolution</h2>
                </div>
                <div className="card__body">
                  <div className="row">
                    <div className="col col--6">
                      <h3>Traditional Programmatic</h3>
                      <ul style={{color: '#d32f2f'}}>
                        <li>Fragmented APIs across DSPs/SSPs</li>
                        <li>Custom integration for each platform</li>
                        <li>Inconsistent data formats</li>
                        <li>Manual campaign management</li>
                        <li>Complex real-time bidding setup</li>
                        <li>Limited cross-platform optimization</li>
                      </ul>
                    </div>
                    <div className="col col--6">
                      <h3>AdCP Programmatic</h3>
                      <ul style={{color: '#2e7d32'}}>
                        <li>Single unified protocol</li>
                        <li>One integration, all platforms</li>
                        <li>Standardized data everywhere</li>
                        <li>AI-powered campaign automation</li>
                        <li>Simplified programmatic workflows</li>
                        <li>Cross-platform optimization built-in</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>Programmatic Advertising Protocol Features</h2>
                </div>
                <div className="card__body">
                  <div className="row">
                    <div className="col col--6">
                      <h3>🎯 Unified Inventory Discovery</h3>
                      <p>Search and compare programmatic inventory across all major exchanges and platforms with natural language queries.</p>
                      <code style={{display: 'block', padding: '10px', background: '#f5f5f5', marginBottom: '1rem'}}>
                        get_products("high-value automotive shoppers", <br/>
                        &nbsp;&nbsp;budget_range=[10000, 50000])
                      </code>
                    </div>
                    <div className="col col--6">
                      <h3>⚡ Real-Time Campaign Management</h3>
                      <p>Create, modify, and optimize programmatic campaigns across multiple DSPs simultaneously.</p>
                      <code style={{display: 'block', padding: '10px', background: '#f5f5f5', marginBottom: '1rem'}}>
                        create_media_buy(products=selected, <br/>
                        &nbsp;&nbsp;budget=25000, auto_optimize=true)
                      </code>
                    </div>
                  </div>
                  <div className="row">
                    <div className="col col--6">
                      <h3>📊 Cross-Platform Analytics</h3>
                      <p>Get unified reporting and analytics across all programmatic platforms in standardized formats.</p>
                    </div>
                    <div className="col col--6">
                      <h3>🤖 AI-Powered Optimization</h3>
                      <p>Built-in AI optimization algorithms that work across all connected programmatic platforms.</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>Programmatic Advertising Use Cases</h2>
                </div>
                <div className="card__body">
                  <div className="row">
                    <div className="col col--4">
                      <h3>🏢 Agencies</h3>
                      <ul>
                        <li>Manage clients across all DSPs</li>
                        <li>Unified reporting dashboards</li>
                        <li>Automated bid optimization</li>
                        <li>Cross-platform budget allocation</li>
                      </ul>
                    </div>
                    <div className="col col--4">
                      <h3>🛍️ Brands</h3>
                      <ul>
                        <li>Direct programmatic buying</li>
                        <li>Multi-platform campaigns</li>
                        <li>Real-time performance tracking</li>
                        <li>AI-driven audience discovery</li>
                      </ul>
                    </div>
                    <div className="col col--4">
                      <h3>🔧 Ad Tech</h3>
                      <ul>
                        <li>Build on open standards</li>
                        <li>Integrate with existing tools</li>
                        <li>Extend programmatic capabilities</li>
                        <li>Create new automation workflows</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>The Technology Behind AdCP</h2>
                </div>
                <div className="card__body">
                  <h3>Built for Modern Programmatic Advertising</h3>
                  <ul>
                    <li><strong>Model Context Protocol (MCP)</strong>: Native AI assistant integration for natural language campaign management</li>
                    <li><strong>JSON Schema Validation</strong>: Type-safe programmatic operations with auto-generated client libraries</li>
                    <li><strong>Asynchronous Architecture</strong>: Handle real-time bidding and campaign operations efficiently</li>
                    <li><strong>Open Standard</strong>: Community-driven development with no vendor lock-in</li>
                    <li><strong>Enterprise Security</strong>: Built-in authentication, authorization, and audit trails</li>
                  </ul>
                  
                  <h3>Programmatic Advertising Protocol Stack</h3>
                  <div style={{background: '#f8f9fa', padding: '20px', borderRadius: '4px', fontFamily: 'monospace'}}>
                    AI Assistants & Automation Tools<br/>
                    ↓<br/>
                    <strong>AdCP Protocol Layer</strong><br/>
                    ↓<br/>
                    DSPs • SSPs • Ad Exchanges • Direct Publishers
                  </div>
                </div>
              </div>

              <div className="card margin-bottom--lg">
                <div className="card__header">
                  <h2>Industry Impact & Adoption</h2>
                </div>
                <div className="card__body">
                  <p><strong>Programmatic advertising is expected to reach $110+ billion in 2025.</strong> AdCP positions your organization at the forefront of this growth by:</p>
                  <ul>
                    <li>Reducing programmatic integration costs by 70%</li>
                    <li>Enabling faster time-to-market for new campaigns</li>
                    <li>Providing cross-platform optimization capabilities</li>
                    <li>Future-proofing investments with open standards</li>
                  </ul>
                  <p>Join leading agencies, brands, and ad tech companies already building on AdCP.</p>
                </div>
              </div>

              <div className="text--center margin-top--xl">
                <Link
                  className="button button--primary button--lg margin-right--md"
                  href="https://docs.adcontextprotocol.org/docs/intro"
                >
                  Start Building on AdCP
                </Link>
                <Link
                  className="button button--outline button--secondary button--lg margin-right--md"
                  href="https://docs.adcontextprotocol.org/docs/media-buy"
                >
                  Programmatic API Docs
                </Link>
                <Link 
                  className="button button--outline button--secondary button--lg"
                  to="https://github.com/adcontextprotocol/adcp"
                >
                  View Source Code
                </Link>
              </div>
            </div>
          </div>
        </div>
      </Layout>
    </>
  );
}