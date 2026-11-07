import React from 'react';
import { Link } from '../link/Link';

export interface ButtonInternalLinkProps {
  text?: string;
  link?: string;
  className?: string;
  color?: 'primary' | 'basic';
  size?: 'sm' | 'md' | 'lg';

}

export const ButtonInternalLink = ({ text = "Button 1", link = "#", color = 'primary', size = 'md', className }: ButtonInternalLinkProps) => {
  const buttonColor = color === 'primary' ? "btn" : "btn-white-sm";

  let buttonSize = '';
  switch (size) {
    case 'sm':
      buttonSize = "text-sm";
      break;
    case 'md':
      buttonSize = "text-base";
      break;
    case 'lg':
      buttonSize = "text-lg";
      break;
  }

  return (
    <Link to={link} className={`${buttonColor} ${buttonSize} ${className}`}>
      {text}
    </Link>
  );
};
