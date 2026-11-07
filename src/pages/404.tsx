import React from 'react';
import { HeadProps } from 'gatsby';
import { ButtonInternalLink } from '../components/button';
import { Seo } from '../components/seo/Seo';

const NotFoundPage = () => (
    <div className="flex-grow mx-auto max-w-7xl w-full flex flex-col">
      <div className="flex-shrink-0 my-auto py-16 sm:py-32">
        <p className="text-sm font-semibold text-accent uppercase tracking-wide">404 error</p>
        <h1 className="mt-2 text-4xl font-extrabold text-heading tracking-tight sm:text-5xl">Page not found</h1>
        <p className="mt-2 text-base text-muted">Sorry, we couldn’t find the page you’re looking for.</p>
        <div className="mt-6">
          <ButtonInternalLink link="/" text="Go back home" />
        </div>
      </div>
    </div>
)

export const Head = ({ location }: HeadProps) => <Seo title="Page not found" pathname={location.pathname} noindex />

export default NotFoundPage
