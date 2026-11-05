import React from "react";
import { Helmet } from "react-helmet";
import { Footer } from "./Footer";
import { Navbar } from "./Navbar";
import { withPrefix } from "gatsby";
import "../../styles/site.scss";

interface LayoutProps {
  children: JSX.Element | JSX.Element[];
  // The home page lays out its own full-width sections (the hero's glow runs
  // edge to edge, under the navbar); every other page sits in the column.
  fullBleed?: boolean;
}

export const Layout = ({ children, fullBleed = false }: LayoutProps) => {
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
      <main className="main flex-1">
        {fullBleed ? (
          children
        ) : (
          <div className="mx-auto w-full max-w-6xl px-4 py-10 md:px-6 md:py-14 lg:px-8">{children}</div>
        )}
      </main>
      <Footer />
    </div>
  );
};
