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
      label: 'Audience Discovery',
      items: [
        'audience/overview',
        'audience/specification',
        'audience/quick-reference',
        'audience/examples',
        'audience/faq',
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
      items: ['media-buy/coming-soon'],
    },
    {
      type: 'category',
      label: 'Implementation',
      items: [
        'implementation/getting-started',
        'implementation/authentication',
        'implementation/best-practices',
        'implementation/testing',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        'reference/glossary',
        'reference/error-codes',
        'reference/changelog',
      ],
    },
  ],
};

export default sidebars;
