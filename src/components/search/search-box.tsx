import React from "react"
import { connectSearchBox } from "react-instantsearch-dom"
import { MagnifyingGlassIcon } from '@heroicons/react/24/solid'

interface SearchBoxProps {
    refine: any;
    currentRefinement: any;
    className: any;
}

const SearchBox = ({ refine, currentRefinement, className }: SearchBoxProps) => (
    <form className={className}>
        <MagnifyingGlassIcon
            className="pointer-events-none absolute top-3.5 left-4 h-5 w-5"
            aria-hidden="true"
        />
        <input
            className="h-12 w-full border-0 bg-transparent pl-11 pr-4 placeholder-faint focus:ring-0 sm:text-sm"
            type="text" placeholder="Search..." role="combobox" aria-expanded="false" aria-controls="options"
            autoComplete="off"
            onChange={e => refine(e.target.value)}
            value={currentRefinement}
           
        />
    </form>
)

const CustomSearchBox = connectSearchBox(SearchBox);

export default CustomSearchBox;