/**
 * Environment variable validation
 *
 * Validates all required environment variables on server startup
 * and provides helpful error messages if any are missing.
 */

interface EnvConfig {
  // Required variables
  required: {
    name: string;
    description: string;
  }[];

  // Optional variables with defaults
  optional: {
    name: string;
    description: string;
    defaultValue?: string;
  }[];
}

const envConfig: EnvConfig = {
  required: [
    {
      name: 'DATABASE_URL',
      description: 'PostgreSQL connection string (e.g., postgresql://user:pass@host:5432/db) - REQUIRED for registry, authentication, and billing',
    },
  ],
  optional: [
    {
      name: 'WORKOS_API_KEY',
      description: 'WorkOS API key for authentication',
    },
    {
      name: 'WORKOS_CLIENT_ID',
      description: 'WorkOS client ID for OAuth flow',
    },
    {
      name: 'WORKOS_COOKIE_PASSWORD',
      description: 'Secret key for encrypting session cookies (min 32 characters)',
    },
    {
      name: 'WORKOS_REDIRECT_URI',
      description: 'OAuth callback URL',
      defaultValue: 'http://localhost:3000/auth/callback',
    },
    {
      name: 'STRIPE_SECRET_KEY',
      description: 'Stripe secret key for billing (sk_test_... or sk_live_...)',
    },
    {
      name: 'STRIPE_PUBLISHABLE_KEY',
      description: 'Stripe publishable key for frontend (pk_test_... or pk_live_...)',
    },
    {
      name: 'STRIPE_PRICING_TABLE_ID',
      description: 'Stripe pricing table ID for team/organization subscriptions',
    },
    {
      name: 'STRIPE_PRICING_TABLE_ID_INDIVIDUAL',
      description: 'Stripe pricing table ID for individual subscriptions (falls back to STRIPE_PRICING_TABLE_ID)',
    },
    {
      name: 'STRIPE_WEBHOOK_SECRET',
      description: 'Stripe webhook signing secret (whsec_...)',
    },
    {
      name: 'PORT',
      description: 'HTTP server port',
      defaultValue: '3000',
    },
    {
      name: 'NODE_ENV',
      description: 'Environment (development|production)',
      defaultValue: 'development',
    },
    {
      name: 'ADMIN_EMAILS',
      description: 'Comma-separated list of admin email addresses for /admin/* access',
    },
  ],
};

/**
 * Validate that all required environment variables are set
 * Exits the process if any required variables are missing
 */
export function validateEnvironment(): void {
  const missing: string[] = [];
  const warnings: string[] = [];

  // Check required variables
  for (const { name, description } of envConfig.required) {
    if (!process.env[name]) {
      missing.push(`  ${name}: ${description}`);
    }
  }

  // Check optional variables and set defaults
  for (const { name, description, defaultValue } of envConfig.optional) {
    if (!process.env[name]) {
      if (defaultValue) {
        process.env[name] = defaultValue;
      } else {
        warnings.push(`  ${name}: ${description} (optional, but recommended)`);
      }
    }
  }

  // Validate WORKOS_COOKIE_PASSWORD length if provided
  if (process.env.WORKOS_COOKIE_PASSWORD && process.env.WORKOS_COOKIE_PASSWORD.length < 32) {
    warnings.push('  WORKOS_COOKIE_PASSWORD: Must be at least 32 characters long (authentication features will be disabled)');
  }

  // Report results
  if (missing.length > 0) {
    console.error('\n❌ Missing required environment variables:\n');
    console.error(missing.join('\n'));
    console.error('\nPlease set these variables in your .env file or environment.');
    console.error('See .env.example for a template.\n');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn('\n⚠️  Optional environment variables not set:\n');
    console.warn(warnings.join('\n'));
    console.warn('\nNote: Authentication and billing features will be disabled without required configuration.\n');
  } else {
    console.log('✅ Environment variables validated successfully\n');
  }
}

/**
 * Get a list of all environment variables for documentation
 */
export function getEnvironmentDocs(): string {
  let docs = '# Required Environment Variables\n\n';

  for (const { name, description } of envConfig.required) {
    docs += `${name}=${description}\n`;
  }

  docs += '\n# Optional Environment Variables\n\n';

  for (const { name, description, defaultValue } of envConfig.optional) {
    const defaultText = defaultValue ? ` (default: ${defaultValue})` : '';
    docs += `${name}=${description}${defaultText}\n`;
  }

  return docs;
}
