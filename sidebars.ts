import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */
const sidebars: SidebarsConfig = {
  tutorialSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Protocols',
      items: [
        'protocols/getting-started',
        {
          type: 'category',
          label: 'Choose Your Protocol',
          items: [
            'protocols/mcp-guide',
            'protocols/a2a-guide',
          ],
        },
        'protocols/protocol-comparison',
        'protocols/context-management',
      ],
    },
    {
      type: 'category',
      label: 'Signals',
      items: [
        'signals/overview',
        'signals/specification',
        {
          type: 'category',
          label: 'Tasks',
          items: [
            'signals/tasks/get_signals',
            'signals/tasks/activate_signal',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Curation',
      items: ['curation/coming-soon'],
    },
    {
      type: 'category',
      label: 'Media Buy',
      items: [
        'media-buy/index',
        {
          type: 'category',
          label: 'Tasks',
          items: [
            'media-buy/tasks/get_products',
            'media-buy/tasks/list_creative_formats',
            'media-buy/tasks/create_media_buy',
            'media-buy/tasks/sync_creatives',
            'media-buy/tasks/list_creatives',
            'media-buy/tasks/get_media_buy_delivery',
            'media-buy/tasks/update_media_buy',
          ],
        },
        {
          type: 'category',
          label: 'Core Concepts',
          items: [
            'media-buy/product-discovery',
            'media-buy/media-products',
            'media-buy/media-buys',
            'media-buy/dimensions',
          ],
        },
        {
          type: 'category',
          label: 'Creatives',
          items: [
            'media-buy/creative-lifecycle',
            'media-buy/creative-library',
            'media-buy/creative-formats',
            'media-buy/asset-types',
          ],
        },
        {
          type: 'category',
          label: 'Operations',
          items: [
            'media-buy/media-buy-lifecycle',
            'media-buy/targeting',
            'media-buy/targeting-dimensions',
            'media-buy/policy-compliance',
            'media-buy/reporting-and-optimization',
            'media-buy/principals-and-security',
          ],
        },
        {
          type: 'category',
          label: 'Implementation',
          items: [
            'media-buy/testing',
            'media-buy/orchestrator-design',
            'media-buy/design-decisions',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Discovery',
      items: [
        'discovery/protocol',
        'discovery/implementation-guide',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        'reference/error-codes',
        'reference/data-models',
        'reference/authentication',
        'reference/glossary',
      ],
    },
  ],
};

export default sidebars;
