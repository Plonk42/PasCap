# Speed and audio contract · project v13

Nine video track-owned scalar Colour controls include Temperature/Tint (−1…1, neutral 0),
whose normalized linear gains precede Exposure. Positive Temperature warms;
positive Tint adds magenta; nonzero settings intentionally colour greys. They
can be keyed independently in video track animation, which is appearance-only and
never changes timing. See [Temperature and Tint](design/TEMPERATURE_AND_TINT.md).
Static track HSL and master/RGB colour curves follow scalar grading and precede
black fades/coverage. They remain active with scalar keyframes, add no animation
channels and are unrelated to speed curves. Compare/Ungraded bypasses all Colour
without changing retiming, geometry, Opacity or music. Required data/resources:
[HSL_AND_CURVES.md](design/HSL_AND_CURVES.md).

## Clip speed

Speed belongs only to the clip and is positive, **0.1×–8×**. Strict schema 13
requires each clip's `speed` to be `{ mode: 'constant', rate }` or
`{ mode: 'curve', keyframes }`; there is no track Speed setting, ramp mode or
project-wide speed field. A clip's duration and sampled frames depend only on its
own speed and source range, never on its track, start, Ripple position or other
clips: moving it to another track or time never changes its duration.

### Constant speed

A constant-rate clip has duration
$\max(1,\operatorname{round}(\text{sourceFrames}/\text{rate}))$. Its effective
playback rate uses `sourceFrames / outputFrames` to distribute duration rounding.

### Custom curve: source-frame keyframes

A curve requires **1–256** keyframes `{ frame, rate, interpolation }`: unique ascending
integer original-source frames, rates **0.1–8**, and hold/linear/ease-in/ease-out/smooth
easing toward the next keyframe. First/last rates hold outside their interval, so a
single keyframe holds its rate across the whole clip. A keyframe
at the original's exclusive OUT is a valid boundary anchor, but none may exceed
the registered original; keyframes outside the current trim remain stored.

Timing integrates $dt=ds/r(s)$ on intervals split at **every keyframe**, including
one-source-frame holds in long recordings. Hold/constant intervals and linear
rate ramps have closed-form integrals/inverses. Eased intervals use bounded
16-point Gauss–Legendre quadrature with dimensionless tolerance $10^{-12}$ and
maximum subdivision depth 14; inverse queries use bounded binary search. Storage
is proportional to keyframes, not source or output duration.

Only the final output duration is rounded, once, to at least one integer frame;
its clock is normalised once to that duration, and mapped source positions are
floored within source IN/OUT (OUT exclusive). Slow motion repeats recorded frames
and fast motion drops them; no optical-flow frames are generated. Native decode
still checks every selected original frame, even when output sampling skips it.

Clip curves belong to **one clip**. Trims, moves (including to another track),
splits and marked cuts retain original-source anchors, including off-trim and
original exclusive-OUT keyframes; split/cut/duplicate pieces receive independent
deep copies. Every retained piece compiles/rounds its own duration once, so a split
can change the total by one frame. There is no optional fallback or data migration;
a mode/preset change is a deliberate editing command, not a conversion on load.

Presets **Flat, Ramp up, Ramp down, Accelerate, Decelerate, Slow centre and Fast
centre** deliberately replace the clip's keyframes with Smooth-eased keyframes spread
evenly across the selected source range. Ramp up and Ramp down place two keyframes
at source IN and OUT: 0.5×→2× and 2×→0.5×. Choosing **Custom curve** for a constant
clip creates a flat curve at its rate; choosing **Constant speed** returns to
constant 1×. Removing the last keyframe keeps its rate as constant speed. Keyframes
remain ordinary editable data, not hidden saved preset IDs.

### Placement, preview and native parity

`calculateLayout()` places each clip with its own compiled **`PlacedClip.retiming`**,
the single authoritative map for layout, UI, preview seeking, decoder rates, inverse
queries, native original retiming/span checks and storage planning, in static and
composited export alike. Native output requires a monotonic,
integer, in-range `sourceAt` result and exact frame counts; a malformed supplied
map is rejected rather than falling back to a clip's stored speed.

