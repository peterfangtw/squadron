import { refused, type Power } from './index';

/**
 * No sleep lock on win32 yet, and no battery reading. Neither ever ran
 * there; the native power request lands under W7.1.
 */
export function power(): Power {
  return refused('win32', 'no sleep assertion or battery reader — W7.1');
}
