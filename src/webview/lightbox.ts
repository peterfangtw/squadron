/** The board's image viewer: open/close state and interaction stay webview-side. */

import { $, q } from './dom';

const root = $('lightbox');
const scrim = $('lscrim');
const image = q(root, 'img') as HTMLImageElement;
const caption = q(root, '.caption');
const close = q(root, '.close');

const maxScale = 4;
const zoomStep = 0.5;
const panStep = 40;

let source: HTMLElement | undefined;
let scale = 1;
let x = 0;
let y = 0;
let fitLeft = 0;
let fitTop = 0;
let fitWidth = 0;
let fitHeight = 0;
let drag: { pointerId: number; clientX: number; clientY: number; x: number; y: number } | undefined;
/** A pan happened, so the click it ends with is not a click outside. */
let dragged = false;

function writeTransform(): void {
  image.style.transform =
    scale === 1 && x === 0 && y === 0 ? '' : `translate(${x}px, ${y}px) scale(${scale})`;
  root.classList.toggle('zoomed', scale > 1);
}

function resetTransform(): void {
  scale = 1;
  x = 0;
  y = 0;
  drag = undefined;
  root.classList.remove('dragging');
  writeTransform();
}

function measureFit(): void {
  const box = image.getBoundingClientRect();
  fitLeft = box.left;
  fitTop = box.top;
  fitWidth = box.width;
  fitHeight = box.height;
}

function zoomTo(next: number, clientX: number, clientY: number): void {
  const clamped = Math.max(1, Math.min(maxScale, next));
  if (clamped === scale) return;
  if (scale === 1) measureFit();
  if (clamped === 1) {
    scale = 1;
    x = 0;
    y = 0;
    writeTransform();
    return;
  }
  // The translated point stays under the pointer as its distance from the
  // image's untransformed corner grows by the same ratio as the image.
  const ratio = clamped / scale;
  const pointerX = clientX - fitLeft;
  const pointerY = clientY - fitTop;
  x = pointerX - (pointerX - x) * ratio;
  y = pointerY - (pointerY - y) * ratio;
  scale = clamped;
  writeTransform();
}

function zoomFromKeyboard(delta: number): void {
  zoomTo(scale + delta, fitLeft + fitWidth / 2, fitTop + fitHeight / 2);
}

export function lightboxOpen(): boolean {
  return !root.hidden;
}

export function openLightbox({
  src,
  alt,
  caption: label,
  origin
}: {
  src: string;
  alt: string;
  caption: string;
  origin: HTMLElement;
}): void {
  source = origin;
  resetTransform();
  image.src = src;
  image.alt = alt;
  image.draggable = false;
  caption.textContent = label;
  scrim.hidden = false;
  root.hidden = false;
  measureFit();
  root.focus();
}

export function closeLightbox(): void {
  if (root.hidden) return;
  resetTransform();
  root.hidden = true;
  scrim.hidden = true;
  image.removeAttribute('src');
  source?.focus();
  source = undefined;
}

export function onLightboxKey(e: KeyboardEvent): void {
  if (!lightboxOpen()) return;
  const target = e.target;
  if (target instanceof Element && target.closest('#ask')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    closeLightbox();
    return;
  }
  // The dock stays live beside the image, so a key typed in the composer is
  // the composer's — only Escape above reaches across.
  if (!(target instanceof Node && root.contains(target))) return;
  if (e.key === '+' || e.key === '=') zoomFromKeyboard(zoomStep);
  else if (e.key === '-') zoomFromKeyboard(-zoomStep);
  else if (e.key === '0') resetTransform();
  else if (e.key === 'ArrowLeft' && scale > 1) x += panStep;
  else if (e.key === 'ArrowRight' && scale > 1) x -= panStep;
  else if (e.key === 'ArrowUp' && scale > 1) y += panStep;
  else if (e.key === 'ArrowDown' && scale > 1) y -= panStep;
  else if (!e.key.startsWith('Arrow')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  writeTransform();
}

close.onclick = closeLightbox;
// Not on #lscrim, which is painted under the frame's inset: 0 and so is never
// what a pointer lands on. The frame *is* the region around the image, so a
// press that lands on the frame itself — never on .lmodal or anything in it —
// is the click outside.
root.onclick = (e) => {
  // A pan releases over the frame whenever the pointer leaves the image, and
  // pointer capture sends that click here too. Closing on it would end the
  // session's image every time somebody dragged a zoomed one to its edge.
  if (dragged) {
    dragged = false;
    return;
  }
  if (e.target === root) closeLightbox();
};
root.onwheel = (e) => {
  e.preventDefault();
  zoomTo(scale - e.deltaY * 0.002, e.clientX, e.clientY);
};
root.ondblclick = (e) => {
  const target = e.target;
  if (target instanceof Element && target.closest('.close')) return;
  if (scale > 1) {
    resetTransform();
    return;
  }
  const naturalScale = fitWidth > 0 ? image.naturalWidth / fitWidth : 2;
  zoomTo(naturalScale, e.clientX, e.clientY);
};
root.onpointerdown = (e) => {
  const target = e.target;
  if (scale === 1 || e.button !== 0 || (target instanceof Element && target.closest('.close')))
    return;
  drag = { pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY, x, y };
  root.classList.add('dragging');
  root.setPointerCapture?.(e.pointerId);
};
root.onpointermove = (e) => {
  if (!drag || drag.pointerId !== e.pointerId) return;
  x = drag.x + e.clientX - drag.clientX;
  y = drag.y + e.clientY - drag.clientY;
  dragged = true;
  writeTransform();
};
const endDrag = (e: PointerEvent): void => {
  if (!drag || drag.pointerId !== e.pointerId) return;
  drag = undefined;
  root.classList.remove('dragging');
  if (root.hasPointerCapture?.(e.pointerId)) root.releasePointerCapture(e.pointerId);
};
root.onpointerup = endDrag;
root.onpointercancel = endDrag;
