import React from "react";

export interface ButtonProps
  extends
    React.DetailedHTMLProps<React.ButtonHTMLAttributes<HTMLButtonElement>, HTMLButtonElement>,
    React.AriaAttributes {
  text?: string;
  className?: string;
  color?: "primary" | "basic";
  size?: "sm" | "md" | "lg";
}

export const Button = ({ text = "Button 1", color = "primary", size = "md", className, ...rest }: ButtonProps) => {
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
    <button className={`${buttonColor} ${buttonSize} ${className}`} {...rest}>
      {text}
    </button>
  );
};
