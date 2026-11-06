(() => {
  const form = document.getElementById('trust-lookup-form');
  const input = document.getElementById('trust-domain');
  const button = form.querySelector('button');
  const status = document.getElementById('trust-lookup-status');
  const result = document.getElementById('trust-lookup-result');
  let requestNumber = 0;
  let controller;

  // Every origin-controlled string is rendered as text, including domains,
  // scope tokens and agent URLs. Nothing fetched becomes HTML or script.
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function link(text, url, className) {
    const element = node('a', text, className);
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) element.href = parsed.href;
    return element;
  }

  function field(list, label, value) {
    list.append(node('dt', label), node('dd', value));
  }

  function render(data) {
    result.replaceChildren();
    const titles = {
      published: 'trust.json is published',
      not_found: 'trust.json not implemented',
      unavailable: 'We couldn’t check this one right now',
      unverified_parent: 'Parent company not confirmed',
    };
    result.dataset.state = data.status;
    result.append(node('p', data.domain, 'trust-result-domain'));
    const heading = node('h2', titles[data.status] || titles.unavailable);
    heading.id = 'trust-result-heading';
    result.append(heading, node('p', data.message));

    const facts = node('dl', undefined, 'trust-result-facts');
    if (data.authority_domain) field(facts, 'Authority domain', data.authority_domain);
    if (data.parent_domain && data.status !== 'unverified_parent') field(facts, 'Brand relationship', `Via ${data.parent_domain}`);
    if (data.parent_domain && data.status === 'unverified_parent') field(facts, 'Claimed parent', data.parent_domain);
    if (data.parent_domain && data.relationship_verified_at) field(facts, 'Parent verified', new Date(data.relationship_verified_at).toLocaleString());
    if (data.brand_name) field(facts, 'Brand', data.brand_name);
    field(facts, 'Checked', new Date(data.checked_at).toLocaleString());
    result.append(facts);

    if (data.status === 'published') renderPermissions(data);

    const actions = node('div', undefined, 'trust-result-actions');
    // The claim target is fixed by this site, not by fetched record contents.
    actions.append(link(data.status === 'not_found' ? 'Claim this brand' : 'Claim or manage this brand',
      `https://agenticadvertising.org/brand/builder?domain=${encodeURIComponent(data.domain)}`, 'btn btn-primary'));
    if (data.record_url) actions.append(link('View record location', data.record_url));
    actions.append(link('How to publish one', 'https://trustjson.org/#publish'));
    result.append(actions);
    if (data.status === 'not_found') {
      result.append(node('p', 'Is this your brand? Claim it, then publish your list so sellers that check can tell your partners from impostors.', 'trust-result-note'));
    }
    result.append(node('p', 'Results can be up to a minute old.', 'trust-result-note'));
    result.hidden = false;
    result.focus({ preventScroll: true });
    result.scrollIntoView({ block: 'start' });
  }

  function renderPermissions(data) {
    const coverage = data.exclusive_grants
      ? 'Exclusive. Sellers that check turn away agencies not on this list.'
      : 'Not exclusive. Sellers may also have their own verified approvals.';
    result.append(node('p', coverage, 'trust-result-coverage'));
    result.append(node('h3', data.brand_id ? 'Who can act for this brand' : 'Who can act for this company'));
    if (!data.grants.length) {
      result.append(node('p', 'No agencies or platforms are listed for this brand. Sellers may still have private approvals, and the brand’s own agents may still act for it.'));
    }
    const grants = node('div', undefined, 'trust-result-grants');
    for (const grant of data.grants) {
      const card = node('article', undefined, 'trust-result-grant');
      const header = node('div', undefined, 'trust-grant-header');
      header.append(node('h4', grant.grantee));
      const badge = node('span', {
        active: 'Active', expired: 'Expired', scheduled: 'Not yet active', invalid: 'Invalid grant',
      }[grant.status] || 'Not verified', 'trust-grant-status');
      badge.dataset.state = grant.status;
      header.append(badge);
      card.append(header);
      const details = node('dl', undefined, 'trust-grant-details');
      field(details, 'Activities', grant.scopes.join(', '));
      field(details, 'Agents', grant.agents ? grant.agents.join(', ') : 'Any of the grantee’s agents');
      field(details, 'Brands', grant.brands ? grant.brands.join(', ') : 'All brands owned by the grantor');
      field(details, 'Countries', grant.countries ? grant.countries.join(', ') : 'Global');
      field(details, 'Valid from', grant.valid_from || 'No start date');
      field(details, 'Valid until', grant.valid_until || 'No end date');
      card.append(details);
      grants.append(card);
    }
    result.append(grants);
    if (data.matching_grants > data.grants.length) {
      result.append(node('p', `Showing ${data.grants.length} of ${data.matching_grants} matching grants. Read the source record for the full list.`));
    }
    if (data.brand_id && data.total_grants > data.matching_grants) {
      result.append(node('p', `${data.total_grants - data.matching_grants} other grants in this record name different brands.`));
    }

    result.append(node('h3', 'Agents this company runs'));
    if (data.agents.length) {
      const agents = node('ul', undefined, 'trust-result-agents');
      for (const agent of data.agents) {
        agents.append(node('li', `${agent.origin} — ${agent.roles.join(', ')}${agent.countries ? ` (${agent.countries.join(', ')})` : ''}`));
      }
      result.append(agents);
      if (data.total_agents > data.agents.length) result.append(node('p', `Showing ${data.agents.length} of ${data.total_agents} listed agents.`));
    } else result.append(node('p', 'None listed. A company can authorize partners without running agents of its own.'));
    result.append(node('p', 'This is what’s publicly declared, not a verdict on a particular request. Sellers also verify the agent’s signature and its operator’s listing, and may have private approvals this page can’t see.', 'trust-result-note'));
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) { input.focus(); return; }
    const number = ++requestNumber;
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    const timer = setTimeout(() => requestController.abort(), 60_000);
    button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    result.hidden = true;
    status.textContent = 'Checking the domain and its parent company…';
    try {
      const response = await fetch(`/api/trust/lookup?domain=${encodeURIComponent(query)}`, { signal: requestController.signal });
      let data;
      try { data = await response.json(); }
      catch { throw new Error('The lookup could not be completed. Try again later.'); }
      if (number !== requestNumber) return;
      if (!response.ok) throw new Error(data.error || 'The lookup could not be completed. Try again later.');
      render(data);
      status.textContent = 'Lookup complete.';
      const address = new URL(window.location.href);
      address.searchParams.set('domain', data.domain);
      window.history.replaceState(null, '', address);
    } catch (error) {
      if (number !== requestNumber) return;
      status.textContent = requestController.signal.aborted
        ? 'The lookup timed out. Try again; this does not mean the domain is unprotected.'
        : error.message || 'The lookup could not be completed. Try again later.';
    } finally {
      clearTimeout(timer);
      if (number === requestNumber) {
        button.disabled = false;
        form.removeAttribute('aria-busy');
      }
    }
  });

  const initialDomain = new URLSearchParams(window.location.search).get('domain');
  if (initialDomain) {
    input.value = initialDomain.slice(0, 512);
    form.requestSubmit();
  }
})();
