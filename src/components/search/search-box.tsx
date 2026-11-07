import React from "react";
import { useSearchBox } from "react-instantsearch";
import { MagnifyingGlassIcon } from "@heroicons/react/24/solid";

interface SearchBoxProps {
  className?: string;
}

const CustomSearchBox = ({ className }: SearchBoxProps) => {
  const { query, refine } = useSearchBox();

  return (
    <form className={className} role="search" onSubmit={(e) => e.preventDefault()}>
      <MagnifyingGlassIcon className="pointer-events-none absolute left-4 top-3.5 h-5 w-5" aria-hidden="true" />
      <input
        className="h-12 w-full border-0 bg-transparent pl-11 pr-4 placeholder-faint focus:ring-0 sm:text-sm"
        type="search"
        placeholder="Search..."
        aria-label="Search the articles"
        autoComplete="off"
        onChange={(e) => refine(e.target.value)}
        value={query}
      />
    </form>
  );
};

export default CustomSearchBox;
