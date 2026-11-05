/** Require the source catalog keys while allowing translated string values. */
export type Catalog<Source extends Record<string, string> = Record<string, string>> = {
  [Key in keyof Source]: string
}
