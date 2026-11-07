import React from "react";
import { Link } from "../components/link/Link";
import { HomeArticles } from "../components/article-index/HomeArticles";
import type { ArticleSummaryEdge } from "../lib/posts";

interface IndexPageTemplateProps {
  title: string;
  subheading: string;
  articles: ArticleSummaryEdge[];
}

// The hero as the site always had it, text beside the illustration, with the
// glow and shapes of the Starter's landing in its margins.
const Hero = ({ title, subheading }: Pick<IndexPageTemplateProps, "title" | "subheading">) => (
  <header className="home-hero flamingo-glow relative isolate overflow-hidden">
    <div className="flamingo-shapes home-hero-shapes" aria-hidden="true">
      <span className="flamingo-shape flamingo-blur home-hero-left" />
      <span className="flamingo-shape flamingo-blur home-hero-right" />
      <span className="flamingo-shape flamingo-blur home-hero-bottom" />
      <span className="flamingo-shape home-hero-dot" />
      <span className="flamingo-shape home-hero-ring" />
    </div>
    <div className="mx-auto grid w-full max-w-6xl items-center gap-8 px-4 pb-8 pt-8 md:grid-cols-2 md:gap-12 md:px-6 md:pb-14 md:pt-14 lg:px-8">
      <div className="order-2 md:order-1">
        <h1 className="text-4xl font-extrabold leading-[1.08] tracking-tight text-heading sm:text-5xl lg:text-[3.5rem]">{title}</h1>
        <p className="mt-5 max-w-md text-lg leading-relaxed text-muted sm:text-xl">{subheading}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link to="/blog/" className="btn btn-lg max-sm:flex-1">
            Read the articles
          </Link>
          <Link to="/about" className="btn-outline btn-lg max-sm:flex-1">
            About
          </Link>
        </div>
      </div>
      <img
        src="/img/home-illustration.png"
        alt=""
        width={770}
        height={578}
        className="order-1 mx-auto w-full max-w-xs justify-self-center md:order-2 md:max-w-lg md:justify-self-end"
      />
    </div>
  </header>
);

export const IndexPageTemplate = ({ title, subheading, articles }: IndexPageTemplateProps) => (
  <>
    <Hero title={title} subheading={subheading} />
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6 md:px-6 md:pb-20 lg:px-8">
      <HomeArticles articles={articles} />
    </div>
  </>
);
