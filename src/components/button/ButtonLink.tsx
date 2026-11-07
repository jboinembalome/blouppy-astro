import React from "react";

export interface ButtonLinkProps
  extends
    React.DetailedHTMLProps<React.AnchorHTMLAttributes<HTMLAnchorElement>, HTMLAnchorElement>,
    React.AriaAttributes {
  text?: string;
  link?: string;
  className?: string;
  color?: "primary" | "basic";
  size?: "sm" | "md" | "lg";
}

export const ButtonLink = ({
  text = "Button 1",
  link = "#",
  color = "primary",
  size = "md",
  className,
  ...rest
}: ButtonLinkProps) => {
  const buttonColor = color === "primary" ? "btn" : "btn-white-sm";

  let buttonSize = "";
  switch (size) {
    case "sm":
      buttonSize = "text-sm";
      break;
    case "md":
      buttonSize = "text-base";
      break;
    case "lg":
      buttonSize = "text-lg";
      break;
  }

  return (
    <a href={link} className={`${buttonColor} ${buttonSize} ${className}`} {...rest}>
      {text}
    </a>
  );
};
