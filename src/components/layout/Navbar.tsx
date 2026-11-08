import React, { Suspense, lazy, useState } from "react";
import { Disclosure } from "@headlessui/react";
import { Bars3Icon, XMarkIcon } from "@heroicons/react/24/outline";
import { MagnifyingGlassIcon } from "@heroicons/react/24/solid";
import { Link, withTrailingSlash } from "../link/Link";
import { searchConfigured } from "../search/config";

// Algolia's client and InstantSearch make up most of the navbar's JavaScript,
// and only a reader who opens the search needs them: they load on that first
// click, and stay for the next ones.
const Search = lazy(() => import("../search"));
import { ThemeToggle } from "../theme-toggle/ThemeToggle";
import { BlouppyIcon } from "../icons/svg/BlouppyIcon";
import { BlouppyWithTextIcon } from "../icons/svg/BlouppyWithTextIcon";
import { starterUrl } from "../../constants/starter";

const links = [
  { name: "Articles", href: "/blog/" },
  { name: "Tags", href: "/tags" },
  { name: "About", href: "/about" },
  { name: "Contact", href: "/contact" },
];

const linkClassName = "text-sm font-medium text-muted transition-colors hover:text-accent";
const activeLinkClassName = "text-sm font-medium text-accent";

// A section stays highlighted on its sub-pages: Articles on an article, Tags
// on a tag.
const isPartiallyActive = (href: string, currentPath?: string) =>
  currentPath !== undefined && withTrailingSlash(currentPath).startsWith(withTrailingSlash(href));

const mobileLinkClassName = "block rounded-lg px-3 py-2.5 text-base font-medium text-body hover:bg-hover";

const searchIndices = [{ name: `Pages`, title: `Pages` }];

export const Navbar = ({ currentPath }: { currentPath?: string }) => {
  const [toggleSearch, setToggleSearch] = useState(false);
  const [searchRequested, setSearchRequested] = useState(false);

  return (
    <Disclosure
      as="nav"
      className="sticky top-0 z-40 w-full border-b border-line backdrop-blur-md"
      style={{ backgroundColor: "var(--nav-bg)" }}
    >
      {({ open }) => (
        <>
          <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 md:px-6 lg:px-8">
            <div className="flex items-center gap-8">
              <Link
                to="/"
                currentPath={currentPath}
                className="flex items-center text-heading"
                aria-label="Blouppy, home"
              >
                <BlouppyIcon className="block h-11 w-11 p-1.5 lg:hidden" />
                <BlouppyWithTextIcon className="hidden w-32 p-1.5 lg:block" />
              </Link>
              <div className="hidden items-center gap-7 md:flex">
                {links.map((item) => (
                  <Link
                    key={item.name}
                    to={item.href}
                    currentPath={currentPath}
                    className={isPartiallyActive(item.href, currentPath) ? activeLinkClassName : linkClassName}
                  >
                    {item.name}
                  </Link>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              {searchConfigured && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchRequested(true);
                      setToggleSearch(true);
                    }}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-heading"
                  >
                    <span className="sr-only">Search articles</span>
                    <MagnifyingGlassIcon className="h-5 w-5" aria-hidden="true" />
                  </button>
                  {/* The search's root is a flex item of this bar, gap included:
                      an empty one stands in until it loads. */}
                  {searchRequested ? (
                    <Suspense fallback={<div />}>
                      <Search indices={searchIndices} openModal={toggleSearch} modalClosed={setToggleSearch} />
                    </Suspense>
                  ) : (
                    <div />
                  )}
                </>
              )}
              <ThemeToggle />
              <a href={starterUrl} className="btn btn-sm ml-2 hidden sm:inline-flex" rel="noopener">
                Blouppy Starter
              </a>
              <Disclosure.Button className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-heading md:hidden">
                <span className="sr-only">{open ? "Close main menu" : "Open main menu"}</span>
                {open ? (
                  <XMarkIcon className="h-6 w-6" aria-hidden="true" />
                ) : (
                  <Bars3Icon className="h-6 w-6" aria-hidden="true" />
                )}
              </Disclosure.Button>
            </div>
          </div>

          <Disclosure.Panel className="border-t border-line md:hidden">
            <div className="space-y-1 px-4 pb-4 pt-3">
              {links.map((item) => (
                <Disclosure.Button
                  key={item.name}
                  as={Link}
                  to={item.href}
                  currentPath={currentPath}
                  className={mobileLinkClassName}
                >
                  {item.name}
                </Disclosure.Button>
              ))}
              <a href={starterUrl} className="btn w-full" rel="noopener">
                Blouppy Starter
              </a>
            </div>
          </Disclosure.Panel>
        </>
      )}
    </Disclosure>
  );
};