Clip spatial geometry evaluates at the same map's continuous
`sourcePositionAt(localOutputFrame)`, while `sourceAt` identifies the integer
recorded image. Slow motion may animate crop/scale/translation/rotation over a
held image without optical flow. Clip speed changes this continuous map, not the
clip's stored spatial keyframes: trim/move/split/cut/duplicate retain original-source
anchors, including off-trim and original exclusive-OUT keyframes, with independent
deep copies for new pieces. Spatial edits are appearance-only and do not change
speed, placement or duration. See [spatial transforms](design/SPATIAL_TRANSFORMS.md).

All track colour/opacity parameters are sampled at **absolute project time**, not at
the retimed source frame. A held source image can therefore receive a different
grade on the next project frame. Native LUT generation and preview redraw both
follow that rule. Every source uses the track's required numeric `opacity` in 0–1,
initially 1 on new tracks, unless the sole track **Opacity** (`opacity`) channel
overrides it. Evaluate that one track setting for each source, including both
dissolve sources; there is no saved `clip.opacity`.
With graded RGB $G_i$, black-fade brightness $b_i$, evaluated Opacity $o_i$ and
dissolve weight $w_i$ and spatial pixel coverage $m_i$, each track forms one group
with $C = \sum_i G_i b_i o_i w_i m_i$ and $A = \sum_i o_i w_i m_i$. Source-over is
$\mathrm{result} = C + \mathrm{lower}(1 - A)$, with no track multiplier; black fades
change RGB without reducing coverage. Any shared track keyframe
requires the composited export path; any nonneutral spatial base or spatial keyframe
(even neutral keyframes) does too. Exact neutral poses retain opaque black letterboxing
after grading; nonneutral uncovered pixels reveal lower footage. The static chunk
plan cannot silently omit these edits.
Opacity is composition coverage, not part of the SDR RGB grade.
Its single native slider/exact `NumberField` is in **Track → Colour** alongside
the colour controls. Its capture diamond is always visible;
adjacent per-setting Previous/Next buttons appear with it, and stored
enabled-setting chips retain their per-channel arrows.
Main and stored sliders/exact fields use **0–100%**,
neutral **100%**; track `opacity` and keyframe values stay **0–1**, without a schema change.
Without Opacity keyframes it edits track `opacity`, even on
an empty track. With keyframes, a setting not enabled at the real playhead is read-only
until captured with the diamond; sliders never create keyframes. Unkeyed colour
settings edit the track base. **Placement** contains placement only; Track options
contains rename, Ripple, ordering and deletion, with visibility separate.

Each track's **Ripple** setting governs placement. While on (the new-track default),
clips continuously sequence from the first anchor, subtracting dissolve overlaps;
a speed edit that changes a clip's duration re-sequences its suffix, and commands
persist these actual starts. Enabling Ripple closes gaps in one Undo step while retaining the
first current start; turning it off captures actual placements. While off, starts
stay independent and duration edits never move unrelated clips. Other tracks,
music and absolute track keyframes stay put. Transition/fade durations remain **output**
frames on their own track. Invalid fade/transition regions, arbitrary same-track
overlap or triple overlap reject the entire edit, including a rate, keyframe-frame or
easing change, and never shorten transitions to make it fit. Shared track keyframes
are appearance-only: moving or editing them never retimes a clip.

Moving ghosts and commits use the clip's own duration, which its destination never
changes. Left handle/keyboard trims with Ripple off retain timeline OUT; restoring IN
is limited so the start never precedes project frame 0. **Clip → Range**
text fields, bar handles and **Restore full recording** use ordinary source-range trim:
retain the start in either mode and re-sequence the Ripple suffix normally, not
the timeline left handle's retained-OUT rule. Ripple-on timeline left trims keep their sequence
start and recompile the suffix. Only the first anchor supports numeric start/nudge
while on; later clips expose the reason to turn Ripple off or drag to reorder.
Trim/move/split/duplicate never copy or shift track keyframes; each
split piece rounds its own duration, so exact total duration is
not guaranteed. Originals and full proxies remain unchanged.

