import React from "react";

// What Gatsby's <Link> rendered, without its client-side router: an <a> whose
// internal path gets a trailing slash (Gatsby's default "always" option, which
// matches the URLs the pages are built at), and aria-current="page" when it
// points at the page being shown.
export const withTrailingSlash = (to: string): string => {
  if (!to.startsWith("/")) return to;
  const [, path, rest] = to.match(/^([^?#]*)(.*)$/) ?? [, to, ""];
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  return path.endsWith("/") || lastSegment.includes(".") ? to : `${path}/${rest}`;
};

type LinkProps = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  to: string;
  // The page's path, to mark the link pointing at it.
  currentPath?: string;
};

export const Link = React.forwardRef<HTMLAnchorElement, LinkProps>(({ to, currentPath, ...props }, ref) => {
  const href = withTrailingSlash(to);
  const isCurrent = currentPath !== undefined && href === withTrailingSlash(currentPath);
  return <a ref={ref} href={href} aria-current={isCurrent ? "page" : undefined} {...props} />;
});
Link.displayName = "Link";
