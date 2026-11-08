import * as React from "react";

interface SvgSelectedProps extends React.ComponentPropsWithoutRef<"svg"> {
  selected?: boolean;
}

export const Pc = ({ selected, ...props }: SvgSelectedProps) => (
  <svg viewBox="0 0 24 24" fill="none" {...props}>
    <path
      d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z"
      strokeWidth="2"
      strokeLinejoin="round"
      className={selected ? "stroke-primary-400 fill-primary-300/20" : "stroke-gray-400 dark:stroke-gray-500"}
    />
    <path
      d="M14 15c0 3 2 5 2 5H8s2-2 2-5"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={selected ? "stroke-primary-400" : "stroke-gray-400 dark:stroke-gray-500"}
    />
  </svg>
);
