import React from "react";
import type { Topic } from "../../constants/topics";

interface TopicIconProps {
  topic: Topic;
  size?: "sm" | "md";
  className?: string;
}

// The Starter landing's feature tile: the icon in the accent colour on a soft
// accent square. Decorative: the topic's name is always written beside it.
export const TopicIcon = ({ topic, size = "md", className = "" }: TopicIconProps) => {
  const box = size === "sm" ? "h-8 w-8 rounded-lg" : "h-[42px] w-[42px] rounded-[10px]";
  const glyph = size === "sm" ? "h-4 w-4" : "h-5 w-5";

  return (
    <span className={`flex shrink-0 items-center justify-center bg-accent-soft text-accent ${box} ${className}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={glyph}>
        {topic.icon.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    </span>
  );
};
