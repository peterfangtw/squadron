export const BRANDS = ['claude', 'grok', 'codex'] as const;

export type BrandId = (typeof BRANDS)[number];

/** Launches and picks that name no brand. A session with none goes through `sessionBrand`. */
export const DEFAULT_BRAND: BrandId = 'claude';

const LEGACY_BRAND: BrandId = 'claude';

/**
 * An absent brand marks a session or conversation written before the brand
 * seam, which is always Claude. `DEFAULT_BRAND` is the product's launch
 * default and may change independently.
 */
export function sessionBrand<B extends string>(brand: B | undefined): B | BrandId {
  return brand ?? LEGACY_BRAND;
}

export function isBrand(value: unknown): value is BrandId {
  return BRANDS.some((brand) => brand === value);
}

export function mapBrands<T>(value: (brand: BrandId) => T): Record<BrandId, T> {
  return Object.fromEntries(BRANDS.map((brand) => [brand, value(brand)])) as Record<BrandId, T>;
}
