import { useState } from 'react';
import { MAX_DECODER_SLOTS } from '../preview/assignment.js';
import { verifyGpuColour, type GpuComparison } from '../preview/compositor.js';
import type { PreviewDiagnostics } from '../preview/engine.js';
import { NEUTRAL_COLOUR, type ColourSettings } from '../shared/colour.js';
import { milliseconds } from './display.js';

interface Props {
  diagnostics: PreviewDiagnostics | null;
  colour: ColourSettings | null;
  canRenderReference: boolean;
  referenceBusy: boolean;
  onReference: () => void;
  onError: (message: string) => void;
}

export function Diagnostics({
  diagnostics,
  colour,
  canRenderReference,
  referenceBusy,
  onReference,
  onError,
}: Readonly<Props>) {
  const [gpu, setGpu] = useState<GpuComparison | null>(null);
  return (
    <section className="diagnostics-panel" aria-label="Diagnostics">
      <div className="diagnostic-values">
        <div>
          <strong>{diagnostics?.previewFps.toFixed(1) ?? '—'}</strong>
          <span>fps</span>
        </div>
        <div>
          <strong>{milliseconds(diagnostics?.medianSeekMs)}</strong>
          <span>median seek</span>
        </div>
        <div>
          <strong>{milliseconds(diagnostics?.colourLatencyMs)}</strong>
          <span>colour response</span>
        </div>
        <div>
          <strong>{diagnostics?.stalls ?? 0}</strong>
          <span>buffer events</span>
        </div>
        <div>
          <strong>{diagnostics?.droppedDecodedFrames ?? 0}</strong>
          <span>dropped frames</span>
        </div>
        <div>
          <strong>
            {diagnostics?.activeDecoders ?? '—'} / {diagnostics?.decoderCount ?? '—'}
          </strong>
          <span>active decoders</span>
        </div>
      </div>
      <p className="gpu-renderer">{diagnostics?.renderer}</p>
      <p className="control-hint">
        Two reusable video decoders per track, up to {MAX_DECODER_SLOTS} for concurrent track dissolves; source review
        adds at most one while visible. No decoder is allocated per stored clip.
      </p>
      <div className="diagnostic-actions">
        <button
          className="secondary-button small"
          onClick={() => {
            try {
              setGpu(verifyGpuColour(colour ?? { ...NEUTRAL_COLOUR }));
            } catch (error) {
              onError(error instanceof Error ? error.message : 'Shader check failed');
            }
          }}
        >
          Check shader / CPU
        </button>
        <button
          className="secondary-button small"
          disabled={!canRenderReference || referenceBusy}
          onClick={onReference}
          title="Strict schema 13: one enabled, opaque, unanimated, zero-origin contiguous video track with two normal-speed clips and no music. Use Export for complete edits."
        >
          Render 720p reference
        </button>
      </div>
      {gpu && (
        <output data-testid="gpu-parity">
          MAE {gpu.meanAbsoluteError8Bit.toFixed(3)} / 255 · max {gpu.maxError8Bit.toFixed(3)}
        </output>
      )}
    </section>
  );
}
