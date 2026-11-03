export const css = /* css */ `
  /* The image lightbox: a bare image over the board, with no sheet chrome. */
  /* 26/27 clears the bottom drawer (23), its portalled menus (25), and the
     café (20), while staying under #scrim (30) and #ask (31): a permission or
     question remains answerable over an image being inspected. #board is not a
     stacking context, so these ranks compare with the root ladder directly. */
  #lscrim {
    position: absolute; inset: 0; z-index: 26;
    background: rgba(0, 0, 0, .72);
  }
  /* The region around the image, and the whole of what "outside" means: a click
     landing here closes. It cannot be #lscrim's job — the frame is inset: 0 over
     it, so the backdrop is painted by one element and clicked on another. */
  #lightbox {
    position: absolute; inset: 0; z-index: 27;
    display: grid; place-items: center; padding: 24px;
    box-sizing: border-box; outline: none; touch-action: none;
  }
  /* max-height against the grid area, which is definite because #lightbox is
     inset: 0 — that is what keeps the image's own max-height: 100% resolvable
     one level down. The row pair is here rather than on the frame for the same
     reason it used to be there: it gives the image row a definite size. */
  .lmodal {
    position: relative; max-width: 100%; max-height: 100%; overflow: hidden;
    display: grid; grid-template-rows: minmax(0, 1fr) auto;
    place-items: center; gap: 10px; padding: 10px;
    box-sizing: border-box; border-radius: 10px;
    background: var(--av-card); border: 1px solid var(--av-border);
    box-shadow: 0 8px 28px var(--av-shadow-2);
  }
  #lscrim[hidden], #lightbox[hidden] { display: none; }
  .lmodal img {
    display: block; max-width: 100%; max-height: 100%; object-fit: contain;
    transform-origin: 0 0; cursor: zoom-in; user-select: none;
  }
  #lightbox.zoomed img { cursor: grab; }
  #lightbox.dragging img { cursor: grabbing; }
  .lmodal .caption {
    max-width: 100%; min-height: 1em; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; color: var(--av-fg-2); font-size: var(--av-fs-sm);
  }
  .lmodal .close {
    position: absolute; top: 10px; right: 10px; z-index: 1;
    display: grid; place-items: center; width: 30px; height: 30px;
    border: 1px solid color-mix(in srgb, var(--av-btn-fg) 35%, var(--av-btn-bg));
    border-radius: 50%; background: var(--av-btn-bg); color: var(--av-btn-fg);
    font: inherit; font-size: 17px; line-height: 1; cursor: pointer;
  }
  .lmodal .close:hover {
    background: color-mix(in srgb, var(--av-btn-fg) 14%, var(--av-btn-bg));
  }
  .lmodal .close:focus-visible { outline: 2px solid var(--av-focus); outline-offset: 2px; }
`;
