import React from "react";

interface AstroidOrbitalProps {
  children?: React.ReactNode;
  className?: string;
  size?: number;
}

export const AstroidOrbital: React.FC<AstroidOrbitalProps> = ({
  children,
  className = "",
  size = 40,
}) => {
  return (
    <div
      className={`relative flex items-center justify-center rounded-xl bg-[#262729] border border-[#3A393B] ${className}`}
      style={{ width: size, height: size }}
    >
      {/* Subtle orbital perimeter indicator */}
      <span
        className="absolute inset-0 rounded-xl border border-[#DEA34F]/20 pointer-events-none"
        style={{ animation: "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite" }}
      />
      <div className="relative z-10">{children}</div>
    </div>
  );
};

export default AstroidOrbital;
