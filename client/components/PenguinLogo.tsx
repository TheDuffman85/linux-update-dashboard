export function PenguinLogo({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Body */}
      <ellipse cx="32" cy="38" rx="18" ry="22" fill="#2d2d2d" />
      {/* Belly */}
      <ellipse cx="32" cy="42" rx="12" ry="16" fill="#f5f5f5" />
      {/* Left wing */}
      <ellipse cx="14" cy="36" rx="5" ry="14" fill="#2d2d2d" transform="rotate(10 14 36)" />
      {/* Right wing */}
      <ellipse cx="50" cy="36" rx="5" ry="14" fill="#2d2d2d" transform="rotate(-10 50 36)" />
      {/* Head */}
      <circle cx="32" cy="18" r="14" fill="#2d2d2d" />
      {/* Face */}
      <ellipse cx="32" cy="20" rx="10" ry="9" fill="#f5f5f5" />
      {/* Left eye */}
      <circle cx="27" cy="16" r="2.5" fill="#2d2d2d" />
      <circle cx="27.8" cy="15.3" r="0.8" fill="white" />
      {/* Right eye */}
      <circle cx="37" cy="16" r="2.5" fill="#2d2d2d" />
      <circle cx="37.8" cy="15.3" r="0.8" fill="white" />
      {/* Beak */}
      <path d="M29 21 L32 26 L35 21 Z" fill="#f59e0b" />
      {/* Feet */}
      <ellipse cx="25" cy="59" rx="6" ry="3" fill="#f59e0b" />
      <ellipse cx="39" cy="59" rx="6" ry="3" fill="#f59e0b" />
    </svg>
  );
}
