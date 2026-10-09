# Speed and audio contract · project v12

Nine video track-owned scalar Colour controls include Temperature/Tint (−1…1, neutral 0),
whose normalized linear gains precede Exposure. Positive Temperature warms;
positive Tint adds magenta; nonzero settings intentionally colour greys. They
can be keyed independently in video track animation without changing Speed semantics.
See [Temperature and Tint](design/TEMPERATURE_AND_TINT.md).
Static track HSL and master/RGB colour curves follow scalar grading and precede
black fades/coverage. They remain active with scalar keyframes, add no animation
channels and are unrelated to speed curves. Compare/Ungraded bypasses all Colour
without changing retiming, geometry, Opacity or music. Required data/resources:
[HSL_AND_CURVES.md](design/HSL_AND_CURVES.md).

## Two distinct retiming contracts

Speed is positive, **0.1×–8×**. Clips store independent **constant, ramp or custom
keyframed curves**; shared track keyframes can override Speed across every clip in their
video track. Clip keyframes use original-source frames, while track keyframes use project frames.
Do not confuse the track's project-time integral with a clip's source-time integral.

### Static clip base: source-time constant/ramp

When the video track has **no keyed Speed settings**, a constant-rate clip has duration
$\max(1,\operatorname{round}(\text{sourceFrames}/\text{rate}))$. Its effective
playback rate uses `sourceFrames / outputFrames` to distribute duration rounding.

Ramps store start/end rates, source-frame anchor IN/OUT, and a curve profile.
The curve is evaluated on **source progress**: linear $u$, ease-in $u^2$, ease-out
$2u-u^2$, smooth $3u^2-2u^3$. Outside the anchors it holds the nearest endpoint
rate. Trimming/restoring/splitting/duplication retain those original-source anchors.

The existing $dt = ds/r(s)$ map uses deterministic midpoint integration over
256–4096 uniform intervals. It rounds total output duration once, to at least one
integer frame, and rescales its integrated time map to that rounded duration.
Source sampling floors the mapped source position, with source OUT exclusive.
Each split piece compiles/rounds independently; static-base splitting can change
the sum by one frame. This source-anchor contract is retained, not converted into
track keyframes.

### Clip-instance custom curve: source-frame keyframes

The `speed` union also accepts a strict `{ mode: 'curve', keyframes }` value.
Each of **2–256** keyframes requires `{ frame, rate, interpolation }`: a unique ascending
integer original-source frame, rate **0.1–8**, and hold/linear/ease-in/ease-out/smooth
easing toward the next keyframe. First/last rates hold outside their interval. A keyframe
at the original's exclusive OUT is a valid boundary anchor, but none may exceed
the registered original; keyframes outside the current trim remain stored.

Timing integrates $dt=ds/r(s)$ on intervals split at **every keyframe**, including
one-source-frame holds in long recordings. Hold/constant intervals and linear
rate ramps have closed-form integrals/inverses. Eased intervals use bounded
16-point Gauss–Legendre quadrature with dimensionless tolerance $10^{-12}$ and
maximum subdivision depth 14; inverse queries use bounded binary search. Storage
is proportional to keyframes, not source or output duration. Existing constant/ramp
compilers and their rounding remain unchanged.

As for the old source-ramp base, only the final output duration is rounded, its
clock is normalised once to that duration, and mapped source positions are floored
within source IN/OUT. Slow motion repeats recorded frames and fast motion drops
them; no optical-flow frames are generated. Native decode still checks every
selected original frame, even when output sampling skips it.

Clip curves belong to **one clip**. Trims, moves, splits and marked
cuts retain original-source anchors; split/cut/duplicate copies are independent.
Every retained piece recompiles/rounds its duration once. Curves are carried in
the required `speed` field of strict schema 12, without an optional fallback,
data migration or project-wide speed field. A mode/preset change
is a deliberate editing command, not a conversion on load.

