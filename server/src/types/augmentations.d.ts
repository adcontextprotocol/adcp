/**
 * Type augmentations for third-party libraries
 * These extend existing type definitions to include fields that exist at runtime
 * but may not be in the official TypeScript definitions
 */

import type Stripe from 'stripe';
import type { OrganizationMembership } from '@workos-inc/node';

declare module 'stripe' {
  namespace Stripe {
    interface Subscription {
      current_period_end?: number;
    }

    interface Invoice {
      subscription?: string | Subscription;
      payment_intent?: string | PaymentIntent;
      charge?: string | Charge;
    }

    interface InvoiceLineItem {
      price?: Price;
      subscription_item?: string;
      type?: string;
    }
  }
}

declare module '@workos-inc/node' {
  interface OrganizationMembership {
    user?: {
      id: string;
      email: string;
      first_name?: string;
      last_name?: string;
    };
  }
}
