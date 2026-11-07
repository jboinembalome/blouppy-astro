import React from "react";

interface PageHeaderProps {
  kicker?: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
}

// One header for every listing page: a kicker, the title and an optional
// subtitle, above a divider — the Starter's "page header" pattern.
export const PageHeader = ({ kicker, title, subtitle }: PageHeaderProps) => (
  <header className="mb-10 border-b border-line pb-8">
    {kicker && <span className="section-kicker">{kicker}</span>}
    <h1 className="text-3xl font-extrabold tracking-tight text-heading sm:text-4xl">{title}</h1>
    {subtitle && <p className="mt-3 max-w-2xl text-base text-muted sm:text-lg">{subtitle}</p>}
  </header>
);
