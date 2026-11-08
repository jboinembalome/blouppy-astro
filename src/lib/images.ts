import { getImage } from "astro:assets";
import type { ImageMetadata } from "astro";

// The photos front matter points at as /img/<name> (the CMS writes those
// paths) are also kept in src/assets/photos, where Astro can resize them:
// the avatar is a 3,647px square shown at 40px.
const photos = import.meta.glob<{ default: ImageMetadata }>("/src/assets/photos/*.{jpg,jpeg,png,webp}", {
  eager: true,
});

export interface ImageSource {
  src: string;
  srcSet?: string;
  width?: number;
  height?: number;
}

// Shown on the page at both densities, in WebP; a link preview takes one JPEG,
// which every network reads.
export const photo = async (
  publicPath: string | undefined,
  width: number,
  height: number,
  { forSharing = false } = {},
): Promise<ImageSource | undefined> => {
  if (!publicPath) return undefined;
  const asset = photos[`/src/assets/photos/${publicPath.slice(publicPath.lastIndexOf("/") + 1)}`];
  if (!asset) return { src: publicPath };
  if (forSharing) {
    const image = await getImage({ src: asset.default, width, height, fit: "cover", format: "jpg" });
    return { src: image.src, width, height };
  }
  const image = await getImage({ src: asset.default, width, height, fit: "cover", densities: [1, 2] });
  return { src: image.src, srcSet: image.srcSet.attribute, width, height };
};
