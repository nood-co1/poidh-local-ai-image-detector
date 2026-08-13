/**
 * First-run artifact setup coordinator (section 2.2).
 * Used by the service worker to run ensureArtifacts and report status
 * to the popup (Start / Retry / Ready + SHA).
 *
 * Weights land in OPFS/Cache API only — never chrome.storage.
 */

import {
  DEFAULT_MANIFEST,
  ensureArtifacts,
  getArtifactStatus,
  getProductionOnnx,
  shortSha,
  type ArtifactStatus,
  type SetupResult,
} from '../src/artifact-store.js';

export type { ArtifactStatus, SetupResult };

export interface SetupStatusMessage {
  type: 'ARTIFACT_STATUS_RESULT';
  ready: boolean;
  sha256: string | null;
  sha256Short: string | null;
  backend: ArtifactStatus['backend'];
  modelsReadyMarker: boolean;
  error?: string;
  repo?: string;
  revision?: string;
}

export interface SetupResultMessage {
  type: 'SETUP_ARTIFACTS_RESULT';
  ok: boolean;
  ready: boolean;
  noop: boolean;
  sha256: string | null;
  sha256Short: string | null;
  backend: SetupResult['backend'];
  fetched: string[];
  skipped: string[];
  error?: string;
}

/**
 * Query local artifact readiness without network I/O.
 */
export async function querySetupStatus(): Promise<SetupStatusMessage> {
  const status = await getArtifactStatus({ manifest: DEFAULT_MANIFEST });
  const onnx = getProductionOnnx(DEFAULT_MANIFEST);
  return {
    type: 'ARTIFACT_STATUS_RESULT',
    ready: status.ready,
    sha256: status.sha256 ?? (status.ready ? onnx.sha256 : null),
    sha256Short:
      status.sha256Short ??
      (status.ready ? shortSha(onnx.sha256) : null),
    backend: status.backend,
    modelsReadyMarker: status.modelsReadyMarker,
    error: status.error,
    repo: DEFAULT_MANIFEST.repo,
    revision: DEFAULT_MANIFEST.revision,
  };
}

/**
 * Run one-time (or Retry) artifact setup.
 * @param force when true, allow re-download even if models_ready (Retry button).
 */
export async function runSetup(force = false): Promise<SetupResultMessage> {
  const result = await ensureArtifacts({
    force,
    manifest: DEFAULT_MANIFEST,
  });
  return {
    type: 'SETUP_ARTIFACTS_RESULT',
    ok: result.ready,
    ready: result.ready,
    noop: result.noop,
    sha256: result.sha256,
    sha256Short: result.sha256Short,
    backend: result.backend,
    fetched: result.fetched,
    skipped: result.skipped,
    error: result.error,
  };
}
