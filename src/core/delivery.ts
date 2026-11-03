/**
 * The prose a send puts on the pipe: the body as typed, or none at all when it
 * is only whitespace — an image sent with a blank box carries no text.
 *
 * The trim decides emptiness and is not what goes out. Trimming the bytes
 * dropped a leading space and a leading blank line the reader typed.
 */
export function deliveryText(body: string): string {
  return body.trim() ? body : '';
}
