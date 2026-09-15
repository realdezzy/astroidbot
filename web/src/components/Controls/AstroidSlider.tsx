import React from "react";

interface AstroidSliderProps {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  className?: string;
  disabled?: boolean;
}

export const AstroidSlider: React.FC<AstroidSliderProps> = ({
  min,
  max,
  step = 1,
  value,
  onChange,
  className = "",
  disabled = false,
}) => {
  const percentage = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));

  return (
    <div className={`relative w-full flex items-center select-none ${className}`}>
      {/* Background track (Dark Navy) */}
      <div className="w-full h-2 rounded-full bg-[#192939] relative overflow-hidden">
        {/* Filled track (Warm Amber) */}
        <div
          className="h-full bg-[#DEA34F] transition-all duration-75"
          style={{ width: `${percentage}%` }}
        />
      </div>

      {/* Actual Range Input overlaid */}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
      />

      {/* Visual Thumb */}
      <div
        className="absolute w-4 h-4 rounded-full bg-[#FCFCFC] border-2 border-[#DEA34F] shadow-sm pointer-events-none -translate-x-1/2 transition-all duration-75"
        style={{ left: `${percentage}%` }}
      />
    </div>
  );
};

export default AstroidSlider;
