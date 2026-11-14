import type * as model from './model';

export function imageBlocks(images: readonly ComposerImage[]): model.ImageBlock[] {
  return images.map((image) => ({
    mediaType: image.mediaType,
    data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1)
  }));
}
