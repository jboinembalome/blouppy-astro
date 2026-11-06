import React from "react";
import { Link } from "gatsby";
import { CheckIcon } from "@heroicons/react/24/outline";
import { Seo } from "../../components/seo/Seo";
import { useSiteMetadata } from "../../hooks/useSiteMetadata";

const Thanks = () => (
  <>
    <Head />
    <div className="mx-auto flex max-w-xl flex-col items-center py-10 text-center sm:py-16">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent" aria-hidden="true">
        <CheckIcon className="h-7 w-7" />
      </span>
      <h1 className="mt-6 text-3xl font-extrabold tracking-tight text-heading sm:text-4xl">Message sent</h1>
      <p className="mt-4 text-lg leading-relaxed text-muted">Thanks for writing. I'll reply by email as soon as I can.</p>
      <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
        <Link to="/" className="btn">
          Back to articles
        </Link>
        <Link to="/contact/" className="btn-outline">
          Send another message
        </Link>
      </div>
    </div>
  </>
);

const Head = () => {
  const { siteUrl } = useSiteMetadata();
  return <Seo title="Message sent" description="Your message has been sent." url={`${siteUrl}/contact/thanks`} />;
};

export default Thanks;
