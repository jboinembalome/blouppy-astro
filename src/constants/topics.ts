// The subjects of the blog. Each article has exactly one (`topic` in its front
// matter): it gives the article its icon, its place in the home page's filters
// and its link-preview image (static/img/topics/<slug>.jpg). Tags stay for the
// finer grain.
//
// The icons follow the Starter landing's feature icons (24px grid, 2px stroke,
// round caps); shield, architecture, realtime, tests and theme are its own.
export interface Topic {
  name: string;
  slug: string;
  description: string;
  icon: string[]; // SVG path data, drawn with stroke="currentColor"
}

export const topics: Topic[] = [
  {
    name: "Architecture",
    slug: "architecture",
    description: "How a code base is shaped, and how it stays that way.",
    icon: ["M4.5 3h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 8.5 10h-4A1.5 1.5 0 0 1 3 8.5v-4A1.5 1.5 0 0 1 4.5 3Z", "M15.5 3h4A1.5 1.5 0 0 1 21 4.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 14 8.5v-4A1.5 1.5 0 0 1 15.5 3Z", "M4.5 14h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 8.5 21h-4A1.5 1.5 0 0 1 3 19.5v-4A1.5 1.5 0 0 1 4.5 14Z", "M15.5 14h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4a1.5 1.5 0 0 1 1.5-1.5Z"],
  },
  {
    name: "Security",
    slug: "security",
    description: "Authentication, tokens, privacy and the attacks to keep out.",
    icon: ["M12 2 4 6v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6l-8-4Z", "m9 12 2 2 4-4"],
  },
  {
    name: "Messaging",
    slug: "messaging",
    description: "Events, queues, webhooks and real time.",
    icon: ["M13 2 4 14h7l-1 8 9-12h-7l1-8Z"],
  },
  {
    name: "Data",
    slug: "data",
    description: "EF Core, PostgreSQL, caching and migrations.",
    icon: ["M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3Z", "M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6", "M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"],
  },
  {
    name: "Testing",
    slug: "testing",
    description: "Tests that catch what matters, and benchmarks.",
    icon: ["M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Z", "m8.5 12 2.5 2.5 4.5-5"],
  },
  {
    name: "Front end",
    slug: "front-end",
    description: "Angular, components, theming and accessibility.",
    icon: ["M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z", "M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"],
  },
  {
    name: "C# & .NET",
    slug: "csharp-dotnet",
    description: "The language and the platform, feature by feature.",
    icon: ["m8 7-5 5 5 5", "m16 7 5 5-5 5", "m13.5 4-3 16"],
  },
  {
    name: "Tooling",
    slug: "tooling",
    description: "Linters, formatters, hooks and the tools around the code.",
    icon: ["M14.7 6.3a4 4 0 0 0-5.4 5.2L3.5 17.3a1.7 1.7 0 0 0 2.4 2.4l5.8-5.8a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6Z"],
  },
];

export const topicBySlug = (slug: string | null | undefined) => topics.find((topic) => topic.slug === slug);
export const topicByName = (name: string | null | undefined) => topics.find((topic) => topic.name === name);
