/**
 * Shared Join CTA component for membership pages
 * Provides consistent styling and benefits across membership.html and members.html
 */

function injectJoinCtaStyles() {
  if (document.getElementById('join-cta-styles')) return;

  const style = document.createElement('style');
  style.id = 'join-cta-styles';
  style.textContent = `
    /* =============================================================================
       Join CTA Component - Shared styles for membership boxes
       ============================================================================= */

    .join-cta-section {
      background: var(--color-bg-page);
      padding: var(--space-10) var(--space-5);
    }

    .join-cta-container {
      max-width: var(--container-lg);
      margin: 0 auto;
    }

    .join-cta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: var(--space-6);
    }

    .join-cta-card {
      background: var(--color-bg-card);
      border-radius: var(--radius-lg);
      padding: var(--space-6);
      border: 3px solid var(--color-border);
      transition: var(--transition-all);
    }

    .join-cta-card:hover {
      border-color: var(--aao-primary);
      box-shadow: var(--shadow-lg);
    }

    .join-cta-card-header {
      text-align: center;
      padding-bottom: 0;
      border-bottom: none;
    }

    .join-cta-card-title {
      font-size: var(--text-2xl);
      font-weight: var(--font-bold);
      color: var(--aao-black);
      margin-bottom: var(--space-4);
    }

    .join-cta-pricing-tier {
      text-align: center;
      margin-bottom: var(--space-2);
    }

    .join-cta-pricing-label {
      font-size: var(--text-sm);
      color: var(--color-text-secondary);
      margin-bottom: var(--space-1);
    }

    .join-cta-pricing-amount {
      font-size: var(--text-4xl);
      font-weight: var(--font-bold);
      color: var(--aao-primary);
    }

    .join-cta-pricing-amount .currency {
      font-size: var(--text-xl);
      vertical-align: super;
    }

    .join-cta-pricing-period {
      font-size: var(--text-base);
      font-weight: normal;
      color: var(--color-text-muted);
    }

    .join-cta-pricing-secondary {
      text-align: center;
      margin-bottom: var(--space-4);
      padding-bottom: var(--space-4);
      border-bottom: var(--border-1) solid var(--color-border);
    }

    .join-cta-pricing-secondary-label {
      font-size: var(--text-sm);
      color: var(--color-text-secondary);
    }

    .join-cta-pricing-secondary-amount {
      font-size: var(--text-xl);
      font-weight: var(--font-bold);
      color: var(--aao-primary);
    }

    .join-cta-benefits-header {
      font-weight: var(--font-semibold);
      color: var(--aao-black);
      margin-bottom: var(--space-3);
    }

    .join-cta-benefits-list {
      list-style: none;
      padding: 0;
      margin: 0 0 var(--space-5) 0;
    }

    .join-cta-benefits-list li {
      padding: var(--space-2) 0;
      color: var(--aao-gray-dark);
      font-size: var(--text-sm);
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
    }

    .join-cta-benefits-list li::before {
      content: '\\2713';
      color: var(--color-success-600);
      font-weight: var(--font-bold);
      flex-shrink: 0;
    }

    /* Button wrapper - uses design system .btn classes */
    .join-cta-button-wrapper {
      text-align: center;
    }

    .join-cta-button-wrapper .btn {
      width: 100%;
      font-size: var(--text-lg);
      padding: var(--space-4);
    }

    .join-cta-card-footer {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      text-align: center;
      margin-top: var(--space-3);
    }

    .join-cta-founding-note {
      text-align: center;
      margin-top: var(--space-6);
      color: var(--color-warning-600);
      font-weight: var(--font-semibold);
      font-size: var(--text-sm);
    }

    .join-cta-contact {
      text-align: center;
      margin-top: var(--space-3);
      color: var(--color-text-secondary);
      font-size: var(--text-sm);
    }

    .join-cta-contact a {
      color: var(--aao-primary);
    }

    @media (max-width: 768px) {
      .join-cta-grid {
        grid-template-columns: 1fr;
      }

      .join-cta-pricing-amount {
        font-size: var(--text-3xl);
      }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Render the unified join CTA component
 * @param {Object} options - Configuration options
 * @param {string} options.containerId - ID of the container element
 * @param {boolean} options.showFoundingNote - Whether to show founding member note (default: true)
 * @param {boolean} options.showContactLine - Whether to show contact email (default: true)
 */
function renderJoinCta(options = {}) {
  const {
    containerId = 'join-cta-container',
    showFoundingNote = true,
    showContactLine = true
  } = options;

  const container = document.getElementById(containerId);
  if (!container) {
    console.warn('Join CTA container not found:', containerId);
    return;
  }

  injectJoinCtaStyles();

  const companyBenefits = [
    'Eligibility to serve on Board',
    'Right to vote for Board',
    'Help build standards, practices, protocols, and policies',
    'Right to vote on standards adoption',
    'Serve on interim Advisory Council',
    'Participate in working groups',
    'All team members can participate in association activities'
  ];

  const individualBenefits = [
    'Help build standards, practices, protocols, and policies',
    'Eligible for professional development and certification courses',
    'Personal listing in member directory',
    'Working group participation',
    'Community Slack access',
    'Event discounts and early access',
    'Newsletter and industry updates'
  ];

  container.innerHTML = `
    <div class="join-cta-grid">
      <!-- Company Membership -->
      <div class="join-cta-card">
        <div class="join-cta-card-header">
          <div class="join-cta-card-title">Company Membership</div>
        </div>
        <div class="join-cta-pricing-tier">
          <div class="join-cta-pricing-label">$5M+ annual revenue</div>
          <div class="join-cta-pricing-amount"><span class="currency">$</span>10,000<span class="join-cta-pricing-period">/year</span></div>
        </div>
        <div class="join-cta-pricing-secondary">
          <div class="join-cta-pricing-secondary-label">Under $5M annual revenue</div>
          <div class="join-cta-pricing-secondary-amount">$2,500<span class="join-cta-pricing-period">/year</span></div>
        </div>

        <div class="join-cta-benefits-header">Company Membership Benefits</div>
        <ul class="join-cta-benefits-list">
          ${companyBenefits.map(b => `<li>${b}</li>`).join('')}
        </ul>

        <div class="join-cta-button-wrapper">
          <a href="/auth/signup?return_to=/onboarding?signup=true" class="btn btn-primary">Join as a Company</a>
        </div>
        <p class="join-cta-card-footer">Open to brands, publishers, agencies, and technology providers</p>
      </div>

      <!-- Individual Membership -->
      <div class="join-cta-card">
        <div class="join-cta-card-header">
          <div class="join-cta-card-title">Individual Membership</div>
        </div>
        <div class="join-cta-pricing-tier">
          <div class="join-cta-pricing-label">Industry professionals</div>
          <div class="join-cta-pricing-amount"><span class="currency">$</span>250<span class="join-cta-pricing-period">/year</span></div>
        </div>
        <div class="join-cta-pricing-secondary">
          <div class="join-cta-pricing-secondary-label">Students, academics & non-profits</div>
          <div class="join-cta-pricing-secondary-amount">$50<span class="join-cta-pricing-period">/year</span></div>
        </div>

        <div class="join-cta-benefits-header">Individual Membership Benefits</div>
        <ul class="join-cta-benefits-list">
          ${individualBenefits.map(b => `<li>${b}</li>`).join('')}
        </ul>

        <div class="join-cta-button-wrapper">
          <a href="/auth/signup?return_to=/onboarding?signup=true" class="btn btn-primary">Join as an Individual</a>
        </div>
        <p class="join-cta-card-footer">For consultants, professionals, and enthusiasts</p>
      </div>
    </div>

    ${showFoundingNote ? `
      <p class="join-cta-founding-note">
        Founding member pricing available through March 31, 2026
      </p>
    ` : ''}

    ${showContactLine ? `
      <p class="join-cta-contact">
        Questions? Contact us at <a href="mailto:membership@agenticadvertising.org">membership@agenticadvertising.org</a>
      </p>
    ` : ''}
  `;
}
