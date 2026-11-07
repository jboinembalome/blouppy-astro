# CONTRIBUTING

Contributions are always welcome, no matter how large or small. Before contributing,
please read the [code of conduct](CODE_OF_CONDUCT.md).

## Setup

> Install npm on your system: [Npm install](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)

### Install dependencies

> To install dependencies, run `npm install`.
Since this starter using the [netlify-dev](https://www.netlify.com/products/dev/#how-it-works), there could be further issues you, please check the [netlify-dev](https://github.com/netlify/netlify-dev) repository for further information and set up questions. 

```sh
$ git clone https://github.com/netlify-templates/blouppy
$ npm install 
```

## Available scripts


### `build`

Builds the static site into `dist/` (`astro build`), then pushes the articles to Algolia when `ALGOLIA_ADMIN_KEY` is set.

### `check`

Type-checks the Astro pages and the TypeScript sources (`astro check`), as CI does.

### `netlify dev`

Starts the netlify dev environment, including the Astro dev server.
For more infor check the [Netlify Dev Docs](https://github.com/netlify/cli/blob/master/docs/netlify-dev.md)

```sh
netlify dev
```

### `develop` or `start`

Starts the Astro dev server (`astro dev`). We recommend using this command when you don't need Netlify specific features

### `test`

Not implmented yet

### `format`

Formats code and docs according to our style guidelines using `prettier`

#### Usage

```sh
npm run format
```


## Pull Requests

We actively welcome your pull requests!

If you need help with Git or our workflow, please ask on [Gitter.im](https://gitter.im/netlify/NetlifyCMS). We want your contributions even if you're just learning Git. Our maintainers are happy to help!

Netlify CMS uses the [Forking Workflow](https://www.atlassian.com/git/tutorials/comparing-workflows/forking-workflow) + [Feature Branches](https://www.atlassian.com/git/tutorials/comparing-workflows/feature-branch-workflow). Additionally, PR's should be [rebased](https://www.atlassian.com/git/tutorials/merging-vs-rebasing) on master when opened, and again before merging.

1. Fork the repo.
2. Create a branch from `master`. If you're addressing a specific issue, prefix your branch name with the issue number.
2. If you've added code that should be tested, add tests.
3. If you've changed APIs, update the documentation.
4. Use `npm run format` to format and lint your code.
5. PR's must be rebased before merge (feel free to ask for help).
6. PR should be reviewed by two maintainers prior to merging.

## License

By contributing to the Gatsby - Netlify CMS starter, you agree that your contributions will be licensed
under its [MIT license](LICENSE).
