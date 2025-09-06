import React from 'react';
import Head from '@docusaurus/Head';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

interface SEOProps {
  title?: string;
  description?: string;
  keywords?: string;
  image?: string;
  url?: string;
  type?: string;
  structuredData?: object;
}

export default function SEO({
  title,
  description = 'AdCP (Ad Context Protocol) is an open standard that unifies advertising platforms through AI-powered workflows. Built on MCP for seamless programmatic advertising automation.',
  keywords = 'advertising automation protocol, programmatic advertising API, MCP advertising integration, AI advertising workflows, unified advertising platform API',
  image,
  url,
  type = 'website',
  structuredData,
}: SEOProps) {
  const {siteConfig} = useDocusaurusContext();
  const siteTitle = siteConfig.title;
  const siteUrl = siteConfig.url;
  
  const pageTitle = title ? `${title} | ${siteTitle}` : siteTitle;
  const pageUrl = url ? `${siteUrl}${url}` : siteUrl;
  const pageImage = image ? `${siteUrl}${image}` : `${siteUrl}/img/adcp-social-card.jpg`;

  return (
    <Head>
      {/* Basic meta tags */}
      <title>{pageTitle}</title>
      <meta name="description" content={description} />
      <meta name="keywords" content={keywords} />
      <link rel="canonical" href={pageUrl} />
      
      {/* OpenGraph tags */}
      <meta property="og:title" content={pageTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content={type} />
      <meta property="og:url" content={pageUrl} />
      <meta property="og:image" content={pageImage} />
      <meta property="og:site_name" content={siteTitle} />
      
      {/* Twitter Card tags */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={pageTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={pageImage} />
      
      {/* Structured data */}
      {structuredData && (
        <script type="application/ld+json">
          {JSON.stringify(structuredData)}
        </script>
      )}
    </Head>
  );
}