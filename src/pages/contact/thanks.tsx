import React from 'react'
import { Seo } from "../../components/seo/Seo"
import { useSiteMetadata } from "../../hooks/useSiteMetadata"
import { ButtonInternalLink } from '../../components/button';

const Thanks = () => (
  <>
    <Head />
    <section className="min-h-full px-4 py-16 sm:px-6 sm:py-24 md:grid md:place-items-center lg:px-8">
      <main className="sm:flex">
        <p className="text-4xl font-extrabold text-accent sm:text-5xl">🙏🏼</p>
        <div className="sm:ml-6">
          <div className="sm:border-l sm:border-gray-200 sm:pl-6">
            <h1 className="text-4xl font-extrabold text-heading tracking-tight sm:text-5xl">Thank you for contacting me!</h1>
            <p className="mt-1 text-base text-gray-500"> I will answer you as soon as possible by e-mail. 😉</p>
          </div>
          <div className="mt-10 flex space-x-3 sm:border-l sm:border-transparent sm:pl-6">
            <ButtonInternalLink link="/" text="Go back home" />

            <ButtonInternalLink link="/contact" text=" Contact Me Again" />
          </div>
        </div>
      </main>
    </section>
  </>
)

const Head = () => {
  const { siteUrl } = useSiteMetadata();
  const description = "Thank you page"
  return <Seo title="Thanks" description={description} url={`${siteUrl}/contact/thanks`} />
};

export default Thanks;