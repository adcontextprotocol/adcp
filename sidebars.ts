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
        'protocols/message-field-pattern',
      ],
    },
    {
      type: 'category',
      label: 'Signals Protocol',
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
      label: 'Curation Protocol',
      items: ['curation/coming-soon'],
    },
    {
      type: 'category',
      label: 'Media Buy Protocol',
      items: [
        'media-buy/index',
        {
          type: 'category',
          label: 'Task Reference',
          items: [
            'media-buy/task-reference/index',
            'media-buy/task-reference/get_products',
            'media-buy/task-reference/list_creative_formats',
            'media-buy/task-reference/list_authorized_properties',
            'media-buy/task-reference/create_media_buy',
            'media-buy/task-reference/list_creatives',
            'media-buy/task-reference/sync_creatives',
            'media-buy/task-reference/get_media_buy_delivery',
            'media-buy/task-reference/update_media_buy',
            'media-buy/task-reference/provide_performance_feedback',
          ],
        },
        {
          type: 'category',
          label: 'Capability Discovery',
          items: [
            'media-buy/capability-discovery/index',
            'media-buy/capability-discovery/implementing-standard-formats',
            'media-buy/capability-discovery/authorized-properties',
            'media-buy/capability-discovery/adagents',
          ],
        },
        {
          type: 'category',
          label: 'Product Discovery',
          items: [
            'media-buy/product-discovery/index',
            'media-buy/product-discovery/brief-expectations',
            'media-buy/product-discovery/example-briefs',
            'media-buy/product-discovery/media-products',
          ],
        },
        {
          type: 'category',
          label: 'Media Buys',
          items: [
            'media-buy/media-buys/index',
            'media-buy/media-buys/optimization-reporting',
            'media-buy/media-buys/policy-compliance',
          ],
        },
        {
          type: 'category',
          label: 'Creatives',
          items: [
            'media-buy/creatives/index',
          ],
        },
        {
          type: 'category',
          label: 'Advanced Topics',
          items: [
            'media-buy/advanced-topics/index',
            'media-buy/advanced-topics/targeting',
            'media-buy/advanced-topics/dimensions',
            'media-buy/advanced-topics/principals-and-security',
            'media-buy/advanced-topics/testing',
            'media-buy/advanced-topics/orchestrator-design',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Creative',
      items: [
        'creative/index',
        'creative/formats',
        'creative/asset-types',
        'creative/creative-manifests',
        'creative/universal-macros',
        'creative/implementing-creative-agents',
        'creative/generative-creative',
        {
          type: 'category',
          label: 'Channel Guides',
          items: [
            'creative/channels/video',
            'creative/channels/display',
            'creative/channels/audio',
            'creative/channels/dooh',
            'creative/channels/carousels',
          ],
        },
        {
          type: 'category',
          label: 'Task Reference',
          items: [
            'creative/task-reference/build_creative',
            'creative/task-reference/preview_creative',
            'creative/task-reference/list_creative_formats',
          ],
        },
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
