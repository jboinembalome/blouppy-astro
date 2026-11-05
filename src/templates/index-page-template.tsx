import React from "react";
import { Link } from "gatsby";
import kebabCase from "lodash/kebabCase";
import { ArticleCard } from "../components/article-card/ArticleCard";
import { useLatestArticles } from "../hooks/useLatestArticles";
import { starterDocsUrl, starterUrl } from "../constants/starter";
import { withPrefix } from "gatsby";

interface HeroProps {
  title: string;
  heading: string;
  subheading: string;
}

// The hero, as on the Starter's landing page: a badge, a headline whose last
// words carry the brand gradient, one primary action and one secondary.
const Hero = ({ title, heading, subheading }: HeroProps) => (
  <header className="home-hero flamingo-glow relative isolate overflow-hidden px-4 pb-4 text-center md:px-6 md:pb-12">
    <div className="flamingo-shapes home-hero-shapes" aria-hidden="true">
      <span className="flamingo-shape flamingo-blur home-hero-circle-top-left" />
      <span className="flamingo-shape flamingo-blur home-hero-circle-top-right" />
      <span className="flamingo-shape flamingo-blur home-hero-circle-bottom-right" />
      <span className="flamingo-shape home-hero-dot" />
      <span className="flamingo-shape home-hero-ring" />
      <span className="flamingo-shape home-hero-square" />
    </div>

    <div className="mx-auto w-full max-w-3xl">
      <span className="chip mb-6 px-3.5 py-1.5 text-[0.8125rem] font-semibold">.NET 10 · ASP.NET Core · Angular 22</span>
      <h1 className="mx-auto mb-5 text-4xl font-extrabold leading-[1.15] tracking-tight text-heading sm:text-5xl lg:text-6xl">
        {title} <span className="home-highlight">{heading}</span>
      </h1>
      <p className="mx-auto mb-9 max-w-2xl text-base text-muted sm:text-lg">{subheading}</p>
      <div className="flex flex-wrap justify-center gap-3.5">
        <Link to="/blog" className="btn btn-lg max-sm:w-full">
          Read the articles
        </Link>
        <a href={starterUrl} className="btn-outline btn-lg max-sm:w-full" rel="noopener">
          The code behind them →
        </a>
      </div>
    </div>
  </header>
);

interface Topic {
  fieldValue: string;
  totalCount: number;
}

const Topics = ({ topics }: { topics: Topic[] }) => (
  <section aria-labelledby="topics-title" className="mx-auto w-full max-w-6xl px-4 md:px-6 lg:px-8">
    <h2 id="topics-title" className="sr-only">
      Topics
    </h2>
    <ul className="flex flex-wrap justify-center gap-2">
      {topics.map((topic) => (
        <li key={topic.fieldValue}>
          <Link
            to={`/tags/${kebabCase(topic.fieldValue)}/`}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1 text-sm font-medium text-body transition-colors hover:border-accent-border hover:text-accent"
          >
            {topic.fieldValue}
            <span className="text-xs text-faint">{topic.totalCount}</span>
          </Link>
        </li>
      ))}
    </ul>
  </section>
);

const LatestArticles = ({ articles }: { articles: ReturnType<typeof useLatestArticles>["articles"] }) => (
  <section aria-labelledby="latest-title" className="mx-auto w-full max-w-6xl px-4 md:px-6 lg:px-8">
    <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
      <div>
        <span className="section-kicker">Latest articles</span>
        <h2 id="latest-title" className="text-3xl font-extrabold tracking-tight text-heading sm:text-4xl">
          Fresh from the blog
        </h2>
      </div>
      <Link to="/blog" className="text-sm font-semibold text-accent hover:underline">
        All articles →
      </Link>
    </div>
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {articles.map(({ node }) => (
        <ArticleCard key={node.id} article={node} />
      ))}
    </div>
  </section>
);

interface AuthorProps {
  mainpitch: {
    title: string;
    description: string;
  };
}

const Author = ({ mainpitch }: AuthorProps) => (
  <section aria-labelledby="author-title" className="mx-auto w-full max-w-3xl px-4 md:px-6 lg:px-8">
    <div className="flex flex-col items-center gap-6 rounded-xl border border-line bg-card p-6 text-center sm:flex-row sm:p-8 sm:text-left">
      <img src={`${withPrefix("/")}img/jimmy.jpg`} alt="" className="h-20 w-20 shrink-0 rounded-full object-cover" />
      <div>
        <h2 id="author-title" className="mb-2 text-xl font-semibold text-heading">
          {mainpitch.title}
        </h2>
        <p className="text-base leading-relaxed text-muted">{mainpitch.description}</p>
        <Link to="/about" className="mt-3 inline-block text-sm font-semibold text-accent hover:underline">
          More about me →
        </Link>
      </div>
    </div>
  </section>
);

// The closing call to action, on the landing's indigo gradient with its shapes.
const StarterCallToAction = () => (
  <section className="home-cta relative isolate overflow-hidden px-4 py-20 text-center md:px-6">
    <div className="flamingo-shapes" aria-hidden="true">
      <span className="flamingo-shape flamingo-blur home-cta-circle-left" />
      <span className="flamingo-shape flamingo-blur home-cta-circle-right" />
      <span className="flamingo-shape home-cta-square" />
    </div>
    <span className="mb-3 block text-[0.84375rem] font-bold uppercase tracking-widest text-primary-200">Blouppy Starter</span>
    <h2 className="mb-3.5 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">The code behind the articles</h2>
    <p className="mx-auto mb-8 max-w-xl text-base text-primary-100 sm:text-[1.03rem]">
      Most posts here come from a real .NET 10 and Angular 22 SaaS foundation: the BFF gateway, OpenIddict, Wolverine, billing,
      webhooks, GDPR and more, built, tested and documented.
    </p>
    <div className="flex flex-wrap justify-center gap-3.5">
      <a href={starterUrl} className="btn btn-lg bg-white text-primary-700 hover:bg-primary-50 max-sm:w-full" rel="noopener">
        Discover Blouppy Starter
      </a>
      <a href={starterDocsUrl} className="btn-outline btn-lg border-white/40 text-white hover:bg-white/10 max-sm:w-full" rel="noopener">
        Read the docs →
      </a>
    </div>
  </section>
);

interface IndexPageTemplateProps extends HeroProps, AuthorProps {}

export const IndexPageTemplate = ({ title, heading, subheading, mainpitch }: IndexPageTemplateProps) => {
  const { articles, topics } = useLatestArticles();

  return (
    <div className="flex flex-col gap-14 md:gap-20">
      <Hero title={title} heading={heading} subheading={subheading} />
      <Topics topics={topics} />
      <LatestArticles articles={articles} />
      <Author mainpitch={mainpitch} />
      <StarterCallToAction />
    </div>
  );
};
