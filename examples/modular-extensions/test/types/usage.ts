// Type-level test of the extension packages and the runtime binding underneath the generated layer:
// typed envelope entries, branch writers, and task descriptors, as a runtime plug-in uses them. Apps
// use their generated layer instead (test/types/generated-binding.ts).
// `npm run typecheck` must pass; the @ts-expect-error lines must stay errors.
import type { CPPPricingOption, CommercialTerms, ExtensionPricingOption, ExtensionEntry } from '@adcp/core';
import { INDEXED_CPP, indexedCppBranch, readIndexedCpp, type IndexedCPP } from '@adcp-ext/linear-tv-indexed-cpp';
import { REQUEST_MAKEGOOD, tasks as makegoodTasks, type MakegoodRequest, type MakegoodResponse } from '@adcp-ext/makegood-units';
import type { AdcpClient } from '../../lib/client.mjs';
import type { AdcpServer } from '../../lib/server.mjs';
import {
  EXTENSION_DIGEST as RATE_CARD_DIGEST,
  EXTENSION_URI as RATE_CARD_URI,
  type RateCard,
  type RateCardIndexPricingOptionEntry,
} from '@adcp-ext/rate-card-index';
import {
  EXTENSION_DIGEST as SAT_DIGEST,
  EXTENSION_URI as SAT_URI,
  type SellerAdjustableTermsCommercialTermsEntry,
} from '@adcp-ext/seller-adjustable-terms';

const card: RateCard = {
  base_price: 1000,
  rounding: { step: 'each_row', decimals: 0, mode: 'half_away_from_zero' },
  rows: [{ kind: 'index', name: 'March', dimension: 'month', value: '2027-03', factor: 1.1 }],
};

// Typed extension entry: uri and digest are literal types, data is the extension's type.
const rateCardEntry: RateCardIndexPricingOptionEntry = { uri: RATE_CARD_URI, digest: RATE_CARD_DIGEST, data: card };

// ...and it is a core ExtensionEntry, so it goes straight into a core pricing option.
const option: CPPPricingOption = {
  pricing_option_id: 'po_1',
  pricing_model: 'cpp',
  currency: 'EUR',
  fixed_price: 1100,
  parameters: { demographic: '25-54' },
  extensions: [rateCardEntry],
};

const allowance: SellerAdjustableTermsCommercialTermsEntry = {
  uri: SAT_URI,
  digest: SAT_DIGEST,
  data: {
    allowances: [
      {
        allowance_id: 'a1',
        purchase_index: 0,
        path: '/budget',
        constraint: { kind: 'decrease', max_change_fraction: 0.2 },
      },
    ],
  },
};
const terms: Pick<CommercialTerms, 'extensions'> = { extensions: [allowance] };

// A core consumer that has no extension packages still compiles: data is opaque.
const opaque: ExtensionEntry = { uri: 'https://x.example.com/e', digest: 'sha256:00', data: { anything: 1 } };

// @ts-expect-error a rate-card entry cannot carry another extension's digest
const wrongDigest: RateCardIndexPricingOptionEntry = { uri: RATE_CARD_URI, digest: SAT_DIGEST, data: card };

// @ts-expect-error constraint kind is a closed union in this digest
const badKind: SellerAdjustableTermsCommercialTermsEntry['data']['allowances'][0]['constraint'] = { kind: 'value_floor' };

// A pricing model core does not have: the typed branch spreads into a core ExtensionPricingOption.
const indexed: IndexedCPP = {
  audience: { demographic_system: 'nmo', demographic: '25-54' },
  base_price: 1000,
  indices: [{ name: 'March', dimension: 'month', value: '2027-03', factor: 1.1 }],
  market_index: { fixed_at: '2027-01-16T00:00:00+01:00', cap: 1 },
  rounding: { decimals: 0, mode: 'half_away_from_zero' },
  ceiling_price: 1100,
  settlement: { points_source: 'nmo', invoice: 'delivered_points_x_fixed_rate' },
};
const indexedOption: ExtensionPricingOption = { pricing_option_id: 'po_2', currency: 'EUR', ...indexedCppBranch(indexed) };
const readBack: IndexedCPP | undefined = readIndexedCpp(indexedOption);

// @ts-expect-error the branch id is a literal: another extension's model is a different discriminator
const wrongBranch: typeof INDEXED_CPP = 'https://extensions.adcontextprotocol.org/other#indexed_cpp';

// A contributed task: the descriptor carries its request and response types to both sides.
declare const client: AdcpClient;
declare const server: AdcpServer;
const request: MakegoodRequest = { idempotency_key: 'k-00000001', media_buy_id: 'mb_1', rule_id: 'mg_video_2', package_id: 'pkg_video_2', reason: 'deliverable_missed' };
const answer: Promise<MakegoodResponse> = client.callTask(makegoodTasks.requestMakegood, request);
server.handle(makegoodTasks.requestMakegood, (req) => ({ status: 'completed', outcome: 'rejected', rule_id: req.rule_id, rejection: { code: 'CAP_EXCEEDED', message: 'cap used' } }));
// @ts-expect-error a handler must answer with the response definition's type: 'refused' is not an outcome
server.handle(makegoodTasks.requestMakegood, (req) => ({ status: 'completed', outcome: 'refused', rule_id: req.rule_id }));
// @ts-expect-error a request must match MakegoodRequest: package_id is required
const missing: MakegoodRequest = { idempotency_key: 'k-00000002', media_buy_id: 'mb_1', rule_id: 'mg_video_2', reason: 'deliverable_missed' };
// The task id is a literal: the branch of the kernel's task union.
const taskId: typeof REQUEST_MAKEGOOD = 'https://extensions.adcontextprotocol.org/makegood-units#request_makegood';

export { option, terms, opaque, wrongDigest, badKind, indexedOption, readBack, wrongBranch, answer, missing, taskId };
