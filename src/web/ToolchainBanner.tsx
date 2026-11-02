import { useState } from 'react';
import { toolchainNotice, type Toolchain } from '../shared/toolchain.js';
import { Icon } from './icons.js';

const GUIDE_URL = 'https://github.com/Plonk42/PasCap/blob/main/docs/DEPLOYMENT.md#native-toolchain';

/** The service's startup FFmpeg check, shown until dismissed when it is not the qualified toolchain. */
export function ToolchainBanner({ toolchain }: Readonly<{ toolchain: Toolchain | null }>) {
  const [dismissed, setDismissed] = useState(false);
  const notice = toolchain && toolchainNotice(toolchain);
  if (!notice || dismissed) return null;
  return (
    <output className={`toolchain-banner ${notice.severity}`} role={notice.severity === 'error' ? 'alert' : undefined}>
      <Icon name="warning" size={15} />
      <span>
        {notice.message}{' '}
        <a href={GUIDE_URL} target="_blank" rel="noreferrer">
          Learn more
        </a>
      </span>
      <button
        className="icon-button"
        aria-label="Dismiss FFmpeg notice"
        title="Dismiss until the editor reloads"
        onClick={() => setDismissed(true)}
      >
        <Icon name="x" size={16} />
      </button>
    </output>
  );
}
