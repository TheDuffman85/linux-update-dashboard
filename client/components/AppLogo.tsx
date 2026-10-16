import { useState } from "react";
import { useBranding, type AppLogoVariant } from "../lib/branding";
import { PenguinLogo } from "./PenguinLogo";

/** Renders the first candidate that loads, falling back to the built-in logo. */
function LogoImage({
  candidates,
  size,
  className = "",
}: {
  candidates: Array<string | null>;
  size: number;
  className?: string;
}) {
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const src = candidates.find(
    (url): url is string => Boolean(url) && !failedUrls.includes(url as string),
  );

  if (!src) {
    return className ? (
      <span className={`shrink-0 ${className}`}>
        <PenguinLogo size={size} />
      </span>
    ) : (
      <PenguinLogo size={size} />
    );
  }

  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={`shrink-0 object-contain ${className}`.trim()}
      style={{ width: size, height: size }}
      onError={() => setFailedUrls((urls) => [...urls, src])}
    />
  );
}

/**
 * The configured logo. With a dark mode logo, both images are rendered and CSS
 * picks one by theme, so switching themes never waits for an image to load.
 * `variant` pins one of them, e.g. for the settings preview.
 */
export function AppLogo({
  size = 32,
  variant = "auto",
}: {
  size?: number;
  variant?: "auto" | AppLogoVariant;
}) {
  const { logoUrl, logoDarkUrl } = useBranding();

  if (variant === "default" || (variant === "auto" && !logoDarkUrl)) {
    return <LogoImage candidates={[logoUrl]} size={size} />;
  }
  if (variant === "dark") {
    return <LogoImage candidates={[logoDarkUrl, logoUrl]} size={size} />;
  }
  return (
    <>
      <LogoImage candidates={[logoUrl]} size={size} className="flex dark:hidden" />
      <LogoImage candidates={[logoDarkUrl, logoUrl]} size={size} className="hidden dark:flex" />
    </>
  );
}
