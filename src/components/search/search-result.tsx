import { Link } from "../link/Link";
import React from "react";
import { Highlight, Index, Snippet, useHits, useInstantSearch } from "react-instantsearch";
import type { Hit as AlgoliaHit } from "instantsearch.js";
import { AlgoliaIcon } from "../icons/svg/library/Icons";

type ArticleHit = AlgoliaHit<{ title: string; excerpt: string; slug: string }>;

const HitCount = () => {
  const { results } = useInstantSearch();
  const count = results?.nbHits ?? 0;

  return (
    <>
      <div className="flex justify-end text-heading">
        {count} result{count === 1 ? "" : "s"}
      </div>
      {count === 0 && <p className="flex justify-start p-4 text-sm text-heading">No article found.</p>}
    </>
  );
};

const Hits = ({ onNavigate }: { onNavigate?: () => void }) => {
  const { items } = useHits<ArticleHit>();

  return (
    <div>
      {items.map((hit) => (
        <div key={hit.objectID} className="mb-4">
          <Link to={hit.slug} onClick={onNavigate} className="text-accent underline hover:no-underline">
            <h4 className="mb-2">
              <Highlight attribute="title" hit={hit} highlightedTagName="mark" />
            </h4>
          </Link>
          <Snippet attribute="excerpt" hit={hit} highlightedTagName="mark" />
        </div>
      ))}
    </div>
  );
};

const PoweredBy = () => (
  <div className="ais-PoweredBy">
    <span className="text-md mr-2 text-heading">Search by</span>
    <a href="https://algolia.com" className="ais-PoweredBy-link w-auto" aria-label="Algolia">
      <AlgoliaIcon />
    </a>
  </div>
);

interface SearchResultProps {
  indices?: {
    name: string;
    title: string;
  }[];
  className?: string;
  // Called when a result is followed: the search dialog lives in the navbar,
  // which stays mounted across pages, so it has to close itself.
  onNavigate?: () => void;
}

const SearchResult = ({ indices, className, onNavigate }: SearchResultProps) => {
  const { indexUiState } = useInstantSearch();
  const query = indexUiState.query ?? "";

  return query.length > 0 && indices && indices.length > 0 ? (
    <div className={className}>
      {indices.map((index) => (
        <Index indexName={index.name} key={index.name}>
          <HitCount />
          <Hits onNavigate={onNavigate} />
        </Index>
      ))}
      <PoweredBy />
    </div>
  ) : null;
};

export default SearchResult;
