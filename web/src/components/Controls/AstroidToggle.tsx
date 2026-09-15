import React from "react";

interface AstroidToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}

export const AstroidToggle: React.FC<AstroidToggleProps> = ({
  checked,
  onChange,
  label,
  disabled = false,
  className = "",
}) => {
  return (
    <label
      className={`inline-flex items-center gap-2.5 cursor-pointer select-none ${
        disabled ? "opacity-40 cursor-not-allowed" : ""
      } ${className}`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors duration-200 ease-in-out focus:outline-none ${
          checked
            ? "bg-[#DEA34F] border-[#E6BF85]"
            : "bg-[#192939] border-[#3A393B]"
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full bg-[#1A1B1E] shadow-sm ring-0 transition duration-200 ease-in-out mt-[2px] ml-[2px] ${
            checked ? "translate-x-4 bg-[#FCFCFC]" : "translate-x-0"
          }`}
        />
      </button>
      {label && <span className="text-xs font-medium text-[#FCFCFC]">{label}</span>}
    </label>
  );
};

export default AstroidToggle;
