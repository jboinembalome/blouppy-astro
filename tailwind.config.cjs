const v3 = require("./tailwind.v3-theme.cjs");
const defaultTheme = require("tailwindcss/defaultTheme");

// The colours come from src/styles/tokens.css, the Blouppy Starter's design
// tokens. Roles (`bg-page`, `text-muted`, `border-line`...) are the default:
// they already know what they become in the dark scheme, so a component
// rarely needs a `dark:` variant. See the Starter's DESIGN.md §2.2.
const surface = Object.fromEntries(
  [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((step) => [step, `var(--blouppy-surface-${step})`]),
);

module.exports = {
  darkMode: "class",
  // .astro pages and layouts carry classes too; Markdown bodies are styled by prose.
  content: ["./src/**/*.{astro,ts,tsx,md}"],
  theme: {
    colors: {
      transparent: "transparent",
      current: "currentColor", // Useful to update the color of svg
      white: "#ffffff",
      primary: {
        DEFAULT: "#676dcf",
        50: "#f5f5fc",
        100: "#ebebf9",
        200: "#ced0f2",
        300: "#b5bfeb",
        400: "#8e93dc",
        500: "#676dcf",
        600: "#5052a7",
        700: "#3a3e80",
        800: "#262b5a",
        900: "#131633",
        950: "#0b0d1f",
      },
      surface,
      page: "var(--blouppy-bg)",
      soft: "var(--blouppy-bg-soft)",
      card: "var(--blouppy-card)",
      subtle: "var(--blouppy-bg-subtle)",
      hover: "var(--blouppy-bg-hover)",
      line: "var(--blouppy-border)",
      heading: "var(--blouppy-heading)",
      body: "var(--blouppy-text)",
      muted: "var(--blouppy-muted)",
      faint: "var(--blouppy-faint)",
      accent: {
        DEFAULT: "var(--blouppy-accent-text)",
        soft: "var(--blouppy-accent-soft)",
        border: "var(--blouppy-accent-border)",
      },
      fill: {
        DEFAULT: "var(--blouppy-primary-fill)",
        hover: "var(--blouppy-primary-fill-hover)",
        contrast: "var(--blouppy-primary-contrast)",
      },
      warn: {
        ...v3.colors.red,
      },
      slate: v3.colors.slate,
      gray: v3.colors.gray,
      zinc: v3.colors.zinc,
      red: v3.colors.red,
      orange: v3.colors.orange,
      yellow: v3.colors.yellow,
      green: v3.colors.green,
      emerald: v3.colors.emerald,
      blue: v3.colors.blue,
      indigo: v3.colors.indigo,
      purple: v3.colors.purple,
      amber: v3.colors.amber,
    },
    fontSize: v3.fontSize,
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', ...defaultTheme.fontFamily.sans],
        mono: ["ui-monospace", "SFMono-Regular", '"SF Mono"', "Menlo", "Consolas", '"Liberation Mono"', "monospace"],
      },
      boxShadow: {
        frame: "var(--frame-shadow)",
      },
      // The reading scale for articles, built on the same roles. Because the
      // roles follow `.dark` themselves, one theme serves both schemes and no
      // `dark:prose-invert` is needed.
      typography: () => ({
        blouppy: {
          css: {
            "--tw-prose-body": "var(--blouppy-text)",
            "--tw-prose-headings": "var(--blouppy-heading)",
            "--tw-prose-lead": "var(--blouppy-muted)",
            "--tw-prose-links": "var(--blouppy-accent-text)",
            "--tw-prose-bold": "var(--blouppy-heading)",
            "--tw-prose-counters": "var(--blouppy-muted)",
            "--tw-prose-bullets": "var(--blouppy-faint)",
            "--tw-prose-hr": "var(--blouppy-border)",
            "--tw-prose-quotes": "var(--blouppy-text)",
            "--tw-prose-quote-borders": "var(--blouppy-accent-border)",
            "--tw-prose-captions": "var(--blouppy-muted)",
            "--tw-prose-code": "var(--blouppy-heading)",
            "--tw-prose-pre-code": "#e2e8f0",
            "--tw-prose-pre-bg": "var(--code-bg)",
            "--tw-prose-th-borders": "var(--blouppy-border)",
            "--tw-prose-td-borders": "var(--blouppy-border)",
          },
        },
      }),
    },
  },
  plugins: [require("@tailwindcss/forms"), require("@tailwindcss/typography")],
};
