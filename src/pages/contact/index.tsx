import React, { ChangeEvent, FormEvent, useState } from "react";
import { navigate } from "gatsby-link";
import { GithubIcon, LinkedInIcon } from "../../components/icons/svg/social/Icons";
import { Seo } from "../../components/seo/Seo";
import { useSiteMetadata } from "../../hooks/useSiteMetadata";

const description = "A question about an article, an idea for the next one, or something you're building? Write to me.";

const Head = () => {
  const { siteUrl } = useSiteMetadata();
  return <Seo title="Contact" description={description} url={`${siteUrl}/contact`} />;
};

const fieldClassName =
  "block w-full rounded-lg border-line bg-page px-3.5 py-2.5 text-heading shadow-sm placeholder:text-faint focus:border-accent focus:ring-accent";

const labelClassName = "mb-1.5 block text-sm font-medium text-heading";

interface ChannelProps {
  href: string;
  icon: React.ReactNode;
  label: string;
  value: string;
  external?: boolean;
}

// The topic tile of the article breadcrumb, here beside each way to reach me.
const Channel = ({ href, icon, label, value, external }: ChannelProps) => (
  <li>
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="group flex items-center gap-3 rounded-xl border border-line bg-card p-3 transition-colors hover:border-accent-border"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-heading group-hover:text-accent">{label}</span>
        <span className="block truncate text-sm text-muted">{value}</span>
      </span>
    </a>
  </li>
);

const Index = () => {
  const [fields, setFields] = useState<Record<string, string>>({});
  const { social } = useSiteMetadata();

  const handleChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFields((current) => ({ ...current, [name]: value }));
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    fetch("/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: encode({ "form-name": form.getAttribute("name") ?? "contact", ...fields }),
    })
      .then(() => navigate(form.getAttribute("action") ?? ""))
      .catch((error) => alert(error));
  };

  return (
    <>
      <Head />
      <div className="mx-auto max-w-5xl">
        <header className="mb-10 max-w-2xl">
          <h1 className="text-3xl font-extrabold tracking-tight text-heading sm:text-4xl">Contact</h1>
          <p className="mt-4 text-lg leading-relaxed text-muted">{description}</p>
          <p className="mt-2 text-base text-faint">I read every message and reply by email.</p>
        </header>

        <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_17rem] md:gap-10">
          <form
            name="contact"
            method="post"
            action="/contact/thanks/"
            data-netlify="true"
            data-netlify-honeypot="bot-field"
            onSubmit={handleSubmit}
            className="grid gap-5 rounded-xl border border-line bg-card p-5 shadow-sm sm:grid-cols-2 sm:p-8"
          >
            {/* The `form-name` hidden field lets the form be submitted without JavaScript. */}
            <input type="hidden" name="form-name" value="contact" />
            <div hidden>
              <label>
                Don’t fill this out: <input name="bot-field" onChange={handleChange} />
              </label>
            </div>
            <div>
              <label htmlFor="name" className={labelClassName}>
                Name
              </label>
              <input type="text" id="name" name="name" autoComplete="name" onChange={handleChange} required className={fieldClassName} />
            </div>
            <div>
              <label htmlFor="email" className={labelClassName}>
                Email
              </label>
              <input type="email" id="email" name="email" autoComplete="email" onChange={handleChange} required className={fieldClassName} />
            </div>
            <div className="sm:col-span-2">
              <div className="mb-1.5 flex items-baseline justify-between">
                <label htmlFor="message" className="text-sm font-medium text-heading">
                  Message
                </label>
                <span id="message-max" className="text-sm text-faint">
                  500 characters max.
                </span>
              </div>
              <textarea
                id="message"
                name="message"
                rows={6}
                maxLength={500}
                onChange={handleChange}
                required
                aria-describedby="message-max"
                className={fieldClassName}
              />
            </div>
            <div className="sm:col-span-2 sm:flex sm:justify-end">
              <button type="submit" className="btn w-full sm:w-auto">
                Send message
              </button>
            </div>
          </form>

          <aside aria-labelledby="elsewhere-title">
            <h2 id="elsewhere-title" className="section-kicker">
              Also on
            </h2>
            <p className="mb-4 text-sm text-muted">Or reach me where you already are.</p>
            <ul className="grid gap-3">
              <Channel href={social?.linkedinUrl ?? ""} icon={<LinkedInIcon className="h-5 w-5" />} label="LinkedIn" value="Jimmy Boinembalome" external />
              <Channel href={social?.githubUrl ?? ""} icon={<GithubIcon className="h-5 w-5" />} label="GitHub" value="jboinembalome" external />
            </ul>
          </aside>
        </div>
      </div>
    </>
  );
};

export default Index;

function encode(data: Record<string, string>) {
  return Object.keys(data)
    .map((key) => encodeURIComponent(key) + "=" + encodeURIComponent(data[key]))
    .join("&");
}
