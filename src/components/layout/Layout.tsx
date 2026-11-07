import React from "react";
import { Helmet } from "react-helmet";
import { Footer } from "./Footer";
import { Navbar } from "./Navbar";
import { withPrefix } from "gatsby";
import "../../styles/site.scss";

// Which decoration a page gets (the flamingo layer, DESIGN.md §2.5 of the
// Starter, applied here to the blog's pages):
// - home: lays out its own full-width hero, glow and shapes included;
// - article: none, so nothing competes with the text;
// - page: a light band at the top (About, Contact, Tags...).
export type PageKind = "home" | "article" | "page";

export const pageKindOf = (pathname: string): PageKind =>
  pathname === "/" ? "home" : pathname.startsWith("/blog/") ? "article" : "page";

interface LayoutProps {
  children: JSX.Element | JSX.Element[];
  kind?: PageKind;
}

// The light band of the secondary pages: the glow and two shapes in the top
// corners, fading out before the content below the title.
const PageBand = () => (
  <div className="page-band" aria-hidden="true">
    <span className="flamingo-shape flamingo-blur page-band-left" />
    <span className="flamingo-shape flamingo-blur page-band-right" />
    <span className="flamingo-shape page-band-ring" />
  </div>
);

export const Layout = ({ children, kind = "page" }: LayoutProps) => {
  return (
    <div className="flex min-h-screen flex-col bg-page text-body">
      <Helmet>
        <html lang="en" />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href={`${withPrefix("/")}img/apple-touch-icon.png`}
        />

        <link rel="shortcut icon" href={`${withPrefix("/")}img/favicon.ico`} />
        <link
          rel="icon"
          type="image/png"
          href={`${withPrefix("/")}img/favicon-32x32.png`}
          sizes="32x32"
        />
        <link
          rel="icon"
          type="image/png"
          href={`${withPrefix("/")}img/favicon-16x16.png`}
          sizes="16x16"
        />

        <link
          rel="mask-icon"
          href={`${withPrefix("/")}img/safari-pinned-tab.svg`}
          color="#676dcf"
        />
        <body />
      </Helmet>
      <Navbar />
      <main className="main relative isolate flex-1 overflow-x-clip">
        {kind === "page" && <PageBand />}
        {kind === "home" ? (
          children
        ) : (
          <div className="mx-auto w-full max-w-6xl px-4 py-10 md:px-6 md:py-14 lg:px-8">{children}</div>
        )}
      </main>
      <Footer />
    </div>
  );
};
