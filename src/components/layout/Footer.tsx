import React from "react";
import { Link } from "gatsby";
import { GithubIcon, LinkedInIcon, TwitterIcon } from "../icons/svg/social/Icons";
import { BlouppyWithTextIcon } from "../icons/svg/BlouppyWithTextIcon";
import { useSiteMetadata } from "../../hooks/useSiteMetadata";
import { starterDocsUrl, starterUrl } from "../../constants/starter";
import { openConsentSettings } from "../consent/consent";

interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

const columns: { title: string; links: FooterLink[] }[] = [
  {
    title: "Blog",
    links: [
      { label: "Articles", href: "/" },
      { label: "Tags", href: "/tags" },
      { label: "About", href: "/about" },
      { label: "Contact", href: "/contact" },
    ],
  },
  {
    title: "Blouppy Starter",
    links: [
      { label: "Overview", href: starterUrl, external: true },
      { label: "Documentation", href: starterDocsUrl, external: true },
    ],
  },
];

const linkClassName = "block py-1 text-zinc-400 hover:text-white";

// Dark in both schemes, as the Starter's landing footer is.
export const Footer = () => {
  const siteMetadata = useSiteMetadata();

  const social = [
    { name: "LinkedIn", href: siteMetadata?.social?.linkedinUrl, Icon: LinkedInIcon },
    { name: "Twitter", href: siteMetadata?.social?.twitterUrl, Icon: TwitterIcon },
    { name: "GitHub", href: siteMetadata?.social?.githubUrl, Icon: GithubIcon },
  ];

  return (
    <footer className="bg-zinc-950 px-4 pb-8 pt-16 text-sm text-zinc-400 md:px-6 lg:px-8 dark:border-t dark:border-line dark:bg-slate-950">
      <div className="mx-auto w-full max-w-6xl">
        <div className="mb-12 grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr]">
          <div>
            <Link to="/" className="mb-3.5 flex items-center text-white" aria-label="Blouppy, home">
              <BlouppyWithTextIcon className="w-32" />
            </Link>
            <p className="max-w-xs">
              Articles on software engineering: architecture, security, testing, back end and front end.
            </p>
            <ul role="list" className="mt-6 flex gap-5">
              {social.map(({ name, href, Icon }) => (
                <li key={name}>
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-zinc-400 hover:text-white">
                    <span className="sr-only">{name}</span>
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {columns.map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <h3 className="mb-4 text-[0.84375rem] font-bold uppercase tracking-[0.08em] text-white">{column.title}</h3>
              <ul className="m-0 list-none p-0">
                {column.links.map((link) => (
                  <li key={link.label}>
                    {link.external ? (
                      <a className={linkClassName} href={link.href} rel="noopener">
                        {link.label}
                      </a>
                    ) : (
                      <Link className={linkClassName} to={link.href}>
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="flex flex-wrap justify-between gap-3 border-t border-zinc-800 pt-6 text-[0.8125rem] text-zinc-400">
          <span>&copy; {new Date().getFullYear()} Blouppy. All rights reserved.</span>
          <span className="flex flex-wrap gap-x-5 gap-y-2">
            <button type="button" className="text-zinc-400 hover:text-white" onClick={openConsentSettings}>
              Cookie settings
            </button>
            <span>Built with Gatsby &amp; Tailwind CSS</span>
          </span>
        </div>
      </div>
    </footer>
  );
};
