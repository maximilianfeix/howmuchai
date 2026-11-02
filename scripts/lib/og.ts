import { Resvg } from "@resvg/resvg-js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderOg } from "../../src/core/render";
import type { Report } from "../../src/core/types";

const FONT_DIR = resolve(import.meta.dirname, "../../assets/fonts");
/** Bundled OFL fonts (see assets/fonts/OFL-*.txt). System fonts are never used, so images look the same on every machine. */
export const OG_FONTS = ["FiraSans-Regular.ttf", "FiraSans-SemiBold.ttf", "FiraSans-Bold.ttf", "IBMPlexMono-Regular.ttf", "IBMPlexMono-Bold.ttf"].map((f) => join(FONT_DIR, f));

export function renderOgPng(r: Report): Buffer {
  const missing = OG_FONTS.filter((f) => !existsSync(f));
  if (missing.length) throw new Error(`missing font files for OG images: ${missing.join(", ")}`);
  return new Resvg(renderOg(r), {
    fitTo: { mode: "width", value: 1200 },
    font: { loadSystemFonts: false, fontFiles: OG_FONTS, defaultFontFamily: "Fira Sans", sansSerifFamily: "Fira Sans", monospaceFamily: "IBM Plex Mono" },
  })
    .render()
    .asPng();
}
