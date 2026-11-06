import React, { ChangeEvent, FormEvent, useState } from 'react'
import { navigate } from 'gatsby-link'
import { EnvelopeIcon } from '@heroicons/react/24/outline'
import { LinkedInIcon, TwitterIcon } from '../../components/icons/svg/social/Icons'
import { Seo } from "../../components/seo/Seo"
import { useSiteMetadata } from "../../hooks/useSiteMetadata"

const description = "Would you like to contact me? Send me a message via the form or send me an e-mail. I will be happy to answer you!";

const Head = () => {
  const { siteUrl } = useSiteMetadata();
  return <Seo title="Contact" description={description} url={`${siteUrl}/contact`} />
};

const Index = () => {
  const [state, setState] = useState({});
  const siteMetadata = useSiteMetadata();


  const handleChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setState({ [e.target.name]: e.target.value })
  }

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encode({
        'form-name': form.getAttribute('name'),
        ...state,
      }),
    })
      .then(() => navigate(form.getAttribute('action') ?? ""))
      .catch((error) => alert(error))
  }

  return (
    <>
      <Head />
      <div className="bg-soft">
        <div className="relative bg-card border border-line rounded-xl">
          <h2 className="sr-only">Contact me</h2>

          <div className="grid grid-cols-1 lg:grid-cols-3">
            <div className="relative overflow-hidden py-10 px-6 border border-transparent rounded-t-lg lg:rounded-l-lg shadow bg-primary-600 dark:bg-primary-300 sm:px-10 xl:p-12">
              <h3 className="text-lg font-medium text-white dark:text-gray-900">Contact Me</h3>
              <p className="mt-6 text-sm md:text-base text-primary-50 dark:text-gray-900 max-w-3xl">
                {description}
              </p>
              <dl className="mt-8 space-y-6">
                <dt>
                  <span className="sr-only">Email</span>
                </dt>
                <dd className="flex text-sm md:text-base text-primary-50 dark:text-gray-900">
                  <EnvelopeIcon className="flex-shrink-0 w-6 h-6 text-primary-200 dark:text-gray-900" aria-hidden="true" />
                  <span className="ml-3">jboinembalome@gmail.com</span>
                </dd>
              </dl>
              <ul role="list" className="mt-8 flex space-x-12">
                <li>
                  <a className="text-primary-200 dark:text-gray-900 hover:text-primary-100 dark:hover:text-gray-900" href={siteMetadata?.social?.linkedinUrl} target="_blank">
                    <span className="sr-only">LinkedIn</span>
                    <LinkedInIcon className="w-6 h-6" />
                  </a>
                </li>
                <li>
                  <a className="text-primary-200 dark:text-gray-900 hover:text-primary-100 dark:hover:text-gray-900" href={siteMetadata?.social?.twitterUrl} target="_blank">
                    <span className="sr-only">Twitter</span>
                    <TwitterIcon className="w-6 h-6" />
                  </a>
                </li>
              </ul>
            </div>
            <div className="py-10 px-6 sm:px-10 lg:col-span-2 xl:p-12">
              <h3 className="text-lg font-medium text-heading">Send me a message</h3>
              <form name="contact" method="post" action="/contact/thanks/"
                data-netlify="true" data-netlify-honeypot="bot-field"
                onSubmit={handleSubmit}
                className="mt-6 grid grid-cols-1 gap-y-6 sm:grid-cols-2 sm:gap-x-8">
                {/* The `form-name` hidden field is required to support form submissions without JavaScript */}
                <input type="hidden" name="form-name" value="contact" />
                <div hidden>
                  <label>
                    Don’t fill this out:{' '}
                    <input name="bot-field" onChange={handleChange} />
                  </label>
                </div>
                <div>
                  <label htmlFor="first-name" className="block text-sm font-medium text-heading">
                    First name
                  </label>
                  <div className="mt-1">
                    <input
                      type="text"
                      id={'first-name'}
                      name={'first-name'}
                      autoComplete="given-name"
                      onChange={handleChange}
                      required={true}
                      className="py-3 px-4 block w-full shadow-sm bg-page text-heading focus:ring-primary-400 focus:border-primary-400 border-line rounded-md"
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="last-name" className="block text-sm font-medium text-heading">
                    Last name
                  </label>
                  <div className="mt-1">
                    <input
                      type="text"
                      id={'last-name'}
                      name={'last-name'}
                      autoComplete="family-name"
                      onChange={handleChange}
                      required={true}
                      className="py-3 px-4 block w-full shadow-sm bg-page text-heading focus:ring-primary-400 focus:border-primary-400 border-line rounded-md"
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-heading">
                    Email
                  </label>
                  <div className="mt-1">
                    <input
                      type="email"
                      id={'email'}
                      name={'email'}
                      autoComplete="email"
                      onChange={handleChange}
                      required={true}
                      className="py-3 px-4 block w-full shadow-sm bg-page text-heading focus:ring-primary-400 focus:border-primary-400 border-line rounded-md"
                    />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between">
                    <label htmlFor="phone" className="block text-sm font-medium text-heading">
                      Phone
                    </label>
                    <span id="phone-optional" className="text-sm text-muted">
                      Optional
                    </span>
                  </div>
                  <div className="mt-1">
                    <input
                      type="text"
                      id={'phone'}
                      name={'phone'}
                      autoComplete="tel"
                      onChange={handleChange}
                      required={false}
                      className="py-3 px-4 block w-full shadow-sm bg-page text-heading focus:ring-primary-400 focus:border-primary-400 border-line rounded-md"
                      aria-describedby="phone-optional"
                    />
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="subject" className="block text-sm font-medium text-heading">
                    Subject
                  </label>
                  <div className="mt-1">
                    <input
                      type="text"
                      id={'subject'}
                      name={'subject'}
                      onChange={handleChange}
                      required={true}
                      // autocomplete="off"
                      className="py-3 px-4 block w-full shadow-sm bg-page text-heading focus:ring-primary-400 focus:border-primary-400 border-line rounded-md"
                    />
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <div className="flex justify-between">
                    <label htmlFor="message" className="block text-sm font-medium text-heading">
                      Message
                    </label>
                    <span id="message-max" className="text-sm text-muted">
                      Max. 500 characters
                    </span>
                  </div>
                  <div className="mt-1">
                    <textarea
                      id={'message'}
                      name={'message'}
                      onChange={handleChange}
                      required={true}
                      className="py-3 px-4 block w-full shadow-sm bg-page text-heading focus:ring-primary-400 focus:border-primary-400 border border-line rounded-md"
                      aria-describedby="message-max"
                      maxLength={500}
                      defaultValue={''}
                    />
                  </div>
                </div>
                <div className="sm:col-span-2 sm:flex sm:justify-end">
                  <button
                    type="submit"
                    className="btn mt-2 w-full sm:w-auto"
                  >
                    Submit
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export default Index;

function encode(data: any) {
  return Object.keys(data)
    .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(data[key]))
    .join('&')
}