Original preset shapes provide Flat, Accelerate, Decelerate, Slow centre and Fast
centre templates on the selected source range. Their keyframes remain ordinary
editable data, not hidden saved preset IDs. The same `PlacedClip.retiming` map is
used for preview, source trims, static/composited native export and storage planning.
Keyed video track Speed settings retain their existing precedence: they override this
clip curve, not multiply it, and removing them restores the clip's independent
base without deleting any clip keyframes.

### Shared video track Speed: absolute project-time rate

Schema-12 track keyframes require eleven nullable channels: Opacity (`opacity`),
Speed (`speed`) and nine scalar colour settings. In control order: `opacity`,
`speed`, `temperature`, `tint`, `exposure`, `brightness`, `contrast`, `hue`,
`saturation`, `highlights`, `shadows`; static HSL/curves add no channels.
Once any keyframe on the track enables Speed, the track's rate curve **overrides
every clip's entire constant/ramp/custom-curve base**, not just an interval between keyframes. Only
keyed Speed settings define its intervals; unrelated colour/opacity-only keyframes are
skipped. Each left keyframe with Speed enabled supplies its shared hold/linear/ease-in/
ease-out/smooth easing to the next keyframe with Speed enabled. Before the first/after the
last, the endpoint rate holds. The saved clip base stays independent and is used
again if the last keyed Speed setting is removed.

For a clip placed at absolute project frame $P$, source length
$L=S_{\mathrm{out}}-S_{\mathrm{in}}$ and local elapsed output time $\tau$,
source consumption is:

$$
s(\tau)=S_{\mathrm{in}}+\int_P^{P+\tau}r(t)\,dt,
\qquad ds=r(t)\,dt.
$$

Rate intervals are integrated **analytically**, using the easing polynomials.
Their progress primitives are 0 (hold), $u^2/2$ (linear), $u^3/3$ (ease-in),
$u^2-u^3/3$ (ease-out), and $u^3-u^4/2$ (smooth). Positive rates make source
consumption monotonic; inversion locates the segment and solves its integral
(directly for a held/constant rate, bounded binary inversion otherwise).

Solve $s(\tau_{\mathrm{end}})=S_{\mathrm{out}}$ and round **only the duration**:
$D=\max(1,\operatorname{round}(\tau_{\mathrm{end}}))$. **Keyframe times, rates and
the integral are never rescaled** to that rounded duration. At integer output
positions $0\le n<D$, sample $\lfloor s(n)\rfloor$ within
$[S_{\mathrm{in}},S_{\mathrm{out}}-1]$. The map repeats held source frames or drops
unsampled frames; it does not synthesize optical-flow images. The analytic map
stores keyframe intervals, not a duration-sized frame array.

### Placement, preview and native parity

`calculateLayout()` compiles one **`PlacedClip.retiming`** at each clip's actual
video track/start. Preview seeking, decoder rates, inverse queries and native original
retiming/span checks consume that same map. Native output requires a monotonic,
integer, in-range `sourceAt` result and exact frame counts; a malformed supplied
map is rejected rather than falling back to a clip's static speed.

Clip spatial geometry evaluates at the same map's continuous
`sourcePositionAt(localOutputFrame)`, while `sourceAt` identifies the integer
recorded image. Slow motion may animate crop/scale/translation/rotation over a
held image without optical flow. Video track Speed changes this continuous map, not the
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
change RGB without reducing coverage. Any shared track keyframe, even speed-only,
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

With video track Speed keyframes, moving the same clip changes its contextual duration.
Each track's **Ripple** setting governs placement. While on (the new-track default),
clips continuously sequence from the first anchor, subtracting dissolve overlaps
and recompiling downstream durations at their new starts; commands persist these
actual starts. Enabling Ripple closes gaps in one Undo step while retaining the
first current start; turning it off captures actual placements. While off, starts
stay independent and duration edits never move unrelated clips. Other tracks,
music and absolute track keyframes stay put. Transition/fade durations remain **output**
frames on their own track. Invalid fade/transition regions, arbitrary same-track
overlap or triple overlap reject the entire edit, including a rate/keyframe-time/easing change.
This includes direct marker dragging and marker keyboard moves: a timing conflict
rejects the **whole shared keyframe**, never just its keyed Speed setting, and never
shortens transitions to make the destination fit.

