import React from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import styles from './index.module.css';

const platforms = [
  {
    name: 'Scope3',
    description: 'Complete Audience Discovery Protocol implementation with real-time activation and reporting.',
    status: 'Live',
    website: 'https://scope3.com',
    protocols: ['Audience Discovery RFC'],
    features: ['Natural Language Search', 'Multi-Platform Activation', 'Usage Reporting'],
  },
  {
    name: 'Reference Implementation',
    description: 'Open source reference implementation for platform providers and developers.',
    status: 'Available',
    website: 'https://github.com/adcontextprotocol/reference-implementation',
    protocols: ['Audience Discovery RFC'],
    features: ['Complete Protocol Support', 'Test Suite Included', 'Documentation'],
  },
];

const comingSoon = [
  {
    name: 'The Trade Desk',
    description: 'B2B-focused audience discovery with enhanced business targeting capabilities.',
    status: 'Coming Q1 2025',
    protocols: ['Audience Discovery RFC'],
    features: ['B2B Audiences', 'Account-Based Targeting', 'Professional Demographics'],
  },
  {
    name: 'LiveRamp',
    description: 'Identity-resolved audience activation with household and individual targeting.',
    status: 'Coming Q1 2025', 
    protocols: ['Audience Discovery RFC'],
    features: ['Identity Resolution', 'Cross-Device Linking', 'Privacy-Safe Targeting'],
  },
];

function PlatformCard({name, description, status, website, protocols, features}) {
  return (
    <div className="col col--6 margin-bottom--lg">
      <div className={clsx('card', styles.showcaseCard)}>
        <div className="card__header">
          <h3>{name}</h3>
          <span className={clsx('badge', status === 'Live' ? 'badge--success' : 'badge--secondary')}>
            {status}
          </span>
        </div>
        <div className="card__body">
          <p>{description}</p>
          <div className="margin-bottom--sm">
            <strong>Protocols:</strong>
            <ul>
              {protocols.map((protocol, idx) => (
                <li key={idx}>{protocol}</li>
              ))}
            </ul>
          </div>
          <div className="margin-bottom--sm">
            <strong>Features:</strong>
            <ul>
              {features.map((feature, idx) => (
                <li key={idx}>{feature}</li>
              ))}
            </ul>
          </div>
        </div>
        {website && (
          <div className="card__footer">
            <a href={website} className="button button--primary button--outline">
              Learn More
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Showcase() {
  return (
    <Layout
      title="Platform Showcase"
      description="Platforms and implementations supporting the Ad Context Protocol">
      <header className={clsx('hero hero--primary', styles.heroBanner)}>
        <div className="container">
          <h1 className="hero__title">Platform Showcase</h1>
          <p className="hero__subtitle">
            Discover platforms and implementations that support the Ad Context Protocol
          </p>
        </div>
      </header>
      <main>
        <section className="container margin-top--lg margin-bottom--lg">
          <h2>Live Implementations</h2>
          <p>Platforms currently supporting AdCP in production:</p>
          <div className="row">
            {platforms.map((props, idx) => (
              <PlatformCard key={idx} {...props} />
            ))}
          </div>
        </section>

        <section className="container margin-bottom--lg">
          <h2>Coming Soon</h2>
          <p>Platforms implementing AdCP support:</p>
          <div className="row">
            {comingSoon.map((props, idx) => (
              <PlatformCard key={idx} {...props} />
            ))}
          </div>
        </section>

        <section className="container margin-bottom--lg">
          <div className="row">
            <div className="col col--8 col--offset-2">
              <div className="card">
                <div className="card__header">
                  <h3>Want to be Listed?</h3>
                </div>
                <div className="card__body">
                  <p>
                    If you're implementing the Ad Context Protocol and would like to be featured here:
                  </p>
                  <ol>
                    <li><strong>Complete Implementation</strong>: Implement the required protocol endpoints</li>
                    <li><strong>Pass Validation</strong>: Run the AdCP validation test suite successfully</li>
                    <li><strong>Submit Application</strong>: Email us with your implementation details</li>
                  </ol>
                </div>
                <div className="card__footer">
                  <a href="mailto:showcase@adcontextprotocol.org" className="button button--primary">
                    Submit Your Platform
                  </a>
                  <a href="/docs/implementation/getting-started" className="button button--secondary margin-left--sm">
                    Implementation Guide
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}