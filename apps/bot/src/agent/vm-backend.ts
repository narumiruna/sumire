import type { VMOptions } from "@earendil-works/gondolin"

export const vmBackendNames = ["qemu", "libkrun"] as const
export type VmBackend = (typeof vmBackendNames)[number]

/** Public backend names are independent of the Gondolin SDK's VMM identifiers. */
export function vmBackendOptions(
  backend: VmBackend,
): Pick<NonNullable<VMOptions["sandbox"]>, "vmm"> {
  switch (backend) {
    case "qemu":
      return { vmm: "qemu" }
    case "libkrun":
      return { vmm: "krun" }
    default:
      throw new Error("BOT_VM_BACKEND must be qemu or libkrun")
  }
}