Moving ghosts and commits use the same contextual duration calculation. A
trailing-edge magnet solves the new start/end against the track curve rather than
using the old width. Left handle/keyboard trims with Ripple off retain timeline OUT; an
unrepresentable integer-frame result is explicitly rejected. **Clip → Range**
text fields, bar handles and **Restore full recording** use ordinary source-range trim:
retain the start in either mode and re-sequence the Ripple suffix normally, not
the timeline left handle's retained-OUT rule. Ripple-on timeline left trims keep their sequence
start and recompile the suffix. Only the first anchor supports numeric start/nudge
while on; later clips expose the reason to turn Ripple off or drag to reorder.
Trim/move/split/duplicate never copy or shift track keyframes; each
split piece has its own contextual duration rounding, so exact total duration is
not guaranteed. Originals and full proxies remain unchanged.

### Editing speed

Playback rates use the shared native slider plus an adjacent exact `NumberField`,
bounded to **0.1×–8×**: constant speed, ramp endpoints, a selected custom-curve
keyframe's rate, and main/stored track Speed. Modes, presets and the curve graph remain
separate controls. Pointer sliding changes only a transient local value draft (only Colour, Opacity and HSL sliders also preview it in the image); release applies one validated document edit and updates the image. Escape, pointer cancellation, lost capture or window blur restores the starting value without save/history. Each keyboard slider adjustment is an individual validated edit.
Numeric entry retains full precision, applies on Enter/blur and restores on Escape;
invalid drafts remain editable without clamping or rounding.

In **Clip → Speed** there is no Animate toggle or stored preference; the keyframe line (count, Previous/Next and Reset) shows while the section is expanded.

The track Speed diamond explicitly joins/leaves Speed at the
real project frame, capturing the displayed rate, never an inspected stored time.
Changing a value never creates implicit endpoint keyframes. Per-setting
**Previous/Next** buttons remain beside the main diamond because not every setting
is enabled at every shared keyframe. One native **Previous/Next** pair in the keyframe line, beside the count, visits the union of track Speed keyframes and **all retained custom speed source
keyframes of the selected clip**, including off-trim keyframes and the original
exclusive OUT. Clip keyframes preview the nearest mapped image through authoritative
`PlacedClip.retiming`: off-trim keyframes use the first/last available output image,
and original OUT never requests an out-of-range image. A clip-local stored-source
cursor, independent of the central track inspection cursor, advances through
successive clip keyframes even when several preview the same image. Stored source
time stays distinct from the actual displayed source frame. Track Speed overrides
retained clip keyframes without deleting them or removing them from navigation,
and the override is indicated. Colour/Opacity-only track keyframes are skipped.
Navigation is editor-only, preserving
the Inspector tab/focus without a rate/base edit, history or save. Enabled Speed
chips in stored Keyframes rows retain their per-channel arrows too. Main and
stored Speed arrows visit only strictly earlier/later track keyframes where
Speed is nonnull. All main and stored per-channel arrows use that same nonnull
rule (zero is enabled for channels that allow it) and the shared central
off-duration inspection cursor, skipping unrelated enabled settings.

The main animated rate controls are read-only where Speed is not enabled, until its hollow diamond is clicked; they are shown dimmed with a lock cue.
Unanimated Speed uses **Constant speed / Ramp up / Ramp down**
or **Custom curve** clip controls. Reset to 1× affects only the active keyed track Speed
setting at the playhead, otherwise the selected clip's base.

