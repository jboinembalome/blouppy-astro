import algoliasearch from "algoliasearch/lite"
import { createRef, default as React, Fragment, useMemo } from "react"
import { InstantSearch } from "react-instantsearch"
import CustomSearchBox from "./search-box"
import SearchResult from "./search-result"
import { Dialog, Transition } from '@headlessui/react'

interface SearchProps {
    indices: {
        name: string;
        title: string;
    }[];
    openModal: boolean;
    modalClosed: (isClosed: boolean) => void;
}

export default function Search({ indices, openModal, modalClosed }: SearchProps) {
    const rootRef = createRef<HTMLDivElement>()

    const searchClient = useMemo(
        () =>
            algoliasearch(
                process.env.GATSBY_ALGOLIA_APP_ID ?? '',
                process.env.GATSBY_ALGOLIA_SEARCH_KEY ?? ''
            ),
        []
    )

    return (
        <div ref={rootRef}>
            <InstantSearch searchClient={searchClient}
                indexName={indices[0].name}
                future={{ preserveSharedStateOnUnmount: true }}>
                <div className="relative">
                    <Transition.Root show={openModal} as={Fragment} afterLeave={() => modalClosed(false)}>
                        <Dialog as="div" className="fixed inset-0 z-50 overflow-y-auto p-4 sm:p-6 md:p-20" onClose={modalClosed}>
                            <Transition.Child
                                as={Fragment}
                                enter="ease-out duration-300"
                                enterFrom="opacity-0"
                                enterTo="opacity-100"
                                leave="ease-in duration-200"
                                leaveFrom="opacity-100"
                                leaveTo="opacity-0"
                            >
                                <Dialog.Overlay className="fixed inset-0 transition-opacity" style={{ backgroundColor: "color-mix(in srgb, var(--blouppy-surface-950) 45%, transparent)" }} />
                            </Transition.Child>

                            <Transition.Child
                                as={Fragment}
                                enter="ease-out duration-300"
                                enterFrom="opacity-0 scale-95"
                                enterTo="opacity-100 scale-100"
                                leave="ease-in duration-200"
                                leaveFrom="opacity-100 scale-100"
                                leaveTo="opacity-0 scale-95"
                            >
                                <div className="mx-auto max-w-xl transform divide-y divide-line overflow-hidden rounded-xl border border-line shadow-lg transition-all">
                                    <CustomSearchBox className="bg-card text-heading relative" />
                                    <SearchResult className="bg-card text-heading p-4 max-h-72 scroll-py-2 overflow-y-auto py-2 text-sm"
                                        indices={indices}
                                    />

                                </div>
                            </Transition.Child>
                        </Dialog>
                    </Transition.Root>
                </div>
            </InstantSearch>
        </div>
    )
}