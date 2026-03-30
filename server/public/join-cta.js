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

    .join-cta-grid--four {
      grid-template-columns: repeat(4, 1fr);
      max-width: 1200px;
      margin: 0 auto;
    }

    .join-cta-grid--five {
      grid-template-columns: repeat(5, 1fr);
      max-width: 1400px;
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
      margin-bottom: var(--space-1);
    }

    .join-cta-card-audience {
      font-size: var(--text-sm);
      color: var(--color-text-secondary);
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

      .join-cta-grid--four {
        grid-template-columns: repeat(2, 1fr);
        max-width: var(--container-lg);
      }

      .join-cta-grid--five {
        grid-template-columns: repeat(3, 1fr);
        max-width: var(--container-xl);
      }
    }

    @media (max-width: 900px) {
      .join-cta-grid--five {
        grid-template-columns: repeat(2, 1fr);
        max-width: var(--container-lg);
      }
    }

    @media (max-width: 768px) {
      .join-cta-grid {
        grid-template-columns: 1fr;
      }

      .join-cta-grid--three {
        max-width: 100%;
      }

      .join-cta-grid--four {
        grid-template-columns: 1fr;
        max-width: 100%;
      }

      .join-cta-grid--five {
        grid-template-columns: 1fr;
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
    showFoundingNote = new Date() < new Date('2026-04-01T04:00:00Z'),
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

  // Fetch pricing from Stripe
  const products = await fetchBillingProducts();

  // Use founding-era prices until April 1, 2026 — midnight Eastern (UTC-4)
  const isFoundingPricing = new Date() < new Date('2026-04-01T04:00:00Z');

  // Find specific products by lookup key
  const leaderProduct = products.find(p => p.lookup_key === 'aao_membership_leader_50000');
  const memberProduct = products.find(p => p.lookup_key === (isFoundingPricing ? 'aao_membership_member_10000' : 'aao_membership_member_15000'));
  const builderProduct = products.find(p => p.lookup_key === (isFoundingPricing ? 'aao_membership_builder_2500' : 'aao_membership_builder_3000'));
  const professionalProduct = products.find(p => p.lookup_key === 'aao_membership_professional_250');
  const explorerProduct = products.find(p => p.lookup_key === 'aao_membership_explorer_50');

  // Format prices (fallback to defaults if API fails)
  const priceLeader = escapeHtml(leaderProduct ? formatCurrency(leaderProduct.amount_cents, leaderProduct.currency) : '$50,000');
  const priceMember = escapeHtml(memberProduct ? formatCurrency(memberProduct.amount_cents, memberProduct.currency) : (isFoundingPricing ? '$10,000' : '$15,000'));
  const priceBuilder = escapeHtml(builderProduct ? formatCurrency(builderProduct.amount_cents, builderProduct.currency) : (isFoundingPricing ? '$2,500' : '$3,000'));
  const priceProfessional = escapeHtml(professionalProduct ? formatCurrency(professionalProduct.amount_cents, professionalProduct.currency) : '$250');
  const priceExplorer = escapeHtml(explorerProduct ? formatCurrency(explorerProduct.amount_cents, explorerProduct.currency) : '$50');

  const explorerBenefits = [
    '1 community-only seat — Addie, certification, training',
    'Start your first certification module free',
    'Newsletter and industry updates'
  ];

  const professionalBenefits = [
    '1 contributor seat — includes community access',
    'Slack, working groups, councils, product summit',
    'Voting rights',
    'Directory listing'
  ];

  const builderBenefits = [
    '5 contributor seats — includes community access',
    '5 community-only seats — Addie, certification, training',
    'API access — registry, agent testing, sandbox',
    'Board eligible — voting rights',
    'Marketing opportunities available'
  ];

  const partnerBenefits = [
    '10 contributor seats — includes community access',
    '50 community-only seats — train your whole team',
    'API access — registry, agent testing, sandbox',
    'Featured directory placement',
    'Board eligible — voting rights'
  ];

  const leaderBenefits = [
    '20+ contributor seats — includes community access',
    'Unlimited community-only seats',
    'API access — registry, agent testing, sandbox',
    'Lead councils — chair and set agendas',
    'Board eligible — voting rights',
    'First access to sponsorships, white papers, co-branded research'
  ];

  // All tiers use the same signup flow
  const signupUrl = userContext.isLoggedIn
    ? `/dashboard/membership${userContext.orgId ? `?org=${encodeURIComponent(userContext.orgId)}` : ''}`
    : '/auth/signup?return_to=/onboarding?signup=true';

  // Determine current subscription amount for upgrade logic
  const currentAmountCents = userContext.isMember ? userContext.amountCents : null;

  // Tier amounts for comparison (used when API products aren't available)
  const tierAmounts = {
    explorer: explorerProduct?.amount_cents ?? 5000,
    professional: professionalProduct?.amount_cents ?? 25000,
    builder: builderProduct?.amount_cents ?? 300000,
    member: memberProduct?.amount_cents ?? 1500000,
    leader: leaderProduct?.amount_cents ?? 5000000,
  };

  // Helper to render the CTA button for a tier
  function tierButton(tierKey, defaultUrl, label) {
    if (currentAmountCents == null) {
      // Not a member — show standard signup
      return `<a href="${defaultUrl}" class="btn btn-primary">${label}</a>`;
    }
    const tierAmount = tierAmounts[tierKey];
    if (currentAmountCents >= tierAmount) {
      // Current plan or lower
      if (currentAmountCents === tierAmount) {
        return `<span class="btn btn-secondary" style="pointer-events:none;opacity:0.7;">Current Plan</span>`;
      }
      return '';
    }
    // Higher tier — show upgrade
    const upgradeUrl = `/dashboard/membership${userContext.orgId ? `?org=${encodeURIComponent(userContext.orgId)}` : ''}`;
    return `<a href="${upgradeUrl}" class="btn btn-primary">Upgrade</a>`;
  }

  container.innerHTML = `
    <div class="join-cta-grid join-cta-grid--five">
      <!-- Explorer -->
      <div class="join-cta-card">
        <div class="join-cta-card-header">
          <div class="join-cta-card-title">Explorer</div>
          <div class="join-cta-card-audience">Getting started</div>
        </div>

        <ul class="join-cta-benefits-list">
          ${explorerBenefits.map(b => `<li>${escapeHtml(b)}</li>`).join('')}
        </ul>

        <div class="join-cta-pricing-tier">
          <div class="join-cta-pricing-amount">${priceExplorer}<span class="join-cta-pricing-period">/year</span></div>
        </div>

        <div class="join-cta-button-wrapper">
          ${tierButton('explorer', signupUrl, 'Sign Up Now')}
        </div>
        <p class="join-cta-card-footer">Credit card</p>
      </div>

      <!-- Professional -->
      <div class="join-cta-card">
        <div class="join-cta-card-header">
          <div class="join-cta-card-title">Professional</div>
          <div class="join-cta-card-audience">Working practitioners</div>
        </div>

        <ul class="join-cta-benefits-list">
          ${professionalBenefits.map(b => `<li>${escapeHtml(b)}</li>`).join('')}
        </ul>

        <div class="join-cta-pricing-tier">
          <div class="join-cta-pricing-amount">${priceProfessional}<span class="join-cta-pricing-period">/year</span></div>
        </div>

        <div class="join-cta-button-wrapper">
          ${tierButton('professional', signupUrl, 'Sign Up Now')}
        </div>
        <p class="join-cta-card-footer">Credit card</p>
      </div>

      <!-- Builder -->
      <div class="join-cta-card">
        <div class="join-cta-card-header">
          <div class="join-cta-card-title">Builder</div>
          <div class="join-cta-card-audience">Growing teams &amp; startups</div>
        </div>

        <ul class="join-cta-benefits-list">
          ${builderBenefits.map(b => `<li>${escapeHtml(b)}</li>`).join('')}
        </ul>

        <div class="join-cta-pricing-tier">
          <div class="join-cta-pricing-amount">${priceBuilder}<span class="join-cta-pricing-period">/year</span></div>
        </div>

        <div class="join-cta-button-wrapper">
          ${tierButton('builder', signupUrl, 'Sign Up Now')}
        </div>
        <p class="join-cta-card-footer">Credit card</p>
      </div>

      <!-- Partner -->
      <div class="join-cta-card join-cta-card--featured">
        ${currentAmountCents == null || currentAmountCents < tierAmounts.member ? '<div class="join-cta-featured-badge" aria-hidden="true">Recommended</div>' : ''}
        <div class="join-cta-card-header">
          <div class="join-cta-card-title">Partner</div>
          <div class="join-cta-card-audience">Organizations &amp; established teams</div>
        </div>

        <ul class="join-cta-benefits-list">
          ${partnerBenefits.map(b => `<li>${escapeHtml(b)}</li>`).join('')}
        </ul>

        <div class="join-cta-pricing-tier">
          <div class="join-cta-pricing-amount">${priceMember}<span class="join-cta-pricing-period">/year</span></div>
        </div>

        <div class="join-cta-button-wrapper">
          ${tierButton('member', '/chat?topic=membership&tier=partner', 'Talk to Addie')}
        </div>
        <p class="join-cta-card-footer">Credit card or invoice</p>
      </div>

      <!-- Leader -->
      <div class="join-cta-card">
        <div class="join-cta-card-header">
          <div class="join-cta-card-title">Leader</div>
          <div class="join-cta-card-audience">Industry-shaping organizations</div>
        </div>

        <ul class="join-cta-benefits-list">
          ${leaderBenefits.map(b => `<li>${escapeHtml(b)}</li>`).join('')}
        </ul>

        <div class="join-cta-pricing-tier">
          <div class="join-cta-pricing-amount">${priceLeader}<span class="join-cta-pricing-period">/year</span></div>
        </div>

        <div class="join-cta-button-wrapper">
          ${tierButton('leader', '/chat?topic=membership&tier=leader', 'Talk to Addie')}
        </div>
        <p class="join-cta-card-footer">Credit card or invoice</p>
      </div>
    </div>

    ${showFoundingNote ? `
      <p class="join-cta-founding-note">
        Founding member pricing available through March 31, 2026
      </p>
    ` : ''}

    <p class="join-cta-custom-packages">
      Need more seats or a custom package? <a href="mailto:membership@agenticadvertising.org?subject=Custom%20Membership%20Package">Contact us</a>
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

  const orgBenefits = [
    'Contributor seats — includes community access',
    'Community-only seats — Addie, certification, training',
    'API access',
    'Board eligible — voting rights',
    'Directory listing'
  ];

  const individualBenefits = [
    'Contributor seat — includes community access',
    'Slack, working groups, councils, product summit',
    'Voting rights',
    'Directory listing'
  ];

  const benefits = isPersonal ? individualBenefits : orgBenefits;
  const memberType = isPersonal ? 'Individual' : 'Organization';

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
    let amountCents = null;
    try {
      const billingResponse = await fetch(`/api/organizations/${org.id}/billing`, { credentials: 'include' });
      if (billingResponse.ok) {
        const billingData = await billingResponse.json();
        isPersonal = billingData.is_personal ?? isPersonal;
        isMember = billingData.subscription?.status === 'active';
        amountCents = billingData.subscription?.amount_cents ?? null;
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
      isMember: isMember,
      amountCents: amountCents
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