### Editing speed

Playback rates use the shared native slider plus an adjacent exact `NumberField`,
bounded to **0.1×–8×**: the main **Speed ×** row and a selected curve keyframe's rate.
Modes, presets and the curve graph remain
separate controls. Pointer sliding changes only a transient local value draft (only Colour, Opacity and HSL sliders also preview it in the image); release applies one validated document edit and updates the image. Escape, pointer cancellation, lost capture or window blur restores the starting value without save/history. Each keyboard slider adjustment is an individual validated edit.
Numeric entry retains full precision, applies on Enter/blur and restores on Escape;
invalid drafts remain editable without clamping or rounding.

**Clip → Speed** follows the Colour/Transform pattern, with no Animate toggle or
stored preference. While expanded, its keyframe line shows **N keyframes**, one
native **Previous/Next** pair and **Reset** (constant 1×, removing the keyframes);
the line is hidden while collapsed. Below it come the source → output duration
overview, the **Speed mode** select (**Constant speed / Custom curve**), the
constant **0.25×–4×** presets (constant mode only) and the main **Speed ×** row.

Previous/Next visits **all retained clip speed keyframes**, including off-trim
keyframes and the original exclusive OUT, previewing the nearest mapped image
through authoritative `PlacedClip.retiming`: off-trim keyframes use the first/last
available output image, and original OUT never requests an out-of-range image.
A clip-local stored-source cursor, of the same design as Transform's and independent
of the central track inspection cursor, advances through successive keyframes even
when several preview the same image. Stored source time stays distinct from the
actual displayed source frame. Navigation is editor-only, preserving the Inspector
tab/focus without an edit, history or save. Speed has a single setting, so this
pair is its only keyframe navigation: unlike Colour and Transform, whose settings
share keyframes, there are no second per-setting arrows beside its diamond.

In the **Speed ×** row, double-clicking the name resets the editable rate to 1×.
The capture diamond **Keyframe Speed** (◇ hollow / ◆ filled, `aria-pressed`)
captures the rate at the **actually displayed source frame** with Linear easing
(a constant clip becomes a one-keyframe curve), or removes the keyframe there;
removing the last keyframe keeps its rate as constant speed. A capture retimes the
clip, so preview then seeks to the new keyframe's mapped image. Capture never uses
an inspected stored time. The slider/exact field (**Clip speed rate**) edits the
constant rate in constant mode. In curve mode it is read-only, dimmed with the lock
cue **Add a keyframe ◇ to edit**, unless a keyframe exists at the displayed source
frame; it then edits that keyframe's rate and preview follows the keyframe.
Sliders never create keyframes. Each accepted edit is one Undo step; timing
conflicts remain inline errors.

