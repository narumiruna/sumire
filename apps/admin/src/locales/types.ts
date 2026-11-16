/** Require shared keys; Chinese and Japanese do not need English singular forms. */
export type Catalog<Source extends Record<string, string> = Record<string, string>> = {
  [Key in keyof Source as Key extends `${string}_one` ? never : Key]: string
}
