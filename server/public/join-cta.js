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

    .join-cta-invoice-link {
      display: block;
      text-align: center;
      margin-top: var(--space-3);
      font-size: var(--text-sm);
      color: var(--color-text-secondary);
    }

    .join-cta-invoice-link a,
    .join-cta-invoice-link button {
      color: var(--aao-primary);
      text-decoration: underline;
      background: none;
      border: none;
      padding: 0;
      font: inherit;
      cursor: pointer;
    }

    .join-cta-invoice-link a:hover,
    .join-cta-invoice-link button:hover {
      color: var(--aao-primary-light);
    }

    /* Invoice Request Modal */
    .invoice-modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--color-surface-overlay);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: var(--space-4);
    }

    .invoice-modal {
      background: var(--color-bg-card);
      border-radius: var(--radius-lg);
      max-width: 500px;
      width: 100%;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: var(--shadow-xl);
    }

    .invoice-modal-header {
      padding: var(--space-5);
      border-bottom: var(--border-1) solid var(--color-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .invoice-modal-header h2 {
      margin: 0;
      font-size: var(--text-xl);
      color: var(--color-text-heading);
    }

    .invoice-modal-close {
      background: none;
      border: none;
      font-size: var(--text-2xl);
      color: var(--color-text-muted);
      cursor: pointer;
      padding: 0;
      line-height: 1;
    }

    .invoice-modal-close:hover {
      color: var(--color-text);
    }

    .invoice-modal-body {
      padding: var(--space-5);
    }

    .invoice-form-group {
      margin-bottom: var(--space-4);
    }

    .invoice-form-group label {
      display: block;
      font-size: var(--text-sm);
      font-weight: var(--font-medium);
      color: var(--color-text);
      margin-bottom: var(--space-1);
    }

    .invoice-form-group input,
    .invoice-form-group select {
      width: 100%;
      padding: var(--space-2) var(--space-3);
      border: var(--border-1) solid var(--color-border);
      border-radius: var(--radius-md);
      font-size: var(--text-base);
      background: var(--color-bg-card);
      color: var(--color-text);
    }

    .invoice-form-group input:focus,
    .invoice-form-group select:focus {
      outline: none;
      border-color: var(--aao-primary);
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }

    .invoice-form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-3);
    }

    .invoice-form-error {
      color: var(--color-error-600);
      font-size: var(--text-sm);
      margin-top: var(--space-1);
    }

    .invoice-modal-footer {
      padding: var(--space-4) var(--space-5);
      border-top: var(--border-1) solid var(--color-border);
      display: flex;
      gap: var(--space-3);
      justify-content: flex-end;
    }

    .invoice-modal-footer .btn {
      min-width: 120px;
    }

    .invoice-success {
      text-align: center;
      padding: var(--space-6);
    }

    .invoice-success-icon {
      font-size: 48px;
      margin-bottom: var(--space-4);
    }

    .invoice-success h3 {
      color: var(--color-success-600);
      margin-bottom: var(--space-2);
    }

    .invoice-success p {
      color: var(--color-text-secondary);
      margin-bottom: var(--space-4);
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
 * For logged-in users with a revenue tier, shows personalized pricing
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

  // Determine if we should show personalized pricing for company
  // Revenue tiers indicating under $5M: 'under_1m', '1m_5m'
  const isUnder5m = userContext.revenueTier && ['under_1m', '1m_5m'].includes(userContext.revenueTier);
  const isOver5m = userContext.revenueTier && !isUnder5m;
  const showPersonalizedCompanyPrice = userContext.isLoggedIn && !userContext.isPersonal && userContext.revenueTier;

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

  // Build company pricing HTML based on user context
  let companyPricingHtml;
  if (showPersonalizedCompanyPrice) {
    // Show single personalized price
    const price = isUnder5m ? priceUnder5m : price5m;
    const label = isUnder5m ? 'Under $5M annual revenue' : '$5M+ annual revenue';
    companyPricingHtml = `
      <div class="join-cta-pricing-tier" style="padding-bottom: var(--space-4); margin-bottom: var(--space-4); border-bottom: var(--border-1) solid var(--color-border);">
        <div class="join-cta-pricing-label">${label}</div>
        <div class="join-cta-pricing-amount">${price}<span class="join-cta-pricing-period">/year</span></div>
      </div>
    `;
  } else {
    // Show both tiers
    companyPricingHtml = `
      <div class="join-cta-pricing-tier">
        <div class="join-cta-pricing-label">$5M+ annual revenue</div>
        <div class="join-cta-pricing-amount">${price5m}<span class="join-cta-pricing-period">/year</span></div>
      </div>
      <div class="join-cta-pricing-secondary">
        <div class="join-cta-pricing-secondary-label">Under $5M annual revenue</div>
        <div class="join-cta-pricing-secondary-amount">${priceUnder5m}<span class="join-cta-pricing-period">/year</span></div>
      </div>
    `;
  }

  // Determine CTA button URL and text based on login status
  const companyCta = userContext.isLoggedIn && userContext.orgId
    ? { url: `/dashboard/membership?org=${userContext.orgId}`, text: 'Complete Membership' }
    : { url: '/auth/signup?return_to=/onboarding?signup=true', text: 'Join as a Company' };

  const individualCta = userContext.isLoggedIn
    ? { url: '/dashboard/membership', text: 'Complete Membership' }
    : { url: '/auth/signup?return_to=/onboarding?signup=true', text: 'Join as an Individual' };

  // Industry Council Leader is always a high-touch sale - always use mailto
  const councilLeaderCta = { url: 'mailto:membership@agenticadvertising.org?subject=Industry%20Council%20Leader%20Membership', text: 'Contact Us' };

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
          <a href="${councilLeaderCta.url}" class="btn btn-primary">${councilLeaderCta.text}</a>
        </div>
        <p class="join-cta-invoice-link">
          Need an invoice for a PO? <button type="button" onclick="openInvoiceRequestModal({ customerType: 'company', selectedProduct: 'aao_membership_industry_council_leader_50000' })">Request an invoice</button>
        </p>
        <p class="join-cta-card-footer">For organizations shaping industry direction</p>
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
          <a href="${companyCta.url}" class="btn btn-primary">${companyCta.text}</a>
        </div>
        <p class="join-cta-invoice-link">
          Need an invoice for a PO? <button type="button" onclick="openInvoiceRequestModal()">Request an invoice</button>
        </p>
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
          <a href="${individualCta.url}" class="btn btn-primary">${individualCta.text}</a>
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

    // Fetch billing info for revenue tier and subscription status
    let revenueTier = null;
    let isPersonal = org.is_personal;
    let isMember = false;
    try {
      const billingResponse = await fetch(`/api/organizations/${org.id}/billing`, { credentials: 'include' });
      if (billingResponse.ok) {
        const billingData = await billingResponse.json();
        revenueTier = billingData.revenue_tier;
        isPersonal = billingData.is_personal ?? isPersonal;
        isMember = billingData.subscription?.status === 'active';
      }
    } catch (billingError) {
      // Billing fetch failed, proceed without revenue tier
      console.warn('Could not fetch billing info for pricing personalization');
    }

    userContextCache = {
      isLoggedIn: true,
      orgId: org.id,
      orgName: org.name,
      isPersonal: isPersonal,
      revenueTier: revenueTier,
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

/**
 * Escape HTML special characters to prevent XSS (for invoice modal)
 */
function escapeHtmlForInvoice(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

/**
 * Open the invoice request modal
 * @param {Object} options - Optional configuration
 * @param {string} options.companyName - Pre-fill company name
 * @param {string} options.selectedProduct - Pre-select a product by lookup_key
 * @param {string} options.customerType - Filter products by customer type (e.g., 'company', 'individual')
 * @param {string} options.revenueTier - Filter products by revenue tier
 */
async function openInvoiceRequestModal(options = {}) {
  // Ensure styles are injected
  injectJoinCtaStyles();

  // Remove any existing modal
  const existingModal = document.getElementById('invoiceRequestModal');
  if (existingModal) {
    existingModal.remove();
  }

  // Fetch products from API with filtering if provided
  let url = '/api/billing-products?category=membership';
  if (options.customerType) {
    url += `&customer_type=${encodeURIComponent(options.customerType)}`;
  }
  if (options.revenueTier) {
    url += `&revenue_tier=${encodeURIComponent(options.revenueTier)}`;
  }

  let membershipProducts = [];
  try {
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      membershipProducts = data.products || [];
    }
  } catch (error) {
    console.error('Error fetching products:', error);
  }

  // Generate product options HTML
  // Filter to subscription products only (excludes legacy one-time invoice products)
  let productOptionsHtml = '<option value="">Select a product...</option>';
  if (membershipProducts.length > 0) {
    const subscriptionProducts = membershipProducts.filter(p => p.billing_type === 'subscription');
    for (const product of subscriptionProducts) {
      const price = formatCurrency(product.amount_cents, product.currency);
      const selected = options.selectedProduct === product.lookup_key ? ' selected' : '';
      const escapedLookupKey = escapeHtmlForInvoice(product.lookup_key);
      const escapedDisplayName = escapeHtmlForInvoice(product.display_name);
      productOptionsHtml += `<option value="${escapedLookupKey}"${selected}>${escapedDisplayName} - ${price}/year</option>`;
    }
  } else {
    // Fallback if no products configured in Stripe
    productOptionsHtml += '<option value="" disabled>No products available - please contact finance@agenticadvertising.org</option>';
  }

  // Escape company name for HTML attribute
  const companyNameValue = escapeHtmlForInvoice(options.companyName || '');

  const modalHtml = `
    <div id="invoiceRequestModal" class="invoice-modal-overlay" onclick="if(event.target === this) closeInvoiceRequestModal()">
      <div class="invoice-modal">
        <div class="invoice-modal-header">
          <h2>Request an Invoice</h2>
          <button class="invoice-modal-close" onclick="closeInvoiceRequestModal()" aria-label="Close">&times;</button>
        </div>
        <form id="invoiceRequestForm" onsubmit="submitInvoiceRequest(event)">
          <div class="invoice-modal-body">
            <div class="invoice-form-group">
              <label for="invoice-company">Company Name *</label>
              <input type="text" id="invoice-company" name="companyName" required placeholder="Acme Corporation" value="${companyNameValue}">
            </div>

            <div class="invoice-form-row">
              <div class="invoice-form-group">
                <label for="invoice-contact">Contact Name *</label>
                <input type="text" id="invoice-contact" name="contactName" required placeholder="John Smith">
              </div>
              <div class="invoice-form-group">
                <label for="invoice-email">Billing Email *</label>
                <input type="email" id="invoice-email" name="contactEmail" required placeholder="billing@acme.com">
              </div>
            </div>

            <div class="invoice-form-group">
              <label for="invoice-product">Product *</label>
              <select id="invoice-product" name="lookupKey" required>
                ${productOptionsHtml}
              </select>
            </div>

            <div class="invoice-form-group">
              <label for="invoice-address1">Billing Address Line 1 *</label>
              <input type="text" id="invoice-address1" name="line1" required placeholder="123 Main Street">
            </div>

            <div class="invoice-form-group">
              <label for="invoice-address2">Billing Address Line 2</label>
              <input type="text" id="invoice-address2" name="line2" placeholder="Suite 100">
            </div>

            <div class="invoice-form-row">
              <div class="invoice-form-group">
                <label for="invoice-city">City *</label>
                <input type="text" id="invoice-city" name="city" required placeholder="San Francisco">
              </div>
              <div class="invoice-form-group">
                <label for="invoice-state">State/Province *</label>
                <input type="text" id="invoice-state" name="state" required placeholder="CA">
              </div>
            </div>

            <div class="invoice-form-row">
              <div class="invoice-form-group">
                <label for="invoice-postal">Postal Code *</label>
                <input type="text" id="invoice-postal" name="postal_code" required placeholder="94105">
              </div>
              <div class="invoice-form-group">
                <label for="invoice-country">Country *</label>
                <input type="text" id="invoice-country" name="country" required value="US" placeholder="US">
              </div>
            </div>

            <div id="invoiceFormError" class="invoice-form-error" style="display: none;"></div>
          </div>
          <div class="invoice-modal-footer">
            <button type="button" class="btn btn-secondary" onclick="closeInvoiceRequestModal()">Cancel</button>
            <button type="submit" class="btn btn-primary" id="invoiceSubmitBtn">Send Invoice</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  // Focus first input
  setTimeout(() => {
    document.getElementById('invoice-company')?.focus();
  }, 100);
}

/**
 * Close the invoice request modal
 */
function closeInvoiceRequestModal() {
  const modal = document.getElementById('invoiceRequestModal');
  if (modal) {
    modal.remove();
  }
}

/**
 * Submit the invoice request form
 */
async function submitInvoiceRequest(event) {
  event.preventDefault();

  const form = event.target;
  const submitBtn = document.getElementById('invoiceSubmitBtn');
  const errorDiv = document.getElementById('invoiceFormError');

  // Disable button and show loading state
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending...';
  errorDiv.style.display = 'none';

  const formData = new FormData(form);

  const requestData = {
    companyName: formData.get('companyName'),
    contactName: formData.get('contactName'),
    contactEmail: formData.get('contactEmail'),
    lookupKey: formData.get('lookupKey'),
    billingAddress: {
      line1: formData.get('line1'),
      line2: formData.get('line2') || undefined,
      city: formData.get('city'),
      state: formData.get('state'),
      postal_code: formData.get('postal_code'),
      country: formData.get('country'),
    },
  };

  try {
    const response = await fetch('/api/invoice-request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestData),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to send invoice');
    }

    // Show success state
    const modalBody = document.querySelector('.invoice-modal-body');
    const modalFooter = document.querySelector('.invoice-modal-footer');

    modalBody.innerHTML = `
      <div class="invoice-success">
        <div class="invoice-success-icon">&#9989;</div>
        <h3>Invoice Sent!</h3>
        <p>We've sent an invoice to <strong>${requestData.contactEmail}</strong>. Please check your email for payment instructions.</p>
        <p style="font-size: var(--text-sm);">The invoice is due within 30 days. You can pay online via the link in the email.</p>
      </div>
    `;

    modalFooter.innerHTML = `
      <button type="button" class="btn btn-primary" onclick="closeInvoiceRequestModal()">Done</button>
    `;

  } catch (error) {
    // Show error
    errorDiv.textContent = error.message || 'Something went wrong. Please try again or contact finance@agenticadvertising.org';
    errorDiv.style.display = 'block';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Send Invoice';
  }
}
