import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className="hero__title">
          AI-Powered Advertising Workflows
        </Heading>
        <p className="hero__subtitle">
          Open standards that enable AI assistants to interact with advertising platforms through natural language
        </p>
        <div className={styles.buttons}>
          <Link
            className="button button--secondary button--lg margin-right--md"
            to="/docs/intro">
            Get Started 🚀
          </Link>
          <Link
            className="button button--outline button--lg"
            to="/showcase">
            View Platforms
          </Link>
        </div>
      </div>
    </header>
  );
}

function ValueProposition() {
  return (
    <section className="margin-top--xl margin-bottom--xl">
      <div className="container">
        <div className="row">
          <div className="col col--8 col--offset-2">
            <div className="text--center margin-bottom--lg">
              <Heading as="h2">Transform How You Work with Advertising Data</Heading>
              <p className="margin-bottom--lg">
                Instead of navigating complex interfaces across multiple platforms, 
                simply describe what you want in natural language.
              </p>
            </div>
          </div>
        </div>
        
        <div className="row">
          <div className="col col--6">
            <div className="card margin-bottom--md">
              <div className="card__header">
                <h3>🗣️ Natural Language</h3>
              </div>
              <div className="card__body">
                <p>
                  "Find high-income sports enthusiasts interested in premium running gear, 
                  activate them on Scope3, and set up daily reporting."
                </p>
              </div>
            </div>
          </div>
          <div className="col col--6">
            <div className="card margin-bottom--md">
              <div className="card__header">
                <h3>🤖 AI-Powered</h3>
              </div>
              <div className="card__body">
                <p>
                  Your AI assistant handles the technical complexity: audience discovery, 
                  pricing comparison, activation, and automated reporting.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Benefits() {
  const benefits = [
    {
      title: '⚡ Faster Workflows',
      description: 'Minutes instead of hours to discover and activate audiences across multiple platforms.',
    },
    {
      title: '🎯 Better Targeting',
      description: 'AI-powered relevance scoring helps you find the most suitable audiences for your campaigns.',
    },
    {
      title: '💰 Transparent Pricing',
      description: 'Compare CPM and revenue share models across platforms with clear, upfront pricing.',
    },
    {
      title: '🔗 Platform Agnostic',
      description: 'Works with any compatible platform - no vendor lock-in, maximum flexibility.',
    },
    {
      title: '📊 Automated Reporting',
      description: 'Set up usage tracking and billing reconciliation automatically.',
    },
    {
      title: '🛡️ Privacy-First',
      description: 'Built-in privacy controls and compliance with GDPR, CCPA, and industry standards.',
    },
  ];

  return (
    <section className="margin-bottom--xl" style={{backgroundColor: 'var(--ifm-color-emphasis-100)'}}>
      <div className="container padding-vert--xl">
        <div className="text--center margin-bottom--lg">
          <Heading as="h2">Why Ad Context Protocol?</Heading>
          <p>Built for the future of advertising technology</p>
        </div>
        <div className="row">
          {benefits.map((benefit, idx) => (
            <div key={idx} className="col col--4 margin-bottom--lg">
              <div className="text--center">
                <h3>{benefit.title}</h3>
                <p>{benefit.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function UseCases() {
  return (
    <section className="margin-bottom--xl">
      <div className="container">
        <div className="text--center margin-bottom--lg">
          <Heading as="h2">Real-World Use Cases</Heading>
        </div>
        <div className="row">
          <div className="col col--4">
            <div className="card">
              <div className="card__header">
                <h3>🏃‍♀️ Performance Marketing</h3>
              </div>
              <div className="card__body">
                <p>
                  "Find audiences likely to convert for our fitness app, with historical performance 
                  data showing 3%+ conversion rates."
                </p>
                <ul>
                  <li>AI discovers high-converting audiences</li>
                  <li>Transparent pricing across platforms</li>
                  <li>Automated performance tracking</li>
                </ul>
              </div>
            </div>
          </div>
          <div className="col col--4">
            <div className="card">
              <div className="card__header">
                <h3>🏢 B2B Campaigns</h3>
              </div>
              <div className="card__body">
                <p>
                  "Target CFOs at mid-market companies who are evaluating financial software 
                  solutions in the next 6 months."
                </p>
                <ul>
                  <li>Professional targeting capabilities</li>
                  <li>Intent-based audience discovery</li>
                  <li>Account-based marketing support</li>
                </ul>
              </div>
            </div>
          </div>
          <div className="col col--4">
            <div className="card">
              <div className="card__header">
                <h3>🌟 Brand Awareness</h3>
              </div>
              <div className="card__body">
                <p>
                  "Launch our luxury watch campaign to affluent millennials interested in 
                  premium lifestyle brands across US and Canada."
                </p>
                <ul>
                  <li>Geographic targeting capabilities</li>
                  <li>Demographic and interest layering</li>
                  <li>Cross-platform reach optimization</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function GetStarted() {
  return (
    <section className="margin-bottom--xl" style={{backgroundColor: 'var(--ifm-color-primary-lightest)'}}>
      <div className="container padding-vert--xl">
        <div className="row">
          <div className="col col--6">
            <Heading as="h2">For Platform Providers</Heading>
            <p>Enable AI-powered workflows for your customers:</p>
            <ul>
              <li>Implement the open standard protocols</li>
              <li>Get certified for quality assurance</li>
              <li>Join the growing ecosystem</li>
            </ul>
            <Link className="button button--primary margin-top--md" to="/docs/implementation/getting-started">
              Implementation Guide
            </Link>
          </div>
          <div className="col col--6">
            <Heading as="h2">For Advertisers & Agencies</Heading>
            <p>Transform your advertising workflows:</p>
            <ul>
              <li>Connect AdCP-enabled platforms to your AI assistant</li>
              <li>Start using natural language for campaigns</li>
              <li>Reduce manual work and increase efficiency</li>
            </ul>
            <Link className="button button--primary margin-top--md" to="/docs/intro">
              Get Started
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function CommunityAndSupport() {
  return (
    <section className="margin-bottom--xl">
      <div className="container">
        <div className="text--center margin-bottom--lg">
          <Heading as="h2">Join the Community</Heading>
          <p>Help shape the future of advertising technology</p>
        </div>
        <div className="row">
          <div className="col col--8 col--offset-2">
            <div className="card">
              <div className="card__body text--center">
                <h3>🤝 Working Group</h3>
                <p>
                  Monthly meetings with industry leaders, platform providers, and innovators 
                  building the next generation of advertising standards.
                </p>
                <div className="margin-top--md">
                  <Link className="button button--outline margin-right--sm" to="/docs/community/working-group">
                    Join Working Group
                  </Link>
                  <Link className="button button--outline" to="https://github.com/adcontextprotocol/adcp/discussions">
                    GitHub Discussions
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title="Open Standards for AI-Powered Advertising"
      description="Ad Context Protocol enables AI assistants to interact with advertising platforms through natural language. Discover audiences, activate campaigns, and automate reporting with simple conversational commands.">
      <HomepageHeader />
      <main>
        <ValueProposition />
        <Benefits />
        <UseCases />
        <GetStarted />
        <CommunityAndSupport />
      </main>
    </Layout>
  );
}
