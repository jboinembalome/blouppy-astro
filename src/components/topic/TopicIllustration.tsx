import React from "react";
import { topicByName } from "../../constants/topics";

interface TopicIllustrationProps {
  topic: string | null | undefined;
  // Which of the topic's three illustrations (front matter `illustration`).
  variant?: number | null;
  className?: string;
}

// A post's picture: its topic's illustration, on the soft accent panel of the
// Starter's feature tiles. Each illustration has a light and a dark file
// (static/img/illustrations), and the scheme decides which one shows.
export const TopicIllustration = ({ topic, variant, className = "" }: TopicIllustrationProps) => {
  const found = topicByName(topic);
  if (!found) return null;
  const index = variant && variant >= 1 && variant <= 3 ? variant : 1;
  const file = (scheme: "light" | "dark") => `/img/illustrations/${found.slug}-${index}-${scheme}.svg`;

  return (
    <div className={`flex items-center justify-center bg-accent-soft ${className}`} aria-hidden="true">
      <img
        src={file("light")}
        alt=""
        loading="lazy"
        className="h-full max-h-full w-auto max-w-[85%] object-contain dark:hidden"
      />
      <img
        src={file("dark")}
        alt=""
        loading="lazy"
        className="hidden h-full max-h-full w-auto max-w-[85%] object-contain dark:block"
      />
    </div>
  );
};
