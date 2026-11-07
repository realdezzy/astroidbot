import React from "react";

interface AstroidBadgeProps {
  label: string;
  variant?: "amber" | "neutral" | "success" | "danger";
  size?: "sm" | "md";
  className?: string;
  icon?: React.ReactNode;
}

export const AstroidBadge: React.FC<AstroidBadgeProps> = ({
  label,
  variant = "amber",
  size = "sm",
  className = "",
  icon,
}) => {
  const variantStyles = {
    amber: "bg-badge-bg/50 text-brand-500 border-brand-500/30",
    neutral: "bg-bg-hover text-muted-text border-card-border",
    success: "bg-[#00E676]/10 text-[#00E676] border-[#00E676]/30",
    danger: "bg-[#FF2A4B]/10 text-[#FF2A4B] border-[#FF2A4B]/30",
  };

  const sizeStyles = {
    sm: "text-[10px] px-2 py-0.5 tracking-wider",
    md: "text-xs px-2.5 py-1 tracking-wide",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono font-semibold uppercase rounded-md border ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
    >
      {icon}
      <span>{label}</span>
    </span>
  );
};

export default AstroidBadge;
