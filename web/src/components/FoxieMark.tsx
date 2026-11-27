import React from "react";

interface FoxieMarkProps {
  className?: string;
}

export const FoxieMark: React.FC<FoxieMarkProps> = ({ className = "h-8 w-8" }) => (
  <svg
    viewBox="0 0 36 36"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    <rect
      x="1.5"
      y="1.5"
      width="33"
      height="33"
      rx="8"
      fill="#F2EFE8"
      stroke="#DED8CB"
      strokeWidth="1.2"
    />
    <path
      d="M8.5 9.5L13.5 14.5H22.5L27.5 9.5L25.5 22.5L18 28L10.5 22.5L8.5 9.5Z"
      fill="#C66A3D"
      stroke="#1C1A18"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    <path
      d="M11 22L18 28L25 22L21.5 20.5L18 23L14.5 20.5L11 22Z"
      fill="#FAF9F5"
    />
    <circle cx="14.2" cy="18.6" r="1.25" fill="#1C1A18" />
    <circle cx="21.8" cy="18.6" r="1.25" fill="#1C1A18" />
    <circle cx="18" cy="24.5" r="1.1" fill="#1C1A18" />
  </svg>
);