The **Track → Keyframes** section contains the
directly visible whole-track keyframe list and keyframe navigation. Its toolbar's
**Animation help** includes keyframe-timing guidance, with no separate Keyframe timing
help button. There is no outer list disclosure or per-track list expansion preference;
nested **Edit** details remain collapsible and preserve drafts
and input identity through reordering and Undo. **Keyframes → Edit**
edits stored keyframe times, easing and existing enabled settings, including beyond current duration
or on an empty track. A stored keyed Speed setting reuses the **Track rate ×** slider/exact
`NumberField` (double-click **Speed** resets it to 1×), not clip mode/preset/source-curve controls. Enter/blur applies
the precise rate; Escape restores. The same **0.1×–8×** bounds and contextual timing
validation apply. Invalid drafts retain inline errors rather than being clamped,
rounded or used to shorten conflicting fades/transitions.

Each accepted stored rate/reset changes only that existing keyed Speed setting in
**one Undo step**. Its time, shared easing, other enabled settings/keyframes and the saved
clip bases stay unchanged; it never implicitly joins Speed or requests a seek.
Stored keyed colour/opacity settings likewise reuse the main sliders and individual
colour resets, with one exact `NumberField` beside each slider as the sole numeric
value display, targeting only that stored keyed setting. Opacity numeric entry uses
**0–100%**, neutral **100%**, in both main and stored controls; stored values remain **0–1**.

Drag a track keyframe marker horizontally or use its one-/ten-frame keyboard moves to move
all enabled settings and their existing easing in **one Undo step**, using the same
validation as the shared time field. Valid pointer drafts preview the recalculated
contextual layout without saving; occupied frames and invalid timing never merge,
overwrite, shrink transitions or commit an earlier valid preview. Escape, pointer
cancellation, lost capture or window blur restores preview/document/scroll.
Source ranges, static clip bases, other track keyframes and music are not copied/shifted;
Speed can naturally recompile clip durations and Ripple-derived track starts.