Shared video track keyframes contain only Opacity and Colour settings; they never
affect speed or duration. Storing/moving one beyond duration does not extend the
sequence; actual clip retiming or a music track's OUT can change project duration.
Details: [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

### Precise clip-curve editor

With a clip selected, open **Clip → Speed** and choose **Custom curve**, or capture a
keyframe with the diamond. The curve editor shows the presets above, then the graph:
source time horizontally and a logarithmic **0.1×–8×** speed axis
vertically. A vertical line identifies the actually displayed source frame. Click
the background or a keyframe to preview. The original exclusive-OUT keyframe previews the last
output frame, never an invented source frame. Source navigation compares the
two adjacent mapped outputs, showing the exact source image when available or
the closest rendered image when fast playback skips it; the stored keyframe stays
at its requested source frame. The keyframe line's navigation and the native
**Selected clip speed keyframe** selector reach all retained clip source keyframes,
including off-trim and original-OUT keyframes, through the independent stored-source
cursor above, not the clamped preview frame as a substitute for stored source time.
The trash beside the selector, **Delete clip speed keyframe**, removes the selected
keyframe; deleting the last one returns the clip to constant speed at its rate.

**Source frame / Speed × / Easing** provide exact editing: source frame
uses a native integer `NumberField`; Speed × pairs a slider with an exact field.
Numeric fields retain full entered decimal precision and commit on Enter/blur; invalid collisions,
out-of-original positions and timing conflicts retain the draft with inline
errors. They do not automatically seek. Escape restores the field. Easing belongs
to the left keyframe; the last rate holds without a next interval.
Custom clip-speed, Transform and track-keyframe selectors all visibly read
**Easing**, retaining contextual accessible names such as **Track keyframe easing N**.
Clip-speed and track-keyframe selectors retain
the same compact selected-shape graph and accessible description. It illustrates
the existing progress function, not a new rate or interpolation rule.
Selection remains native and commits once, with one Undo step.

Graph-keyframe dragging is separate from the release-only value slider. Drag a keyframe
horizontally to change its integer source frame and vertically to change its speed,
quantised to **0.001×** for pointer movement only. Capture-relative
geometry does not drift as duration changes. Valid drafts preview the complete
new layout while retaining the displayed original source position, but do not
enter committed history/autosave. Valid release is **one Undo**. Red collision/
fade/overlap feedback rejects the entire release, not just the last invalid
movement; no merge, transition shortening or last-valid commit occurs.
Escape, pointer cancellation, lost capture and window blur restore the original
preview/document. Other edit/navigation gestures are disabled during capture.

Focused keyframe Left/Right changes one source frame (Shift ten), Up/Down changes
0.01× (Shift 0.1×) while retaining the entered decimal precision, Enter previews it,
and Delete removes it; removing the last keyframe keeps its rate as constant speed.
These controls isolate timeline shortcuts; the source frame field
remains reachable if a keyframe moves outside the visible trim. New keyframes select
themselves. The keyframe line's Reset returns this clip to constant 1× without
changing track keyframes or other clips.

### Timeline clip-speed markers

Inside each clip rectangle, custom-speed source keyframes appear as boxed salmon
**◆** lane, distinct from the boxed blue **▼** Transform lane; each title lists the
keyframe's rate. Positions follow authoritative retiming. Off-trim keyframes are
omitted. Exclusive OUT has a boundary marker that seeks the final available frame.
Click, Enter or Space selects the clip, seeks its nearest mapped image and opens
Clip → Speed; a click edits nothing.

Speed keyframes slide exactly like Transform keys, through the shared
`useKeyframeSlide`/`KeyframeMarkers`. Drag horizontally: after a 3-pixel threshold,
capture-relative output-frame travel maps through the captured placed retiming to
an original source frame, snapping to boundaries and the playhead (Alt bypasses;
snapping to the clip end lands on exclusive OUT). Or press ←/→ for one source frame
(Shift ten). Drafts preview without history/save, the preview following the dragged
keyframe. A valid release is one `speed` command and one Undo step. Moving a speed
keyframe retimes the clip, so its duration and Ripple suffix can change;
overlap/fade/transition conflicts reject the release. Escape, pointer cancellation,
lost capture, window blur, an occupied frame or a frame outside the original
restores. Keyboard handling is isolated from timeline shortcuts. These markers are
distinct from shared project-time track markers and from the editable source-speed
graph. Stored navigation still reaches all retained off-trim/original-OUT keyframes
through the clip-local cursor; neither navigation nor inspection supplies a fake
frame for main capture.

## Music

Strict schema 13 requires `music: MusicTrack[]`, with **0–8 independent music tracks**
and unique required track `id` values; `[]` means no music. Each music track
requires `mediaId`, `sourceIn`, `sourceOut`, `start`, `duration`, `gainDb`, `fadeIn`,
`fadeOut` and `loop`. Several music tracks can use the same registered recording
without sharing edits. A missing array/ID, null/singular music, unknown fields or
duplicate IDs are errors, never defaulted or migrated. Detailed bounds and pending
acceptance are in [MULTIPLE_MUSIC.md](design/MULTIPLE_MUSIC.md).

**Audio → Music → Browse music recordings** opens a keyboard-accessible native modal
beside the manual **Music recording path / Import audio** form. Choose one radio-selected
file inside a configured `PASCAP_MEDIA_ROOTS` location, then explicitly **Import
selected music**. Root/folder navigation, search, Refresh and Cancel are metadata-only;
they never import or alter the project. Both media browsers share the service user's
Videos default; `[]` disables browsing, not deliberate manual paths outside those roots.
WAV, MP3, M4A, AAC, FLAC, OGG, OPUS, AIFF, AIF and WMA extensions are discovery
candidates, not proof of supported contents. The existing probe is authoritative.
An accepted import adds only the importing project's audio-bin membership and returns
its preparation job; choosing/placing music is still a separate action. Failed or
uncertain registration stays open with selection/error intact and no automatic retry;
check Activity/project state before repeating it. Originals are never uploaded or copied.

Reimporting an unchanged source at the same absolute path reuses its music entry.
Importing a different location creates a **new music entry**, even when a move or
hard link retains the original filesystem identity. The selected file is verified
at its own path; an older entry's missing path does not block that new import.
Existing entries and project references are not reassociated or removed. Add the
new entry with **Add music track** for deliberate placement. Verified fingerprint-matching PCM can
be reused through the serial worker; originals and old caches remain untouched.

Standalone music import requires exactly one audio stream and no video footage.
Embedded cover artwork explicitly marked as an attached picture is accepted and
ignored during audio-only playback preparation; video soundtracks remain rejected.
Original files are referenced in place and are never stripped or rewritten.

**Music track** selects a track. **Add music track** is the single creation
path: it lists this project's ready music files and creates an independent
music track using the chosen one, up to eight. Dragging a ready file from Media's
**Music** list onto the music lane does the same at the drop frame. **Recording**
only changes the selected music track's source. The trash beside **Music track**
(**Delete selected music track**) removes only that music track. Import never implicitly
places music. Selection is editor-only; edits, recording changes and removal leave
other music tracks, video tracks, track keyframes and bin membership untouched. Each music track
retains independent drafts; selection never applies one music track's text to another.
Each accepted add/edit/remove or completed gesture is one Undo step; invalid or
cancelled gestures restore atomically without a committed edit/history/save.

Every music track has explicit source IN/OUT, timeline start/duration, gain dB,
fade durations and loop flag. A non-looping duration cannot exceed its selected
source range; looping repeats **only that range**. Source OUT must fit the registered
original and exceed IN; fade IN + OUT must fit duration. Timeline OUT must fit
0–2,147,483,647; overflow rejects the edit rather than shortening it.

Project duration is **max(all retimed video clip OUTs, every music start + duration)**,
including hidden video placements. Music can extend it. Each video closing fade
ends inside its last clip at that clip's OUT, then no active video means **opaque
black**, never a held last image. Music continues and fades at each music track's
own OUT. Music-only preview is naturally black; export requires at least one video
clip. A music tail uses composited export through full project duration.

Gain dB pairs a bounded native slider with an exact `NumberField`, using the same
local-draft/release-only gesture and full-precision numeric entry as playback rates.
Source IN/OUT, timeline start, duration and fades retain exact native numeric fields
with their existing units and timecode feedback, not arbitrary timing sliders.
Loop stays a checkbox.

Each music track's linear amplitude envelope is `10^(gainDb/20)` multiplied by
`offset/fadeIn` within its opening fade and `(duration-offset)/fadeOut` within its
closing fade. A zero fade is absent. Outside its placement the music track contributes
silence. Sum all active sources linearly **after per-track gain/fades**, then
hard-clamp to **[−1, 1] once after the complete sum**, separately for each channel.
Never clamp a source or intermediate sum: opposite-polarity contributions must
remain able to cancel. No normalisation, ducking, effects or hidden gain compensation.
Source-video audio stays disabled; clip speed and track Colour/Opacity are unchanged.

The preview streams **PCM16 48 kHz stereo** in exact bounded HTTP byte ranges into
one mixed stereo queue and **one AudioContext/AudioWorklet**, not per-track
queues/worklets, a media-element clock or whole-file buffers. Read and accumulate
sources serially into one output block, then clamp once and transfer that mixed
block. One dedicated reader worker performs these range reads, conversion and
mixing: the worklet returns credits to it and receives refill blocks directly, so
long preview-rendering tasks on the editor thread cannot delay refills. The editor
thread keeps epoch start/stop, startup prefill handoff and receipt validation.
The rendering thread owns consecutive mixed samples and their context-frame
receipts. Its first real rendered mixed sample supplies the clock origin; video starts
only once the output device reaches that origin. Project time follows the audio
output timestamp, not graph processing ahead of the speakers or an approximate
HTMLMediaElement currentTime. Elapsed rendering before acknowledgement is retained.
Consumption receipts independently check the unchanged one-project-frame drift
bound. Actual processor failures, range errors and empty-queue underruns remain
explicit; a source underrun freezes consumption instead of inventing successful
silence. Pause, seek, cancellation and disposal invalidate their complete epoch,
pending reads and late receipts; an obsolete completion cannot resume playback.
Video still uses integer project frames and exact observed source identities.
Normal decoded-callback latency within one project frame does not clear a valid
accepted image or restart music. Preview checks exact source maps for the clock
frame and its one-frame neighbours across every active source; a held source
frame's earliest inverse is not treated as its unique project time. Retaining an
uploaded image requires the same active clips and unchanged appearance. Larger or
incompatible mismatches, new sources and failed music synchronization still expose
buffering and require exact source readiness before recovery.
Placement, source IN/OUT, duration and loop boundaries use independently rounded
integer 48 kHz sample positions, matching native audio placement. Selected-range
wraps are filled into consecutive mixed blocks without a music restart; valid placement
silence is distinct from an underrun. Gain/fades are applied to each source's streamed
samples before mixing. **Four** 16,384-sample stereo Float32 queue/transfer blocks
retain at most **512 KiB total**, not per track, plus shared bounded **64 KiB**
range/short-selection scratch, one **128 KiB conversion workspace** and one
**128 KiB mixed-output workspace**. Receipts have one unacknowledged message and
reads are serial/credit-controlled. There are no duration-sized silence buffers
or per-track queues. Audio-buffer bounds do not scale with song/project duration
or track count; music track metadata is bounded by eight entries.
Missing active-source data is an explicit failure, never an omitted track or
successful silence. Pause/seek/edit/cancellation invalidate the whole mix epoch.
Target-browser long-run A/V/audio behaviour still needs
qualification; synthetic music regressions are not full Firefox qualification.
Short loop selections are reused only within one block; each refill still performs
a fresh guarded range read, rather than reading originals again for every wrap.
Startup/prefill has a ten-second operation deadline; a blocked module, missing
output acknowledgement or failed range cannot remain busy indefinitely.

Preparation uses the existing one-heavy-job worker and writes only the versioned
`pcm16-48k-stereo-mono-unity-v3` cache (about 11.52 MB per minute). Earlier AAC
preview caches remain unchanged but are not current playback input. Missing current
PCM caches appear as an explicit **Prepare** action on the file in Media → Music;
startup/library reads never prepare, rewrite or delete them. Prepare deliberately
to create the current cache, retaining originals and older generated files. Project
schema is 13; registry, video-proxy and PCM cache formats are unchanged. Native export
still reads original audio, not the preview transport.

Native mixing decodes **one original at a time** to exact selected **48 kHz stereo
s16 PCM**, then serially places/loops/envelopes it and pairwise-sums with the previous
**Float64 stereo accumulator**. The next full-project accumulator preserves amplitudes
outside −1–1: no intermediate clipping/normalisation. At most **two intermediate
audio inputs**, **one native audio child per pass** and **three audio scratch files**
(selected PCM + old/new accumulators) coexist; consumed inputs are deleted before
the next music track. One final mixed input is hard-clamped once before **48 kHz AAC**.
Audio silence/padding/sample count follows **full project duration**, including
black music tails, not the last video OUT. Existing video buffer/child/LUT bounds
remain unchanged.

Advisory audio disk planning is **maximum selected s16 PCM size + two full-project
Float64 stereo timelines**, not the sum of all originals or loop repetitions.
It is duration-dependent, not a fixed-GB guarantee; see
[export storage](UX_HARDENING.md#issue-3-export-storage-and-recovery). Failure or
cancellation cleans only owned scratch/partials and preserves completed outputs.

## Versioning

Project schema **v13** requires explicit `media.videoIds` and `media.audioIds` arrays,
unique and limited to 10,000 IDs each, plus complete video track colour with Temperature/Tint
and static HSL/curves, clip constant or 1–256-keyframe custom-curve
speed, required clip `spatial: { base, keyframes }` with eight-value base and
0–256 source-frame keyframes with required easing, track keyframe arrays with
all ten nullable value fields, placement and music
source OUT. `music` is a required 0–8 array with unique required music track IDs and
all per-track fields above; `[]` is the sole no-music representation, not null
or a compatibility default. Every video track also requires `ripple`, `transitions`, `openingFade` and
`closingFade`, plus numeric `opacity` in 0–1; 1 is the new-track initial value,
not a default for missing saved fields. Transitions/fades are track-local, with
no special first-track identity. Video tracks display and composite in their saved bottom-to-top array order.
The sole track `opacity` channel overrides the track's saved `opacity` on every clip,
including both dissolve sources; otherwise all use the saved track value.
Required nullable channels are `opacity` and the nine scalar colour settings,
including `temperature` and `tint`. Missing saved bases/channels are invalid, not defaulted.
Track `opacity` is valid and required; saved `clip.opacity` and old
`clipOpacity`/`layerOpacity` channels are rejected, not defaulted.
New projects have empty video/music bins. Standalone audio imports belong
to the open project's bin; every music track's references also count as membership.
Global registered music/proxies are reusable on deliberate import, never automatically
inherited by a new project. Earlier v1–v12 projects and export receipt snapshots remain unchanged
and incompatible. There is no migration, compatibility reader, null fallback, default-field
injection or automatic deletion; recreate projects and import their media to reuse
registered assets/verified ready proxies. Confirmed project deletion affects only
its saved document, not originals,
the shared content-deduplicated registry/cache or finished exports/receipts.
Registry/video-proxy/current PCM formats, source guards and native video budgets are unchanged;
native composition uses the sole Opacity contract without a track multiplier.
Preview uses the current explicitly prepared PCM cache described above.

Export receipts remain **version 1** with a strict **v13** snapshot, required
`musicSources` captured unique-original array and `settings.audio` identified
instance-plan array (`[]` for each without music). Plans preserve independent
timing/gain/fades/loop; several may refer to the same captured original. The plan
field `videoSamples` represents **full project duration**, including music tails.
Invalid arrays/older snapshots are rejected and their receipt/finished MP4 remains
untouched; no singular/null reader or automatic conversion is permitted.

Stored-keyframe inspection remains editor-only, never a persisted field or migration.
Synthetic correctness checks do not qualify intended-GPU preview,
long-flight throughput or long-run audio behaviour. Those acceptance requirements
are tracked in [#6](https://github.com/Plonk42/PasCap/issues/6),
[#7](https://github.com/Plonk42/PasCap/issues/7) and
[#8](https://github.com/Plonk42/PasCap/issues/8); real preparation/rendering needs
explicit owner consent. Consult
[GitHub Actions](https://github.com/Plonk42/PasCap/actions) for actual-commit CI,
not a cumulative historical test total.
