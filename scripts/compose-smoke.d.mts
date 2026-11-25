export interface ComposeSmokeOptions {
  fetchImpl?: typeof fetch;
  readyTimeoutMs?: number;
  runTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ComposeSmokeResult {
  datasetId: string;
  experimentId: string;
  runId: string;
  state: string;
  completedUnits: number;
}

export function runComposeSmoke(
  baseUrl?: string,
  options?: ComposeSmokeOptions,
): Promise<ComposeSmokeResult>;
