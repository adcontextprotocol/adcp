export class AuthManager {
  constructor(oauthConfig) {
    this.accountMapping = oauthConfig.account_mapping || {};
    this.defaultAccount = oauthConfig.default_account || 'default';
    this.authCache = new Map();
  }

  async handleOAuthError(error, context) {
    switch (error.code) {
      case 'invalid_token':
        return {
          error: 'Authentication expired',
          action: 'refresh_token',
          fallback: 'use_default_catalog'
        };
      
      case 'insufficient_scope':
        return {
          error: 'Insufficient permissions',
          required_scope: 'audience:read',
          fallback: 'use_default_catalog'
        };
      
      case 'network_error':
        return {
          error: 'Authentication service unavailable',
          retry_after: 30,
          fallback: 'use_cached_auth'
        };
      
      default:
        return {
          error: 'Authentication failed',
          fallback: 'use_default_catalog'
        };
    }
  }

  getAccountFromEmail(email) {
    if (!email) return this.defaultAccount;
    
    const domain = email.split('@')[1];
    if (!domain) return this.defaultAccount;
    
    return this.accountMapping[domain] || this.defaultAccount;
  }

  getCachedAuth(userId) {
    const cached = this.authCache.get(userId);
    if (!cached) return null;
    
    const now = Date.now();
    if (now > cached.expiresAt) {
      this.authCache.delete(userId);
      return null;
    }
    
    return cached.data;
  }

  setCachedAuth(userId, authData, ttlMinutes = 60) {
    this.authCache.set(userId, {
      data: authData,
      expiresAt: Date.now() + (ttlMinutes * 60 * 1000)
    });
  }
}