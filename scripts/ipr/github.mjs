const API_ROOT = 'https://api.github.com';

export class GitHubClient {
  constructor({ token, userAgent = 'adcp-ipr-check' } = {}) {
    this.token = token ?? process.env.GITHUB_TOKEN;
    if (!this.token) {
      throw new Error('GitHubClient requires a token (pass {token} or set GITHUB_TOKEN)');
    }
    this.userAgent = userAgent;
  }

  async request(method, pathname, { body, query } = {}) {
    // pathname must be a `/...` path on api.github.com; the API_ROOT prefix is
    // enforced here so callers can't redirect requests to an arbitrary host
    // even if pathname is ever derived from less-trusted input.
    if (typeof pathname !== 'string' || !pathname.startsWith('/')) {
      throw new Error(`GitHubClient: pathname must start with '/' (got ${String(pathname)})`);
    }
    const url = new URL(`${API_ROOT}${pathname}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': this.userAgent,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${method} ${url.pathname} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async *paginate(pathname, query = {}) {
    let page = 1;
    const perPage = query.per_page ?? 100;
    while (true) {
      const result = await this.request('GET', pathname, {
        query: { ...query, per_page: perPage, page },
      });
      const items = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];
      if (items.length === 0) return;
      for (const item of items) yield item;
      if (items.length < perPage) return;
      page += 1;
    }
  }

  getPullRequest(owner, repo, number) {
    return this.request('GET', `/repos/${owner}/${repo}/pulls/${number}`);
  }

  listIssueComments(owner, repo, number) {
    return this.paginate(`/repos/${owner}/${repo}/issues/${number}/comments`);
  }

  listPullRequests(owner, repo, state = 'all') {
    return this.paginate(`/repos/${owner}/${repo}/pulls`, { state, sort: 'created', direction: 'asc' });
  }

  createIssueComment(owner, repo, number, body) {
    return this.request('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
  }

  updateIssueComment(owner, repo, commentId, body) {
    return this.request('PATCH', `/repos/${owner}/${repo}/issues/comments/${commentId}`, { body });
  }

  createStatus(owner, repo, sha, { state, context, description, targetUrl }) {
    return this.request('POST', `/repos/${owner}/${repo}/statuses/${sha}`, {
      state,
      context,
      description: description?.slice(0, 140),
      target_url: targetUrl,
    });
  }
}
