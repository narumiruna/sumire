import { afterEach } from "vitest"
import { closeTestStores } from "./helpers/admin-store.js"

afterEach(closeTestStores)
