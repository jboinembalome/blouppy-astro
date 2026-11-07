import React from "react";
import { Footer } from "./Footer";
import { Navbar } from "./Navbar";
import "../../styles/site.scss";

// Which decoration a page gets (the flamingo layer, DESIGN.md §2.5 of the
// Starter, applied here to the blog's pages):
// - home: lays out its own full-width hero, glow and shapes included;
// - article: none, so nothing competes with the text;
// - page: a light band at the top (About, Contact, Tags...).
export type PageKind = "home" | "article" | "page";

// The Articles list itself (/blog/) is a page; only what is under it is an article.
export const pageKindOf = (pathname: string): PageKind =>
  pathname === "/" ? "home" : pathname.startsWith("/blog/") && pathname !== "/blog/" ? "article" : "page";

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
