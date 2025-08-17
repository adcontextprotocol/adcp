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
    <header className={clsx('hero', styles.heroBanner)}>
      <div className="container">
        <div className="row">
          <div className="col col--8 col--offset-2">
            <Heading as="h1" className={styles.heroTitle}>
              One protocol for every advertising platform
            </Heading>
            <p className={styles.heroSubtitle}>
              Stop jumping between dozens of different interfaces.
              <br />
              <strong>AdCP unifies advertising workflows with a single, open standard.</strong>
            </p>
            <div className={styles.heroPoints}>
              <div className={styles.point}>
                <div className={styles.pointIcon}>🔌</div>
                <div className={styles.pointText}>
                  <strong>Universal Interface</strong>
                  <br />
                  Connect once, work everywhere
                </div>
              </div>
              <div className={styles.point}>
                <div className={styles.pointIcon}>💬</div>
                <div className={styles.pointText}>
                  <strong>Natural Language</strong>
                  <br />
                  Describe what you want in plain English
                </div>
              </div>
              <div className={styles.point}>
                <div className={styles.pointIcon}>🔓</div>
                <div className={styles.pointText}>
                  <strong>Open Standard</strong>
                  <br />
                  No vendor lock-in, total flexibility
                </div>
              </div>
            </div>
            <div className={styles.buttons}>
              <Link
                className="button button--primary button--lg margin-right--md"
                to="/docs/intro">
                Start Building
              </Link>
              <Link
                className="button button--outline button--secondary button--lg"
                to="https://github.com/adcontextprotocol/adcp">
                View on GitHub
              </Link>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function TheProblem() {
  return (
    <section className={styles.problemSection}>
      <div className="container">
        <div className="row">
          <div className="col col--10 col--offset-1">
            <div className={styles.problemContent}>
              <Heading as="h2" className={styles.sectionTitle}>
                Why we built AdCP
              </Heading>
              <p className={styles.problemIntro}>
                The advertising ecosystem is fragmented. Every platform has its own API, 
                its own workflow, its own reporting format. Media buyers and agencies waste 
                countless hours navigating this complexity.
              </p>
              <div className={styles.problemGrid}>
                <div className={styles.problemCard}>
                  <h3>The Integration Problem</h3>
                  <p>
                    Each new platform requires custom integration work. APIs change, 
                    documentation varies, and maintenance never ends. Teams spend more 
                    time on plumbing than on strategy.
                  </p>
                </div>
                <div className={styles.problemCard}>
                  <h3>The Discovery Problem</h3>
                  <p>
                    Inventory is scattered across platforms with different taxonomies 
                    and targeting options. Finding the right audiences means learning 
                    multiple systems and manually comparing options.
                  </p>
                </div>
                <div className={styles.problemCard}>
                  <h3>The Automation Problem</h3>
                  <p>
                    AI agents and automation tools can't easily interact with advertising 
                    platforms. Each integration is bespoke, limiting the potential of 
                    AI-powered workflows.
                  </p>
                </div>
              </div>
              <div className={styles.visionStatement}>
                <p>
                  <strong>We believe there's a better way.</strong> A single protocol that any platform 
                  can implement and any tool can use. An open standard that makes advertising 
                  technology work together, not against each other.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function TheSolution() {
  return (
    <section className={styles.solutionSection}>
      <div className="container">
        <div className="row">
          <div className="col col--10 col--offset-1">
            <Heading as="h2" className={styles.sectionTitle}>
              One protocol. Every platform. Total control.
            </Heading>
            <p className={styles.sectionSubtitle}>
              AdCP is the open standard that unifies advertising workflows across all platforms.
              <br />
              Think of it as the USB-C of advertising technology.
            </p>
            
            <div className={styles.comparisonTable}>
              <div className={styles.comparisonColumn}>
                <h3>Before AdCP</h3>
                <ul className={styles.comparisonList}>
                  <li className={styles.negative}>15+ different platform APIs</li>
                  <li className={styles.negative}>Months of custom integration</li>
                  <li className={styles.negative}>Manual data reconciliation</li>
                  <li className={styles.negative}>Fragmented reporting</li>
                  <li className={styles.negative}>Vendor lock-in</li>
                </ul>
              </div>
              <div className={styles.comparisonColumn}>
                <h3>With AdCP</h3>
                <ul className={styles.comparisonList}>
                  <li className={styles.positive}>One unified interface</li>
                  <li className={styles.positive}>Deploy in days</li>
                  <li className={styles.positive}>Automated workflows</li>
                  <li className={styles.positive}>Consolidated analytics</li>
                  <li className={styles.positive}>Complete flexibility</li>
                </ul>
              </div>
            </div>

            <div className={styles.demoSection}>
              <h3>See the difference</h3>
              <div className={styles.demoComparison}>
                <div className={styles.demoBox}>
                  <h4>Traditional Workflow</h4>
                  <code className={styles.codeBlock}>
                    1. Log into Platform A<br />
                    2. Search for audiences (30 min)<br />
                    3. Export to spreadsheet<br />
                    4. Log into Platform B<br />
                    5. Manually recreate targeting<br />
                    6. Wait for approval (2 days)<br />
                    7. Repeat for 10 more platforms...
                  </code>
                </div>
                <div className={styles.demoBox}>
                  <h4>AdCP Workflow</h4>
                  <code className={styles.codeBlock}>
                    "Find sports enthusiasts with<br />
                    high purchase intent, compare<br />
                    prices across all platforms,<br />
                    and activate the best option."<br />
                    <br />
                    <span className={styles.success}>✓ Done in minutes</span>
                  </code>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className={styles.howItWorksSection}>
      <div className="container">
        <div className="row">
          <div className="col col--10 col--offset-1">
            <Heading as="h2" className={styles.sectionTitle}>
              How AdCP works
            </Heading>
            <p className={styles.sectionSubtitle}>
              Built on the Model Context Protocol (MCP), AdCP provides a unified interface 
              for advertising operations across any platform.
            </p>
            
            <div className={styles.workflowSteps}>
              <div className={styles.step}>
                <div className={styles.stepNumber}>1</div>
                <div className={styles.stepContent}>
                  <h3>Discovery</h3>
                  <p>
                    Use natural language to describe your target audience. 
                    AdCP searches across all connected platforms to find 
                    matching inventory and audiences.
                  </p>
                  <code className={styles.exampleCode}>
                    "Find sports enthusiasts interested in running gear"
                  </code>
                </div>
              </div>

              <div className={styles.step}>
                <div className={styles.stepNumber}>2</div>
                <div className={styles.stepContent}>
                  <h3>Comparison</h3>
                  <p>
                    Get standardized results from all platforms in a consistent 
                    format. Compare pricing, reach, and targeting capabilities 
                    side by side.
                  </p>
                  <code className={styles.exampleCode}>
                    Platform A: $12 CPM • 2.3M reach<br />
                    Platform B: $18 CPM • 4.1M reach<br />
                    Platform C: $9 CPM • 1.8M reach
                  </code>
                </div>
              </div>

              <div className={styles.step}>
                <div className={styles.stepNumber}>3</div>
                <div className={styles.stepContent}>
                  <h3>Activation</h3>
                  <p>
                    Launch campaigns across multiple platforms with a single 
                    command. AdCP handles the technical details while maintaining 
                    platform-specific optimizations.
                  </p>
                  <code className={styles.exampleCode}>
                    "Activate on Platform B with $10,000 budget"
                  </code>
                </div>
              </div>

              <div className={styles.step}>
                <div className={styles.stepNumber}>4</div>
                <div className={styles.stepContent}>
                  <h3>Management</h3>
                  <p>
                    Monitor performance, adjust budgets, and generate reports 
                    across all platforms from one interface. Set up automated 
                    rules and alerts.
                  </p>
                  <code className={styles.exampleCode}>
                    "Show performance metrics for all active campaigns"
                  </code>
                </div>
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
    <section className={styles.getStartedSection}>
      <div className="container">
        <div className="row">
          <div className="col col--10 col--offset-1">
            <Heading as="h2" className={styles.sectionTitle}>
              Ready to join the revolution?
            </Heading>
            <p className={styles.sectionSubtitle}>
              Whether you're a platform provider or an advertiser, 
              AdCP is your path to the future of advertising.
            </p>
            
            <div className={styles.audienceCards}>
              <div className={styles.audienceCard}>
                <h3>Platform Providers</h3>
                <p className={styles.audienceDescription}>
                  Make your inventory accessible to every AI assistant and automation platform.
                </p>
                <ul className={styles.audienceList}>
                  <li>Enable AI-powered workflows for your inventory</li>
                  <li>Simplify integration with a standard protocol</li>
                  <li>Reach new customers through automation platforms</li>
                </ul>
                <div className={styles.audienceAction}>
                  <Link className="button button--outline button--lg" to="https://github.com/adcontextprotocol/adcp">
                    Explore the Spec
                  </Link>
                  <p className={styles.actionSubtext}>Open source • MIT licensed</p>
                </div>
              </div>
              
              <div className={styles.audienceCard}>
                <h3>Advertisers & Agencies</h3>
                <p className={styles.audienceDescription}>
                  Start using natural language to manage campaigns across all platforms.
                </p>
                <ul className={styles.audienceList}>
                  <li>Manage campaigns with natural language</li>
                  <li>Access unified analytics across platforms</li>
                  <li>Build on open standards, avoid vendor lock-in</li>
                </ul>
                <div className={styles.audienceAction}>
                  <Link className="button button--primary button--lg" to="/docs/intro">
                    Start Building Today
                  </Link>
                  <p className={styles.actionSubtext}>Documentation & guides</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function CommunityAndSupport() {
  return (
    <section className={styles.communitySection}>
      <div className="container">
        <div className="row">
          <div className="col col--8 col--offset-2 text--center">
            <Heading as="h2" className={styles.sectionTitle}>
              Join the conversation
            </Heading>
            <p className={styles.communityDescription}>
              AdCP is an open standard developed in collaboration with the advertising 
              community. We're building this together, and your input matters.
            </p>
            
            <div className={styles.communityFeatures}>
              <div className={styles.communityFeature}>
                <h3>Open Development</h3>
                <p>
                  All development happens in the open on GitHub. 
                  Watch progress, submit issues, and contribute code.
                </p>
              </div>
              <div className={styles.communityFeature}>
                <h3>Working Group</h3>
                <p>
                  Join monthly meetings to discuss protocol evolution, 
                  implementation challenges, and future directions.
                </p>
              </div>
              <div className={styles.communityFeature}>
                <h3>Implementation Support</h3>
                <p>
                  Get help implementing AdCP for your platform or 
                  building tools that use the protocol.
                </p>
              </div>
            </div>
            
            <div className={styles.communityActions}>
              <Link className="button button--primary button--lg margin-right--md" to="https://github.com/adcontextprotocol/adcp">
                Star on GitHub
              </Link>
              <Link className="button button--outline button--secondary button--lg" to="https://github.com/adcontextprotocol/adcp/discussions">
                Join Discussions
              </Link>
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
      title="AdCP - Open Standard for Advertising Workflows"
      description="AdCP is an open protocol that unifies advertising platforms through a single interface, enabling natural language interactions and automated workflows.">
      <HomepageHeader />
      <main>
        <TheProblem />
        <TheSolution />
        <HowItWorks />
        <GetStarted />
        <CommunityAndSupport />
      </main>
    </Layout>
  );
}
