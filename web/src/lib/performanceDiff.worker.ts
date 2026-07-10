import type { PerformanceDiff, TraceModel } from './model'
import { analyzePerformanceDiff } from './performanceDiff'

interface AnalyzeRequest {
  id: number
  baseline: TraceModel
  candidate: TraceModel
  threshold: number
}

interface AnalyzeResponse {
  id: number
  result?: PerformanceDiff
  error?: string
}

self.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const { id, baseline, candidate, threshold } = event.data
  try {
    const response: AnalyzeResponse = {
      id,
      result: analyzePerformanceDiff(baseline, candidate, threshold),
    }
    self.postMessage(response)
  } catch (err) {
    const response: AnalyzeResponse = {
      id,
      error: err instanceof Error ? err.message : String(err),
    }
    self.postMessage(response)
  }
}
