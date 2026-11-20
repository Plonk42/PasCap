import { useId } from 'react';
import type { EditCommand } from '../shared/commands.js';
import { DETAIL_CONTROLS, isNeutralDetail, NEUTRAL_DETAIL, type DetailSetting } from '../shared/detail.js';
import type { ProjectDocument, VideoClip } from '../shared/model.js';
import './detail-editor.css';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { InspectorSection } from './InspectorSection.js';
import { livePreview } from './live-preview.js';
import { ResetLabel, resetBlocked } from './SettingValueControl.js';
import { ValueControl } from './ValueControl.js';

interface Props {
  project: ProjectDocument;
  /** The clip whose values the controls show. */
  clip: VideoClip;
  /** Every clip a change applies to, `clip` included. */
  clips: readonly VideoClip[];
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
}

type DetailPatch = Partial<Record<DetailSetting, number | null>>;

const NEUTRAL_PATCH: DetailPatch = { sharpen: null, clarity: null, denoise: null };

/** Clip-owned static Sharpen/Clarity/Denoise on the selected clips; sliders preview live and commit once on release. */
export function DetailSection({ project, clip, clips, disabled, onEdit }: Readonly<Props>) {
  const id = useId();
  const context = `${project.id}:${clips.map((item) => item.id).join(',')}`;
  const clipIds = clips.map((item) => item.id);
  const command = (settings: DetailPatch): EditCommand => ({ type: 'detail-patch', clipIds, settings });
  const commit = (settings: DetailPatch): void => {
    if (!disabled) onEdit(command(settings));
  };
  const neutral = (key: DetailSetting): boolean => clips.every((item) => item.detail[key] === NEUTRAL_DETAIL[key]);
  const several = clips.length > 1;
  return (
    <InspectorSection
      id="detail"
      title="Detail"
      icon="wand"
      modified={clips.some((item) => !isNeutralDetail(item.detail))}
      help={
        <HelpPopover label="Detail" guide="sharpen-clarity-and-denoise-a-clip">
          <p>
            Sharpen fine edges, add or soften midtone contrast with Clarity, or smooth grain with Denoise on this clip.
            The preview shows the result as you drag.
          </p>
          <p>With several clips selected, a change sets that setting on all of them.</p>
          <p className="editor-help-tip">
            Tip: hold Original above the preview to see the clip without Color and Detail.
          </p>
        </HelpPopover>
      }
    >
      <section className="detail-editor" aria-label="Clip detail editor">
        {several && <p className="detail-scope">Changes apply to the {clips.length} selected clips</p>}
        {DETAIL_CONTROLS.map((control) => {
          const fieldId = `${id}-${control.key}`;
          const value = clip.detail[control.key];
          const mixed = clips.some((item) => item.detail[control.key] !== value);
          return (
            <div className="color-control detail-field" key={control.key}>
              <span>
                <ResetLabel
                  htmlFor={fieldId}
                  title={`Double-click to reset ${control.label}`}
                  name={control.label}
                  blocked={resetBlocked(neutral(control.key), disabled)}
                  onReset={() => commit({ [control.key]: null })}
                  compare={neutral(control.key) ? null : command({ [control.key]: null })}
                >
                  {control.label}
                  {mixed && (
                    <small
                      className="detail-mixed"
                      title="The selected clips differ: the slider shows the outlined clip's value, and a change sets all of them"
                    >
                      Mixed
                    </small>
                  )}
                </ResetLabel>
              </span>
              <ValueControl
                id={fieldId}
                aria-label={`Clip ${control.label}`}
                value={value}
                min={control.min}
                max={control.max}
                step={control.step}
                disabled={disabled}
                resetKey={`${context}:${control.key}`}
                onCommit={(next) => commit({ [control.key]: next })}
                onDraft={(next) => livePreview(next === null ? null : command({ [control.key]: next }))}
              />
            </div>
          );
        })}
        <div className="detail-tools">
          <button
            type="button"
            className="text-button"
            disabled={disabled || clips.every((item) => isNeutralDetail(item.detail))}
            onClick={() => commit(NEUTRAL_PATCH)}
          >
            <Icon name="reset" size={13} />
            Reset detail
          </button>
        </div>
      </section>
    </InspectorSection>
  );
}
