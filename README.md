# Blouppy : Personal website of Jimmy Boinembalome

[![Netlify Status](https://api.netlify.com/api/v1/badges/b654c94e-08a6-4b79-b443-7837581b1d8d/deploy-status)](https://app.netlify.com/sites/blouppy-ci/deploys)

**Note:** Blouppy uses [Astro 7](https://astro.build/), with React for the interactive parts.

This repository contains the source code for the **[Blouppy](https://www.blouppy.com/)** website that is built with [Astro](https://astro.build/), [Decap CMS](https://decapcms.org) and [Tailwind](https://tailwindcss.com/).

It follows the [JAMstack architecture](https://jamstack.org) by using Git as a single source of truth, and [Netlify](https://www.netlify.com) for continuous deployment.

## Features

- A simple landing page as a home page
- Editable Pages: Landing, About, Resume, Portfolio, Blog-Collection and Contact page with Netlify Form support
- Create Blog posts with pagination from Netlify CMS
- Tags: Separate page for posts under each tag
- Basic directory organization
- Uses Tailwind V3 for styling
- Dark Mode with Tailwind V3
- Blog search with Algolia
- Widget BuyMeACoffee
- Pre-rendered HTML, with JavaScript only for the interactive parts (navigation, search, article list, table of contents, comments, contact form)
- Author photos resized by `astro:assets`; CMS previews render the site's own templates
- Separate components for everything
- Netlify deploy configuration
- Netlify function support, see `lambda` folder
- Perfect score on Lighthouse for SEO, Accessibility and Performance (wip:PWA)
- ..and more

## Prerequisites

- Node 22.23.4 or higher
- [Netlify CLI](https://github.com/netlify/cli)

## Getting Started (Recommended)

Netlify CMS can run in any frontend web environment, but the quickest way to try it out is by running it on a pre-configured starter site with Netlify. (adapted from [One Click Hugo CMS](https://github.com/netlify-templates/one-click-hugo-cms)). Use the button below to build and deploy your own copy of the repository:

<a href="https://app.netlify.com/start/deploy?repository=https://github.com/jboinembalome/blouppy-blog&amp;stack=cms"><img src="https://www.netlify.com/img/deploy/button.svg" alt="Deploy to Netlify"></a>

After clicking that button, you’ll authenticate with GitHub and choose a repository name. Netlify will then automatically create a repository in your GitHub account with a copy of the files from the template. Next, it will build and deploy the new site on Netlify, bringing you to the site dashboard when the build is complete. Next, you’ll need to set up Netlify’s Identity service to authorize users to log in to the CMS.

### Access Locally

Pulldown a local copy of the Github repository Netlify created for you, with the name you specified in the previous step
```
$ git clone https://github.com/[GITHUB_USERNAME]/[REPO_NAME].git
$ cd [REPO_NAME]
$ npm install
$ netlify dev # or ntl dev
```

This uses the new [Netlify Dev](https://www.netlify.com/products/dev/?utm_source=blog&utm_medium=netlifycms&utm_campaign=devex) CLI feature to serve any functions you have in the `lambda` folder.

To test the CMS locally, you'll need to run a production build of the site:

```
$ npm run build
$ netlify dev # or ntl dev
```

## CONTRIBUTING

Contributions are always welcome, no matter how large or small. Before contributing,
please read the [code of conduct](CODE_OF_CONDUCT.md).
