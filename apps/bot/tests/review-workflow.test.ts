import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const workflow = readFileSync(
  new URL("../../../.github/workflows/review.yml", import.meta.url),
  "utf8",
)

describe("PR review workflow", () => {
  it("reviews trusted events without checking out or executing pull request code", () => {
    expect(workflow).toContain("\n  pull_request_target:\n    branches:\n      - main")
    expect(workflow).toContain("\n  workflow_dispatch:\n    inputs:\n      pull-request:")
    expect(workflow).toContain("required: true\n        type: number")
    expect(workflow).toContain("if: github.actor != 'dependabot[bot]'")
    expect(workflow).toContain(`pull-request: \${{ inputs.pull-request }}`)
    expect(workflow).toContain("permissions:\n  contents: read\n  pull-requests: write\n")
    expect(workflow).not.toMatch(
      /\n {2}pull_request:|actions\/checkout@|github\.event\.pull_request\.head/,
    )
    expect(workflow).not.toMatch(/^\s+run:/m)
  })

  it("loads environment credentials under one job-level lock without automatic cancellation", () => {
    expect(workflow).toContain(
      "    environment: pi-oauth\n    concurrency:\n      group: pi-oauth-auth-json\n      cancel-in-progress: false\n",
    )
    expect(workflow).not.toMatch(/^concurrency:|cancel-in-progress: true/m)
    expect(workflow.match(/concurrency:/g)).toHaveLength(1)
  })

  it("pins the review and persistence actions to the same full revision", () => {
    const revision = workflow.match(/pi-action\/review@([a-f0-9]{40})\b/)?.[1]
    expect(revision).toBeDefined()
    expect(workflow).toContain(`pi-action/persist-auth@${revision}`)
    expect(workflow.match(/uses:/g)).toHaveLength(2)
  })

  it("exports OpenAI OAuth credentials without giving the writer token to review", () => {
    const producer = workflow.split("      - name: Persist refreshed credentials")[0]
    expect(producer).toContain("id: review")
    expect(producer).toContain(`auth-json: \${{ secrets.PI_AUTH_JSON }}`)
    expect(producer).toContain(`auth-output: \${{ runner.temp }}/pi-review-auth/auth.json`)
    expect(producer).toMatch(/^\s+provider: openai$/m)
    expect(producer).toContain("model: gpt-6.1-sol")
    expect(producer).not.toMatch(/PAT_TOKEN|auth-secret:|auth-environment:|auth-token:/)
    expect(workflow).not.toMatch(/^\s+env:|GH_TOKEN:|GITHUB_TOKEN:|write-all/m)
  })

  it("persists the known private handoff after review failure without hiding that failure", () => {
    const consumer = workflow.split("      - name: Persist refreshed credentials")[1]
    expect(consumer).toBeDefined()
    expect(consumer).toContain("if: always() && steps.review.outcome != 'skipped'")
    expect(consumer).toContain(`auth-file: \${{ runner.temp }}/pi-review-auth/auth.json`)
    expect(consumer).toContain(`auth-json: \${{ secrets.PI_AUTH_JSON }}`)
    expect(consumer).toContain(`token: \${{ secrets.PAT_TOKEN }}`)
    expect(consumer).not.toMatch(/^\s+(environment|secret-name):/m)
    expect(workflow.match(/secrets\.PAT_TOKEN/g)).toHaveLength(1)
    expect(workflow).not.toMatch(/continue-on-error:|\.outputs\./)
  })
})
