import React from "react";

interface AstroidMarkProps {
  className?: string;
  size?: number;
}

export const AstroidMark: React.FC<AstroidMarkProps> = ({ className = "w-8 h-8", size }) => {
  const style = size ? { width: size, height: size } : undefined;
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      aria-label="AstroidBot Logo"
    >
      {/* Outer orbital ring */}
      <ellipse
        cx="16"
        cy="16"
        rx="13.5"
        ry="7.5"
        transform="rotate(-28 16 16)"
        stroke="#DEA34F"
        strokeWidth="1.5"
        strokeDasharray="42 8"
        strokeLinecap="round"
      />
      {/* Secondary orbital ring */}
      <ellipse
        cx="16"
        cy="16"
        rx="13.5"
        ry="7.5"
        transform="rotate(38 16 16)"
        stroke="#4B4032"
        strokeWidth="1.25"
        strokeDasharray="30 14"
        strokeLinecap="round"
      />
      {/* Central technical geometric core */}
      <circle cx="16" cy="16" r="4.5" fill="#DEA34F" />
      <circle cx="16" cy="16" r="2" fill="#1A1B1E" />
      {/* Signal / trajectory nodes */}
      <circle cx="26" cy="10" r="1.5" fill="#E6BF85" />
      <circle cx="6" cy="22" r="1.2" fill="#DEA34F" opacity="0.75" />
    </svg>
  );
};

export default AstroidMark;
