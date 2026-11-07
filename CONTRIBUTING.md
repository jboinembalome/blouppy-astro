# Contributing

Corrections and suggestions are welcome: open an issue, or a pull request against `master`. Please read the [code of conduct](CODE_OF_CONDUCT.md) first.

## Setup

```sh
npm install
npx playwright install chromium   # once, for the end-to-end tests
```

## Scripts

| Script                                    | What it does                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run dev`                             | Starts the Astro dev server on http://localhost:4321/.                                       |
| `npm run build`                           | Builds the site into `dist/`, then indexes the articles in Algolia (production builds only). |
| `npm run preview`                         | Serves `dist/` locally.                                                                      |
| `npm run check`                           | Type-checks the Astro pages and the TypeScript sources.                                      |
| `npm run lint`                            | Lints the sources with ESLint.                                                               |
| `npm run format` / `npm run format:check` | Formats the sources with Prettier, or checks they are.                                       |
| `npm run test:site`                       | Checks the built site: links, assets, SEO tags, feeds (needs `npm run build`).               |
| `npm run test:e2e`                        | Runs the end-to-end tests against the built site (needs `npm run build`).                    |

CI runs all of them on every pull request.

## Pull requests

1. Create a branch from `master`.
2. Keep the change focused, and describe what it changes and why.
3. Make sure `npm run check`, `npm run lint`, `npm run format:check`, `npm run build`, `npm run test:site` and `npm run test:e2e` pass.

## License

By contributing, you agree that your contributions will be licensed under the [MIT license](LICENSE).
