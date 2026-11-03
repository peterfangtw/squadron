/** The Squadron marks watermarked behind the board's cards and the dock's chat tab. */

import * as marks from '../marks';

export const css = /* css */ `
  /* A background layer on the scroller itself, not a positioned child: #cards
     is static, so an absolute layer over #board paints above everything in it,
     and a negative z-index ranks in the root context under #dock's opaque
     slab. A scroller's own background at the default attachment stays put
     while its content scrolls. Ink and alpha are baked into the URIs —
     icons.mjs says why. */
  #cards { background-image: url("${marks.WORDMARK_URI}"); background-repeat: no-repeat;
           background-position: center; background-size: min(60%, 560px) auto; }
  /* On the tab, not #thread: the thread's height moves under a first send —
     the head appears at the press and the layout settles again at the landing,
     measured +22px then -11px at the thread's centre — and the mark is meant
     not to move. No row in the tab paints over it. */
  #chat { background-image: url("${marks.ECLIPSE_URI}"); background-repeat: no-repeat;
          background-position: center; background-size: min(45%, 180px) auto; }
`;