Main per-setting arrows, stored-setting chip arrows, section navigation to track
keyframes and track/list navigation share a stored-keyframe inspection cursor,
so several off-duration Speed keyframes remain reachable even when preview clamps to the same
last frame. Marker and whole-track keyframe navigation keep the chosen Inspector tab.
Labels distinguish stored time from actual preview. The main Clip rate field and
diamond capture still use the **real playhead**, not the inspected off-duration
time; list controls target their stored keyframe. Storing/moving a keyframe beyond
duration does not extend the sequence merely for that keyframe; actual clip
retiming or a music track's OUT can change project duration. Details:
[LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

### Precise clip-curve editor

With a clip selected and no overriding track Speed keyframes, open **Clip → Speed**,
choose **Custom curve**. A constant rate becomes a flat
editable curve; converting an old
ramp retains its original anchors and easing. Flat, Accelerate, Decelerate, Slow
centre and Fast centre buttons deliberately replace only this clip's speed keyframes.

The graph uses source time horizontally and a logarithmic **0.1×–8×** speed axis
vertically. A vertical line identifies the actually displayed source frame. Click
the background or a keyframe to preview, then **Add keyframe** captures speed at an
unkeyed displayed source frame. The original exclusive-OUT keyframe previews the last
output frame, never an invented source frame. Source navigation compares the
two adjacent mapped outputs, showing the exact source image when available or
the closest rendered image when fast playback skips it; the stored keyframe stays
at its requested source frame. The Speed keyframe line's navigation visits
all retained clip source keyframes alongside track Speed keyframes, including
off-trim and original-OUT keyframes. The native keyframe selector also retains
access to them; clip selection uses the independent stored-source cursor above,
not the clamped preview frame as a substitute for stored source time.

**Source frame / Speed × / Easing** provide exact editing: source frame
uses a native integer `NumberField`; Speed × pairs a slider with an exact field.
Numeric fields retain full entered decimal precision and commit on Enter/blur; invalid collisions,
out-of-original positions and timing conflicts retain the draft with inline
errors. They do not automatically seek. Escape restores the field. Easing belongs
to the left keyframe; the last rate holds without a next interval.
Custom clip-speed, ramp, Transform and track-keyframe selectors all visibly read
**Easing**, retaining contextual accessible names such as **Ramp easing** and
**Track keyframe easing N**. Clip-speed, ramp and track-keyframe selectors retain
the same compact selected-shape graph and accessible description. It illustrates
the existing progress function, not a new rate or interpolation rule; ramp curves
still exclude Hold. Selection remains native and commits once, with one Undo step.

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
and Delete removes it if at least two
keyframes remain. These controls isolate timeline shortcuts; the source frame field
remains reachable if a keyframe moves outside the visible trim. New keyframes select
themselves. Reset removes this clip curve in favour of constant 1× without
changing track keyframes or other clips. The **Video track speed animation** controls remain
separate; an explicit override notice appears when track Speed suppresses clip speed.

### Timeline clip-speed markers

Inside each clip rectangle, custom-speed source keyframes appear in a salmon/dashed
**◆** lane, distinct from the boxed blue **▼** Transform lane. Positions follow
authoritative retiming, including a track Speed override; retained overridden
keyframes are indicated, not deleted. Off-trim keyframes are omitted. Exclusive OUT has a
boundary marker that seeks the final available frame. Click, Enter or Space
selects the clip, seeks its nearest mapped image and opens Clip → Speed without
editing; Transform keys, unlike these, slide on the timeline. Keyboard handling is isolated from timeline shortcuts. These
markers are distinct from draggable shared project-time track markers and from
the editable source-speed graph. Unlike these markers, Speed and Transform stored
navigation reaches all retained off-trim/original-OUT keyframes; neither navigation
nor inspection supplies a fake frame for main capture.

## Music

Strict schema 12 requires `music: MusicTrack[]`, with **0–8 independent music tracks**
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
schema is 12; registry, video-proxy and PCM cache formats are unchanged. Native export
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

Project schema **v12** requires explicit `media.videoIds` and `media.audioIds` arrays,
unique and limited to 10,000 IDs each, plus complete video track colour with Temperature/Tint
and static HSL/curves, clip constant/ramp/custom-curve
speed, required clip `spatial: { base, keyframes }` with eight-value base and
0–256 source-frame keyframes with required easing, track keyframe arrays with
all eleven nullable value fields, placement and music
source OUT. `music` is a required 0–8 array with unique required music track IDs and
all per-track fields above; `[]` is the sole no-music representation, not null
or a compatibility default. Every video track also requires `ripple`, `transitions`, `openingFade` and
`closingFade`, plus numeric `opacity` in 0–1; 1 is the new-track initial value,
not a default for missing saved fields. Transitions/fades are track-local, with
no special first-track identity. Video tracks display and composite in their saved bottom-to-top array order.
The sole track `opacity` channel overrides the track's saved `opacity` on every clip,
including both dissolve sources; otherwise all use the saved track value.
Required nullable channels are `opacity`, `speed` and the nine scalar colour settings,
including `temperature` and `tint`. Missing saved bases/channels are invalid, not defaulted.
Track `opacity` is valid and required; saved `clip.opacity` and old
`clipOpacity`/`layerOpacity` channels are rejected, not defaulted.
New projects have empty video/music bins. Standalone audio imports belong
to the open project's bin; every music track's references also count as membership.
Global registered music/proxies are reusable on deliberate import, never automatically
inherited by a new project. Earlier v1–v11 projects and export receipt snapshots remain unchanged
and incompatible. There is no migration, compatibility reader, null fallback, default-field
injection or automatic deletion; recreate projects and import their media to reuse
registered assets/verified ready proxies. Confirmed project deletion affects only
its saved document, not originals,
the shared content-deduplicated registry/cache or finished exports/receipts.
Registry/video-proxy/current PCM formats, source guards and native video budgets are unchanged;
native composition uses the sole Opacity contract without a track multiplier.
Preview uses the current explicitly prepared PCM cache described above.

Export receipts remain **version 1** with a strict **v12** snapshot, required
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
