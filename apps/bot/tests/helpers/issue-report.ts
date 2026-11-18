import type { AnalysisReport } from "@narumitw/sumire-issues"
export const report: AnalysisReport = {
  summary: "將操作區改為清楚的分組。",
  limitations: "只看過回饋，尚未讀取原始碼；此圖為概念線框。",
  questions: [],
  proposals: [
    {
      title: "集中操作",
      rationale: "降低尋找按鈕的負擔。",
      changes: ["將主要操作放在標題旁。"],
      tradeoffs: "需要確認手機版的可用空間。",
      preview: {
        title: "操作區概念",
        layout: "stack",
        sections: [{ heading: "操作", body: "集中主要操作，次要操作放入選單。", button: "儲存" }],
      },
    },
  ],
}
