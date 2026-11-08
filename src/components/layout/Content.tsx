import React from "react";

interface HTMLContentProps {
  content: string | TrustedHTML;
  className?: string;
}

export const HTMLContent = ({ content, className }: HTMLContentProps) => (
  <div className={className} dangerouslySetInnerHTML={{ __html: content }} />
);

interface ContentProps {
  content: JSX.Element;
  className?: string;
}

export const Content = ({ content, className }: ContentProps) => <div className={className}>{content}</div>;
