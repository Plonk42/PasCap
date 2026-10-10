import { useId } from 'react';
import type { EditCommand } from '../shared/commands.js';
import {
  createDetailSettings,
  DETAIL_CONTROLS,
  isNeutralDetail,
  NEUTRAL_DETAIL,
  type DetailSetting,
  type DetailSettings,
} from '../shared/detail.js';
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
  clip: VideoClip;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
}

/** Clip-owned static Sharpen/Clarity/Denoise; sliders preview live and commit once on release. */
export function DetailSection({ project, clip, disabled, onEdit }: Readonly<Props>) {
  const id = useId();
  const context = `${project.id}:${clip.id}`;
  const command = (detail: DetailSettings): EditCommand => ({ type: 'detail', clipId: clip.id, detail });
  const commit = (detail: DetailSettings): void => {
    if (!disabled) onEdit(command(detail));
  };
  const withValue = (key: DetailSetting, value: number): DetailSettings => ({ ...clip.detail, [key]: value });
  return (
    <InspectorSection
      id="detail"
      title="Detail"
      icon="wand"
      modified={!isNeutralDetail(clip.detail)}
      help={
        <HelpPopover label="Detail" guide="sharpen-clarity-and-denoise-a-clip">
          <p>
            Sharpen fine edges, add or soften midtone contrast with Clarity, or smooth grain with Denoise on this clip.
            The preview shows the result as you drag.
          </p>
          <p className="editor-help-tip">Tip: Compare shows the clip without Colour and Detail.</p>
        </HelpPopover>
      }
    >
      <section className="detail-editor" aria-label="Clip detail editor">
        {DETAIL_CONTROLS.map((control) => {
          const fieldId = `${id}-${control.key}`;
          const value = clip.detail[control.key];
          return (
            <div className="colour-control detail-field" key={control.key}>
              <span>
                <ResetLabel
                  htmlFor={fieldId}
                  title={`Double-click to reset ${control.label}`}
                  name={control.label}
                  blocked={resetBlocked(value === NEUTRAL_DETAIL[control.key], disabled)}
                  onReset={() => commit(withValue(control.key, NEUTRAL_DETAIL[control.key]))}
                >
                  {control.label}
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
                onCommit={(next) => commit(withValue(control.key, next))}
                onDraft={(next) => livePreview(next === null ? null : command(withValue(control.key, next)))}
              />
            </div>
          );
        })}
        <div className="detail-tools">
          <button
            type="button"
            className="text-button"
            disabled={disabled || isNeutralDetail(clip.detail)}
            onClick={() => commit(createDetailSettings())}
          >
            <Icon name="reset" size={13} />
            Reset detail
          </button>
        </div>
      </section>
    </InspectorSection>
  );
}
