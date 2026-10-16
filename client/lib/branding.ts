import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { usePublicSettingsResponse, type PublicBranding } from "./settings";
import {
  BRANDING_THEME_STYLE_ID,
  buildBrandingThemeCss,
  normalizeBrandingTheme,
  type BrandingTheme,
} from "../../shared/branding-theme";

export type AppLogoVariant = "default" | "dark";

export const DEFAULT_APP_NAME = "Linux Update Dashboard";
export const APP_NAME_SETTING_KEY = "app_name";
export const MAX_APP_NAME_LENGTH = 60;
export const MAX_APP_LOGO_BYTES = 512 * 1024;
export const ACCEPTED_APP_LOGO_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
];

export function useBranding(): PublicBranding {
  const { data } = usePublicSettingsResponse();
  return {
    appName: data?.branding?.appName || DEFAULT_APP_NAME,
    logoUrl: data?.branding?.logoUrl ?? null,
    logoDarkUrl: data?.branding?.logoDarkUrl ?? null,
    theme: normalizeBrandingTheme(data?.branding?.theme),
  };
}

/** Applies the theme stylesheet, replacing the one the server injected into the page shell. */
export function applyThemeBranding(css: string): void {
  let style = document.getElementById(BRANDING_THEME_STYLE_ID);
  if (!css) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = BRANDING_THEME_STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

/** Keeps the browser tab title, favicon, and colors in sync with the configured branding. */
export function useDocumentBranding(): void {
  const { data } = usePublicSettingsResponse();
  const { appName, logoUrl, theme } = useBranding();
  const loaded = data !== undefined;
  const themeCss = buildBrandingThemeCss(theme);

  useEffect(() => {
    document.title = appName;
  }, [appName]);

  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (!link) return;
    link.dataset.defaultHref ??= link.getAttribute("href") ?? "";
    link.dataset.defaultType ??= link.getAttribute("type") ?? "";

    if (logoUrl) {
      link.removeAttribute("type");
      link.href = logoUrl;
    } else {
      link.href = link.dataset.defaultHref;
      if (link.dataset.defaultType) link.type = link.dataset.defaultType;
    }
  }, [logoUrl]);

  useEffect(() => {
    // Until the branding has loaded, keep the colors the server injected.
    if (loaded) applyThemeBranding(themeCss);
  }, [loaded, themeCss]);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

const PROFILE_PHOTO_SIZE = 640;
const PROFILE_PHOTO_PADDING = 0.14;

/**
 * Renders the logo centered on a white square JPEG. Services such as Telegram
 * bot profile photos only accept JPEG, so the browser converts it once here.
 * Returns undefined when the image cannot be rendered.
 */
async function renderProfilePhotoJpeg(dataUrl: string): Promise<string | undefined> {
  try {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = PROFILE_PHOTO_SIZE;
    canvas.height = PROFILE_PHOTO_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return undefined;

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, PROFILE_PHOTO_SIZE, PROFILE_PHOTO_SIZE);
    const available = PROFILE_PHOTO_SIZE * (1 - PROFILE_PHOTO_PADDING * 2);
    const width = image.naturalWidth || 1;
    const height = image.naturalHeight || 1;
    const scale = available / Math.max(width, height);
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    context.drawImage(
      image,
      (PROFILE_PHOTO_SIZE - drawWidth) / 2,
      (PROFILE_PHOTO_SIZE - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    return undefined;
  }
}

type BrandingMutationResponse = { status: string; branding: PublicBranding };

function useBrandingMutation<TVariables>(
  mutationFn: (variables: TVariables) => Promise<BrandingMutationResponse>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export function useUploadAppDarkLogo() {
  return useBrandingMutation(async (file: File) => {
    const dataUrl = await readFileAsDataUrl(file);
    return apiFetch<BrandingMutationResponse>("/settings/branding/logo/dark", {
      method: "PUT",
      body: JSON.stringify({ dataUrl }),
    });
  });
}

export function useResetAppDarkLogo() {
  return useBrandingMutation(() =>
    apiFetch<BrandingMutationResponse>("/settings/branding/logo/dark", { method: "DELETE" }),
  );
}

export function useUpdateAppTheme() {
  return useBrandingMutation((theme: BrandingTheme) =>
    apiFetch<BrandingMutationResponse>("/settings/branding/theme", {
      method: "PUT",
      body: JSON.stringify({ theme }),
    }),
  );
}

export function useUploadAppLogo() {
  return useBrandingMutation(async (file: File) => {
    const dataUrl = await readFileAsDataUrl(file);
    const jpegDataUrl = await renderProfilePhotoJpeg(dataUrl);
    return apiFetch<BrandingMutationResponse>("/settings/branding/logo", {
      method: "PUT",
      body: JSON.stringify({ dataUrl, jpegDataUrl }),
    });
  });
}

export function useResetAppLogo() {
  return useBrandingMutation(() =>
    apiFetch<BrandingMutationResponse>("/settings/branding/logo", { method: "DELETE" }),
  );
}
