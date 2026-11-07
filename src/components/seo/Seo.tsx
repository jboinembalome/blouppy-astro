import React from "react";
import { useSiteMetadata } from "../../hooks/useSiteMetadata";

interface SeoProps {
  title?: string;
  description?: string;
  // The page's path (location.pathname), from which its canonical URL is built.
  pathname?: string;
  // A path under the site (/img/...); the site's illustration when left out.
  image?: string;
  imageAlt?: string;
  type?: "website" | "article";
  noindex?: boolean;
  children?: React.ReactNode;
}

const defaultImage = "/img/home-illustration.png";

// The tags of a page's <head>, for Gatsby's Head API: rendered into the HTML at
// build time, so crawlers and link previews read them without running scripts.
export const Seo = ({ title, description, pathname = "/", image, imageAlt, type = "website", noindex, children }: SeoProps) => {
  const siteMetadata = useSiteMetadata();
  const siteName = siteMetadata.title;
  const siteUrl = siteMetadata.siteUrl;
  const fullTitle = title ? `${title} | ${siteName}` : siteName;
  const metaDescription = description || siteMetadata.description;
  const url = `${siteUrl}${pathname}`;
  const imageUrl = `${siteUrl}${image ?? defaultImage}`;

  return (
    <>
      <title>{fullTitle}</title>
      <meta name="description" content={metaDescription} />
      <link rel="canonical" href={url} />
      {noindex && <meta name="robots" content="noindex" />}

      <meta property="og:title" content={title || siteName} />
      <meta property="og:description" content={metaDescription} />
      <meta property="og:type" content={type} />
      <meta property="og:url" content={url} />
      <meta property="og:site_name" content={siteName} />
      <meta property="og:locale" content="en_US" />
      <meta property="og:image" content={imageUrl} />
      <meta property="og:image:alt" content={imageAlt ?? title ?? siteName} />

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:creator" content={siteMetadata.social.twitter} />
      <meta name="twitter:title" content={title || siteName} />
      <meta name="twitter:description" content={metaDescription} />
      <meta name="twitter:image" content={imageUrl} />

      <link rel="alternate" type="application/rss+xml" title={`${siteName} articles`} href={`${siteUrl}/rss.xml`} />
      {children}
    </>
  );
};
