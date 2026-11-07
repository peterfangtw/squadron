let lastFill = '';

/** The host may supply any warning hue; choose ink from the rendered fill. */
export function sync(sample: HTMLElement): void {
  if (typeof CanvasRenderingContext2D === 'undefined') return;
  const fill = getComputedStyle(sample).backgroundColor;
  const base = getComputedStyle(document.body).backgroundColor;
  const signature = `${fill}:${base}`;
  if (signature === lastFill) return;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return;
  context.fillStyle = base;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = fill;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
  const linear = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const ink = (brightness: number): string => {
    const luminance =
      0.2126 * linear(Math.min(255, red * brightness)) +
      0.7152 * linear(Math.min(255, green * brightness)) +
      0.0722 * linear(Math.min(255, blue * brightness));
    return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000' : '#fff';
  };
  document.documentElement.style.setProperty('--av-warning-ink', ink(1));
  document.documentElement.style.setProperty('--av-warning-hover-ink', ink(1.12));
  lastFill = signature;
}
