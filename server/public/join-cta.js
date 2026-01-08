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

    .join-cta-grid--three {
      grid-template-columns: repeat(3, 1fr);
      max-width: var(--container-xl);
      margin: 0 auto;
    }

    .join-cta-card {
      background: var(--color-bg-card);
      border-radius: var(--radius-lg);
      padding: var(--space-6);
      border: 3px solid var(--color-border);
      transition: var(--transition-all);
      position: relative;
    }

    .join-cta-card:hover {
      border-color: var(--aao-primary);
      box-shadow: var(--shadow-lg);
    }

    .join-cta-card--featured {
      border-color: var(--aao-primary);
      background: linear-gradient(135deg, var(--color-primary-50) 0%, var(--color-bg-card) 100%);
    }

    .join-cta-featured-badge {
      position: absolute;
      top: calc(-1 * var(--space-3));
      left: 50%;
      transform: translateX(-50%);
      background: var(--aao-primary);
      color: white;
      padding: var(--space-1) var(--space-4);
      border-radius: var(--radius-full);
      font-size: var(--text-xs);
      font-weight: var(--font-bold);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      white-space: nowrap;
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

    .join-cta-custom-packages {
      text-align: center;
      margin-top: var(--space-4);
      color: var(--color-text-secondary);
      font-size: var(--text-sm);
    }

    .join-cta-custom-packages a {
      color: var(--aao-primary);
      font-weight: var(--font-medium);
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

    /* Member Confirmation (for existing members) */
    .join-cta-member-confirmed {
      background: linear-gradient(135deg, var(--color-success-50) 0%, var(--color-success-100) 100%);
      border: 2px solid var(--color-success-500);
      border-radius: var(--radius-lg);
      padding: var(--space-8);
      text-align: center;
      max-width: 600px;
      margin: 0 auto;
    }

    .join-cta-member-badge {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      background: var(--color-success-600);
      color: white;
      padding: var(--space-2) var(--space-4);
      border-radius: var(--radius-full);
      font-size: var(--text-lg);
      font-weight: var(--font-bold);
      margin-bottom: var(--space-4);
    }

    .join-cta-member-checkmark {
      font-size: var(--text-xl);
    }

    .join-cta-member-thanks {
      color: var(--color-success-700);
      font-size: var(--text-base);
      line-height: var(--leading-relaxed);
      margin-bottom: var(--space-6);
    }

    .join-cta-member-benefits {
      background: white;
      border-radius: var(--radius-md);
      padding: var(--space-5);
      text-align: left;
      margin-bottom: var(--space-6);
    }

    .join-cta-member-benefits h4 {
      color: var(--color-success-700);
      font-size: var(--text-base);
      font-weight: var(--font-semibold);
      margin: 0 0 var(--space-3) 0;
    }

    .join-cta-member-actions {
      display: flex;
      gap: var(--space-3);
      justify-content: center;
      flex-wrap: wrap;
    }

    .join-cta-member-actions .btn {
      min-width: 160px;
    }

    @media (max-width: 1024px) {
      .join-cta-grid--three {
        grid-template-columns: 1fr;
        max-width: var(--container-sm);
      }
    }

    @media (max-width: 768px) {
      .join-cta-grid {
        grid-template-columns: 1fr;
      }

      .join-cta-grid--three {
        max-width: 100%;
      }

      .join-cta-pricing-amount {
        font-size: var(--text-3xl);
      }

      .join-cta-member-actions {
        flex-direction: column;
      }

      .join-cta-member-actions .btn {
        width: 100%;
      }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Render the unified join CTA component
 * Fetches pricing from Stripe via API for single source of truth
 * @param {Object} options - Configuration options
 * @param {string} options.containerId - ID of the container element
 * @param {boolean} options.showFoundingNote - Whether to show founding member note (default: true)
 * @param {boolean} options.showContactLine - Whether to show contact email (default: true)
 */
async function renderJoinCta(options = {}) {
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

  // Check if user is logged in and get their org info
  const userContext = await fetchUserContext();

  // If user is already a member, show a different message
  if (userContext.isMember) {
    container.innerHTML = renderMemberConfirmation(userContext, showContactLine);
    return;
  }

  // Fetch pricing from Stripe
  const products = await fetchBillingProducts();

  // Find specific products by lookup key (subscription versions for display)
  const industryCouncilLeader = products.find(p => p.lookup_key === 'aao_membership_industry_council_leader_50000');
  const corporate5m = products.find(p => p.lookup_key === 'aao_membership_corporate_5m');
  const corporateUnder5m = products.find(p => p.lookup_key === 'aao_membership_corporate_under5m');
  const individual = products.find(p => p.lookup_key === 'aao_membership_individual');
  const individualDiscounted = products.find(p => p.lookup_key === 'aao_membership_individual_discounted');

  // Format prices (fallback to defaults if API fails)
  const priceCouncilLeader = industryCouncilLeader ? formatCurrency(industryCouncilLeader.amount_cents, industryCouncilLeader.currency) : '$50,000';
  const price5m = corporate5m ? formatCurrency(corporate5m.amount_cents, corporate5m.currency) : '$10,000';
  const priceUnder5m = corporateUnder5m ? formatCurrency(corporateUnder5m.amount_cents, corporateUnder5m.currency) : '$2,500';
  const priceIndividual = individual ? formatCurrency(individual.amount_cents, individual.currency) : '$250';
  const priceDiscounted = individualDiscounted ? formatCurrency(individualDiscounted.amount_cents, individualDiscounted.currency) : '$50';

  // Always show all price tiers - no personalization

  const industryCouncilBenefits = [
    'Seat on Industry Council with strategic input on roadmap',
    'Speaking opportunities at key industry events',
    'Priority attendance at flagship events',
    'Featured recognition on website and at events',
    'All Company Membership benefits included'
  ];

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

  // Always show both company tiers
  const companyPricingHtml = `
    <div class="join-cta-pricing-tier">
      <div class="join-cta-pricing-label">$5M+ annual revenue</div>
      <div class="join-cta-pricing-amount">${price5m}<span class="join-cta-pricing-period">/year</span></div>
    </div>
    <div class="join-cta-pricing-secondary">
      <div class="join-cta-pricing-secondary-label">Under $5M annual revenue</div>
      <div class="join-cta-pricing-secondary-amount">${priceUnder5m}<span class="join-cta-pricing-period">/year</span></div>
    </div>
  `;

  // All tiers use the same signup flow
  const signupUrl = userContext.isLoggedIn
    ? `/dashboard/membership${userContext.orgId ? `?org=${userContext.orgId}` : ''}`
    : '/auth/signup?return_to=/onboarding?signup=true';

  container.innerHTML = `
    <div class="join-cta-grid join-cta-grid--three">
      <!-- Industry Council Leader -->
      <div class="join-cta-card join-cta-card--featured">
        <div class="join-cta-featured-badge" aria-hidden="true">Industry Leadership</div>
        <div class="join-cta-card-header">
          <div class="join-cta-card-title">Industry Council Leader</div>
        </div>
        <div class="join-cta-pricing-tier" style="padding-bottom: var(--space-4); margin-bottom: var(--space-4); border-bottom: var(--border-1) solid var(--color-border);">
          <div class="join-cta-pricing-label">For industry-leading organizations</div>
          <div class="join-cta-pricing-amount">${priceCouncilLeader}<span class="join-cta-pricing-period">/year</span></div>
        </div>

        <div class="join-cta-benefits-header">Industry Council Benefits</div>
        <ul class="join-cta-benefits-list">
          ${industryCouncilBenefits.map(b => `<li>${b}</li>`).join('')}
        </ul>

        <div class="join-cta-button-wrapper">
          <a href="${signupUrl}" class="btn btn-primary">Sign Up Now</a>
        </div>
        <p class="join-cta-card-footer">
          Questions? <a href="mailto:membership@agenticadvertising.org">Contact us</a>
        </p>
      </div>

      <!-- Company Membership -->
      <div class="join-cta-card">
        <div class="join-cta-card-header">
          <div class="join-cta-card-title">Company Membership</div>
        </div>
        ${companyPricingHtml}

        <div class="join-cta-benefits-header">Company Membership Benefits</div>
        <ul class="join-cta-benefits-list">
          ${companyBenefits.map(b => `<li>${b}</li>`).join('')}
        </ul>

        <div class="join-cta-button-wrapper">
          <a href="${signupUrl}" class="btn btn-primary">Sign Up Now</a>
        </div>
        <p class="join-cta-card-footer">Open to brands, publishers, agencies, and ad tech providers</p>
      </div>

      <!-- Individual Membership -->
      <div class="join-cta-card">
        <div class="join-cta-card-header">
          <div class="join-cta-card-title">Individual Membership</div>
        </div>
        <div class="join-cta-pricing-tier">
          <div class="join-cta-pricing-label">Industry professionals</div>
          <div class="join-cta-pricing-amount">${priceIndividual}<span class="join-cta-pricing-period">/year</span></div>
        </div>
        <div class="join-cta-pricing-secondary">
          <div class="join-cta-pricing-secondary-label">Students, academics & non-profits</div>
          <div class="join-cta-pricing-secondary-amount">${priceDiscounted}<span class="join-cta-pricing-period">/year</span></div>
        </div>

        <div class="join-cta-benefits-header">Individual Membership Benefits</div>
        <ul class="join-cta-benefits-list">
          ${individualBenefits.map(b => `<li>${b}</li>`).join('')}
        </ul>

        <div class="join-cta-button-wrapper">
          <a href="${signupUrl}" class="btn btn-primary">Sign Up Now</a>
        </div>
        <p class="join-cta-card-footer">For consultants, professionals, and enthusiasts</p>
      </div>
    </div>

    ${showFoundingNote ? `
      <p class="join-cta-founding-note">
        Founding member pricing available through March 31, 2026
      </p>
    ` : ''}

    <p class="join-cta-custom-packages">
      Custom membership packages available. <a href="mailto:membership@agenticadvertising.org?subject=Custom%20Membership%20Package">Contact us</a> for more information.
    </p>

    ${showContactLine ? `
      <p class="join-cta-contact">
        Questions? Contact us at <a href="mailto:membership@agenticadvertising.org">membership@agenticadvertising.org</a>
      </p>
    ` : ''}
  `;
}

// Cache for billing products
let billingProductsCache = null;

// Cache for user context
let userContextCache = null;

/**
 * Render confirmation message for existing members
 */
function renderMemberConfirmation(userContext, showContactLine) {
  const isPersonal = userContext.isPersonal;

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

  const benefits = isPersonal ? individualBenefits : companyBenefits;
  const memberType = isPersonal ? 'Individual' : 'Company';

  return `
    <div class="join-cta-member-confirmed">
      <div class="join-cta-member-badge">
        <span class="join-cta-member-checkmark">&#10003;</span>
        <span>You're a Member!</span>
      </div>
      <p class="join-cta-member-thanks">
        Thank you for being a founding member of AgenticAdvertising.org. Your support helps build the future of agentic advertising.
      </p>
      <div class="join-cta-member-benefits">
        <h4>Your ${escapeHtml(memberType)} Member Benefits</h4>
        <ul class="join-cta-benefits-list">
          ${benefits.map(b => `<li>${escapeHtml(b)}</li>`).join('')}
        </ul>
      </div>
      <div class="join-cta-member-actions">
        <a href="/dashboard/membership?org=${encodeURIComponent(userContext.orgId || '')}" class="btn btn-primary">Manage Membership</a>
        <a href="/dashboard/profile?org=${encodeURIComponent(userContext.orgId || '')}" class="btn btn-secondary">View Your Profile</a>
      </div>
    </div>
    ${showContactLine ? `
      <p class="join-cta-contact">
        Questions? Contact us at <a href="mailto:membership@agenticadvertising.org">membership@agenticadvertising.org</a>
      </p>
    ` : ''}
  `;
}

/**
 * Fetch current user context (logged in status, org, revenue tier)
 * Returns empty context if not logged in (silently handles 401)
 */
async function fetchUserContext() {
  if (userContextCache !== null) {
    return userContextCache;
  }

  try {
    const response = await fetch('/api/me', { credentials: 'include' });
    if (!response.ok) {
      // Not logged in or other error - return empty context
      userContextCache = { isLoggedIn: false };
      return userContextCache;
    }

    const data = await response.json();

    // Get the first organization (or selectedOrgId from localStorage)
    const selectedOrgId = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedOrgId') : null;
    const org = data.organizations?.find(o => o.id === selectedOrgId) || data.organizations?.[0];

    if (!org) {
      userContextCache = { isLoggedIn: true, orgId: null, isPersonal: true };
      return userContextCache;
    }

    // Fetch billing info for subscription status
    let isPersonal = org.is_personal;
    let isMember = false;
    try {
      const billingResponse = await fetch(`/api/organizations/${org.id}/billing`, { credentials: 'include' });
      if (billingResponse.ok) {
        const billingData = await billingResponse.json();
        isPersonal = billingData.is_personal ?? isPersonal;
        isMember = billingData.subscription?.status === 'active';
      }
    } catch (billingError) {
      // Billing fetch failed, proceed without subscription info
      console.warn('Could not fetch billing info');
    }

    userContextCache = {
      isLoggedIn: true,
      orgId: org.id,
      orgName: org.name,
      isPersonal: isPersonal,
      isMember: isMember
    };

    return userContextCache;
  } catch (error) {
    console.error('Error fetching user context:', error);
    userContextCache = { isLoggedIn: false };
    return userContextCache;
  }
}

/**
 * Fetch available billing products from the API
 */
async function fetchBillingProducts() {
  if (billingProductsCache) {
    return billingProductsCache;
  }

  try {
    const response = await fetch('/api/billing-products');
    if (!response.ok) {
      throw new Error('Failed to fetch products');
    }
    const data = await response.json();
    billingProductsCache = data.products || [];
    return billingProductsCache;
  } catch (error) {
    console.error('Error fetching billing products:', error);
    return [];
  }
}

/**
 * Format currency amount for display
 */
function formatCurrency(amountCents, currency = 'usd') {
  const amount = amountCents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

