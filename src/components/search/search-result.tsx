import { Link } from "gatsby"
import { default as React } from "react"
import {
    connectStateResults,
    connectHits,
    Highlight,
    Index,
    Snippet,
} from "react-instantsearch-dom"
import { AlgoliaIcon } from "../icons/svg/library/Icons"

const HitCount = connectStateResults(({ searchResults }) => {
    const hitCount = searchResults && searchResults.nbHits
    return hitCount > 0 ? (
        <div className="flex justify-end text-heading">
            {hitCount} result{hitCount !== 1 ? `s` : ``}
        </div>
    ) : <>
        <div className="flex justify-end text-heading">
            0 result
        </div>
        <p className="flex justify-start p-4 text-sm text-heading">No article found.</p>
    </>
})


const Hits = ({ hits }: any) => (
    <div>
        {hits.map((hit: any) => (
            <div key={hit.objectID} className="mb-4">
                <div className="flex items-center justify-between">
                    <Link to={hit.slug} className="flex items-center justify-between text-blue-700 hover:text-blue-800 dark:text-blue-500 dark:hover:text-blue-600 underline">
                        <h4 className="mb-2">
                            <Highlight attribute="title" hit={hit} tagName="mark" />
                        </h4>
                    </Link>
                </div>
                <Snippet attribute="excerpt" hit={hit} tagName="mark" />
            </div>
        ))}
    </div>
);

const CustomHits = connectHits(Hits);

const HitsInIndex = ({ index }: any) => {
    return (
        <Index indexName={index.name}>
            <HitCount />
            <CustomHits />
        </Index>

    )
}

const PoweredBy = () => (
    <div className="ais-PoweredBy">
        <span className="text-heading text-md mr-2">Search by</span>
        <a href="https://algolia.com" className="ais-PoweredBy-link w-auto" aria-label="Algolia">
            <AlgoliaIcon />
        </a>
    </div>
)

interface SearchResultProps {
    indices?: {
        name: string;
        title: string;
    }[];
    query?: any;
    className?: string;
}

const SearchResult = ({ indices, query, className }: SearchResultProps) => {
    return query && query.length > 0 && indices && indices.length > 0 ?
        (
            <div className={className}>
                {indices.map(index => (
                    <HitsInIndex index={index} key={index.name} />
                ))}
                <PoweredBy />
            </div>) : null
}



export default SearchResult