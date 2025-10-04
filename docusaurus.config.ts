import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'AdCP - Open Standard for Advertising Workflows',
  tagline: 'Unified advertising automation protocol built on Model Context Protocol (MCP)',
  favicon: 'img/favicon.ico',

  // SEO metadata
  headTags: [
    {
      tagName: 'meta',
      attributes: {
        name: 'description',
        content: 'AdCP (Ad Context Protocol) is an open standard that unifies advertising platforms through AI-powered workflows. Built on MCP for seamless programmatic advertising automation.',
      },
    },
    {
      tagName: 'meta',
      attributes: {
        name: 'keywords',
        content: 'advertising automation protocol, programmatic advertising API, MCP advertising integration, AI advertising workflows, unified advertising platform API, advertising technology',
      },
    },
    {
      tagName: 'meta',
      attributes: {
        property: 'og:type',
        content: 'website',
      },
    },
    {
      tagName: 'meta',
      attributes: {
        name: 'twitter:card',
        content: 'summary_large_image',
      },
    },
    {
      tagName: 'meta',
      attributes: {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1.0',
      },
    },
  ],

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // Set the production url of your site here
  url: 'https://adcontextprotocol.org',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'adcontextprotocol', // Usually your GitHub org/user name.
  projectName: 'adcp', // Usually your repo name.

  onBrokenLinks: 'throw',

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  themes: ['@docusaurus/theme-mermaid'],
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  plugins: [
    ['docusaurus-plugin-llms-txt', {
      title: 'AdCP - Ad Context Protocol',
      description: 'Open standard for advertising automation and AI-powered workflows. Built on Model Context Protocol (MCP) for unified programmatic advertising.',
    }],
    [
      '@docusaurus/plugin-client-redirects',
      {
        redirects: [
          {
            to: '/docs/intro/',
            from: '/docs',
          },
        ],
      },
    ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl:
            'https://github.com/adcontextprotocol/adcp/tree/main/',
        },
        sitemap: {
          changefreq: 'weekly',
          priority: 0.5,
          ignorePatterns: ['/tags/**'],
          filename: 'sitemap.xml',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    // Replace with your project's social card
    image: 'img/docusaurus-social-card.jpg',
    navbar: {
      title: 'AdCP',
      logo: {
        alt: 'AdCP - Advertising Context Protocol Logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          href: 'https://github.com/adcontextprotocol/adcp',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Getting Started',
              to: '/docs/intro',
            },
            {
              label: 'Signals Protocol',
              to: '/docs/signals/overview',
            },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'GitHub Discussions',
              href: 'https://github.com/adcontextprotocol/adcp/discussions',
            },
            {
              label: 'Working Group',
              href: '/docs/community/working-group',
            },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/adcontextprotocol/adcp',
            },
            {
              label: 'Roadmap',
              href: 'https://github.com/adcontextprotocol/adcp/projects/1',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Ad Context Protocol. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
