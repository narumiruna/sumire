import { Curl, NATIVE_IMPERSONATE_TARGETS } from "impers"

const curl = new Curl()
try {
  for (const { browser, target_name } of NATIVE_IMPERSONATE_TARGETS) {
    if (browser === "Chrome") curl.impersonate(target_name)
  }
} finally {
  curl.cleanup()
}
