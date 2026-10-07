# Speed and audio contract · project v9

## Two distinct retiming contracts

Speed is positive, **0.1×–8×**. Clips store independent **constant, ramp or custom
keyframed curves**; shared row points can override Speed across every clip in their
layer. Clip keys use original-source frames, while row keys use project frames.
Do not confuse the row's project-time integral with a clip's source-time integral.

### Static clip base: source-time constant/ramp

When the row has **no Speed participants**, a constant-rate excerpt has duration
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
row points.

### Clip-instance custom curve: source-frame keyframes

The `speed` union also accepts a strict `{ mode: 'curve', keyframes }` value.
Each of **2–256** keys requires `{ frame, rate, interpolation }`: a unique ascending
integer original-source frame, rate **0.1–8**, and hold/linear/ease-in/ease-out/smooth
easing toward the next point. First/last rates hold outside their interval. A key
at the original's exclusive OUT is a valid boundary anchor, but none may exceed
the registered original; points outside the current trim remain stored.

Timing integrates $dt=ds/r(s)$ on intervals split at **every key**, including
one-source-frame holds in long recordings. Hold/constant intervals and linear
rate ramps have closed-form integrals/inverses. Eased intervals use bounded
16-point Gauss–Legendre quadrature with dimensionless tolerance $10^{-12}$ and
maximum subdivision depth 14; inverse queries use bounded binary search. Storage
is proportional to points, not source or output duration. Existing constant/ramp
compilers and their rounding remain unchanged.

As for the old source-ramp base, only the final output duration is rounded, its
clock is normalised once to that duration, and mapped source positions are floored
within source IN/OUT. Slow motion repeats recorded frames and fast motion drops
them; no optical-flow frames are generated. Native decode still checks every
selected original frame, even when output sampling skips it.

Clip curves belong to **one excerpt instance**. Trims, moves, splits and marked
cuts retain original-source anchors; split/cut/duplicate copies are independent.
Every retained piece recompiles/rounds its duration once. Curves are carried in
the required `speed` field of strict schema 9, without an optional fallback,
data migration or project-wide speed field. A mode/preset change
is a deliberate editing command, not a conversion on load.

Original preset shapes provide Flat, Accelerate, Decelerate, Slow centre and Fast
centre templates on the selected source range. Their points remain ordinary
editable data, not hidden saved preset IDs. The same `PlacedClip.retiming` map is
used for preview, source trims, static/layered native export and storage planning.
Row Speed participants retain their existing precedence: they override this
clip curve, not multiply it, and removing them restores the clip's independent
base without deleting any clip points.

### Shared row Speed: absolute project-time rate

Schema-9 layer points require nine nullable channels: Opacity (`opacity`),
Speed (`speed`) and seven colour settings.
Once any point on the row participates in Speed, the row's rate curve **overrides
every clip's entire constant/ramp/custom-curve base**, not just an interval between keys. Only
Speed participants define its intervals; unrelated colour/opacity-only points are
skipped. Each left participating point supplies its shared hold/linear/ease-in/
ease-out/smooth easing to the next Speed participant. Before the first/after the
last, the endpoint rate holds. The saved clip base stays independent and is used
again if the last Speed participation is removed.

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
$D=\max(1,\operatorname{round}(\tau_{\mathrm{end}}))$. **Point times, rates and
the integral are never rescaled** to that rounded duration. At integer output
positions $0\le n<D$, sample $\lfloor s(n)\rfloor$ within
$[S_{\mathrm{in}},S_{\mathrm{out}}-1]$. The map repeats held source frames or drops
unsampled frames; it does not synthesize optical-flow images. The analytic map
stores key intervals, not a duration-sized frame array.

### Placement, preview and native parity

`calculateLayout()` compiles one **`PlacedClip.retiming`** at each clip's actual
layer/start. Preview seeking, decoder rates, inverse queries and native original
retiming/span checks consume that same map. Native output requires a monotonic,
integer, in-range `sourceAt` result and exact frame counts; a malformed supplied
map is rejected rather than falling back to a clip's static speed.

Clip spatial geometry evaluates at the same map's continuous
`sourcePositionAt(localOutputFrame)`, while `sourceAt` identifies the integer
recorded image. Slow motion may animate crop/scale/translation/rotation over a
held image without optical flow. Row Speed changes this continuous map, not the
clip's stored spatial keys: trim/move/split/cut/duplicate retain original-source
anchors, including off-trim and original exclusive-OUT keys, with independent
deep copies for new pieces. Spatial edits are appearance-only and do not change
speed, placement or duration. See [spatial transforms](design/SPATIAL_TRANSFORMS.md).

All row colour/opacity parameters are sampled at **absolute project time**, not at
the retimed source frame. A held source image can therefore receive a different
grade on the next project frame. Native LUT generation and preview redraw both
follow that rule. Every source uses the row's required numeric `opacity` in 0–1,
initially 1 on new tracks, unless the sole row **Opacity** (`opacity`) channel
overrides it. Evaluate that one row setting for each source, including both
dissolve participants; there is no saved `clip.opacity`.
With graded RGB $G_i$, black-fade brightness $b_i$, evaluated Opacity $o_i$ and
dissolve weight $w_i$ and spatial pixel coverage $m_i$, each track forms one group
with $C = \sum_i G_i b_i o_i w_i m_i$ and $A = \sum_i o_i w_i m_i$. Source-over is
$\mathrm{result} = C + \mathrm{lower}(1 - A)$, with no layer multiplier; black fades
change RGB without reducing coverage. Any shared row point, even speed-only,
requires the layered export path; any nonneutral spatial base or spatial key
(even neutral keys) does too. Exact neutral poses retain opaque black letterboxing
after grading; nonneutral uncovered pixels reveal lower footage. The static chunk
plan cannot silently omit these edits.
Opacity is composition coverage, not part of the unchanged SDR RGB grade.
Its single native slider/exact `NumberField`/diamond/navigation is in **Clip → Colour**
alongside the colour controls. Numeric entry is **0–1**, initially **1**; the main
label may show **100%**. Without Opacity keys it edits row `opacity`, even on
an empty row. With keys, a missing participant at the real playhead is read-only
until captured with the diamond; sliders never create keys. Unkeyed colour
settings remain per-clip. **Placement** contains placement only; Layer options
contains rename, Ripple, ordering and deletion, with visibility separate.

With row Speed keys, moving the same excerpt changes its contextual duration.
Each track's **Ripple** setting governs placement. While on (the new-track default),
clips continuously sequence from the first anchor, subtracting dissolve overlaps
and recompiling downstream durations at their new starts; commands persist these
actual starts. Enabling Ripple closes gaps in one Undo step while retaining the
first current start; turning it off captures actual placements. While off, starts
stay independent and duration edits never move unrelated clips. Other tracks,
music and absolute row points stay put. Transition/fade durations remain **output**
frames on their own track. Invalid fade/transition regions, arbitrary same-track
overlap or triple overlap reject the entire edit, including a rate/point-time/easing change.
This includes direct marker dragging and marker keyboard moves: a timing conflict
rejects the **whole shared point**, never just its Speed participant, and never
shortens transitions to make the destination fit.

Moving ghosts and commits use the same contextual duration calculation. A
trailing-edge magnet solves the new start/end against the row curve rather than
using the old width. Left handle/keyboard trims with Ripple off retain timeline OUT; an
unrepresentable integer-frame result is explicitly rejected. Numeric source fields
retain the start in either mode; Ripple-on left trims also keep their sequence
start and recompile the suffix. Only the first anchor supports numeric start/nudge
while on; later clips expose the reason to turn Ripple off or drag to reorder.
Trim/move/split/duplicate never copy or shift row points; each
split piece has its own contextual duration rounding, so exact total duration is
not guaranteed. Originals and full proxies remain unchanged.

### Editing speed

Playback rates use the shared native slider plus an adjacent exact `NumberField`,
bounded to **0.1×–8×**: constant speed, ramp endpoints, a selected custom-curve
point's rate, and main/stored row Speed. Modes, presets and the curve graph remain
separate controls. Pointer sliding changes only a transient local value draft;
release applies one validated document edit and updates the image. Escape, pointer
cancellation, lost capture or window blur restores the starting value without
save/history. Each keyboard slider adjustment is an individual validated edit.
Numeric entry retains full precision, applies on Enter/blur and restores on Escape;
invalid drafts remain editable without clamping or rounding.

In **Clip → Speed**, the diamond explicitly joins/leaves Speed at the current
project frame. It captures the displayed rate; changing a control never creates
implicit endpoint keys.
Immediately after it, native SVG **Previous/Next** buttons visit strictly earlier/
later points with a non-null Speed value, skipping colour/opacity-only points. They
stay visible but disabled without a neighbour, an opened project, or during any
document-preview draft. Navigation preserves the chosen Inspector tab and activated
button's focus; it is editor-only, not a rate/base change or an Undo/autosave operation.

The main animated rate controls are read-only where Speed does not participate until
its hollow diamond is clicked. Unanimated Speed uses **Constant speed / Ramp up / Ramp down**
or **Custom curve** clip controls. Reset to 1× affects only the active row Speed
participant at the playhead when keyed, otherwise the selected clip's base.

The dedicated **Keyframes** tab (accessible name **Layer keyframes**) contains the
directly visible whole-row point list and point navigation. Its toolbar's
**Animation help** includes point-timing guidance, with no separate Keyframe timing
help button. There is no outer list disclosure or per-row list expansion preference;
nested **Time, easing & values** details remain collapsible and preserve drafts
and input identity through reordering and Undo. **Keyframes → Time, easing & values**
edits stored point times, easing and existing participants, including beyond current duration
or on an empty row. A stored Speed participant reuses the **Layer rate ×** slider/exact
`NumberField` and Reset to 1×, not clip mode/preset/source-curve controls. Enter/blur applies
the precise rate; Escape restores. The same **0.1×–8×** bounds and contextual timing
validation apply. Invalid drafts retain inline errors rather than being clamped,
rounded or used to shorten conflicting fades/transitions.

Each accepted stored rate/reset changes only that existing Speed participant in
**one Undo step**. Its time, shared easing, other participants/points and the saved
clip bases stay unchanged; it never implicitly joins Speed or requests a seek.
Stored colour/opacity participants likewise reuse the main sliders and individual
colour resets, with one exact `NumberField` beside each slider as the sole numeric
value display, targeting only that stored participant. Opacity numeric entry uses
**0–1** in both main and stored controls.

Drag a row marker horizontally or use its one-/ten-frame keyboard moves to move
all participants and their existing easing in **one Undo step**, using the same
validation as the shared time field. Valid pointer drafts preview the recalculated
contextual layout without saving; occupied frames and invalid timing never merge,
overwrite, shrink transitions or commit an earlier valid preview. Escape, pointer
cancellation, lost capture or window blur restores preview/document/scroll.
Source ranges, static clip bases, other row points and music are not copied/shifted;
Speed can naturally recompile clip durations and Ripple-derived track starts.

Setting/row/list navigation shares a stored-point inspection cursor, so several
off-duration Speed points remain reachable even when preview clamps to the same
last frame. Marker and whole-row point navigation keep the chosen Inspector tab.
Labels distinguish stored time from actual preview. The main Clip rate field and
diamond capture still use the **real playhead**, not the inspected off-duration
time; list controls target their stored point. Storing/moving a point beyond
duration does not extend the sequence merely for that point; actual clip
retiming or a music instance's OUT can change project duration. Details:
[LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

### Precise clip-curve editor

With an excerpt selected and no overriding row Speed keys, choose **Clip → Speed →
Custom curve**. A constant rate becomes a flat editable curve; converting an old
ramp retains its original anchors and easing. Flat, Accelerate, Decelerate, Slow
centre and Fast centre buttons deliberately replace only this clip's speed points.

The graph uses source time horizontally and a logarithmic **0.1×–8×** speed axis
vertically. A vertical line identifies the actually displayed source frame. Click
the background or a point to preview, then **Add point** captures speed at an
unkeyed displayed source frame. The exclusive OUT anchor previews the last
output frame, never an invented source frame. Source navigation compares the
two adjacent mapped outputs, showing the exact source image when available or
the closest rendered image when fast playback skips it; the stored key stays
at its requested source frame. Point arrows and the native
point selector also reach retained off-trim keys.

**Source frame / Speed × / To next point** provide exact editing: source frame
uses a native integer `NumberField`; Speed × pairs a slider with an exact field.
Numeric fields retain full entered decimal precision and commit on Enter/blur; invalid collisions,
out-of-original positions and timing conflicts retain the draft with inline
errors. They do not automatically seek. Escape restores the field. Easing belongs
to the left point; the last rate holds without a next interval.
Custom **To next point**, ramp **Curve** and shared **Shared easing** selectors
use the same compact selected-shape graph and accessible description. It illustrates
the existing progress function, not a new rate or interpolation rule; ramp curves
still exclude Hold. Selection remains native and commits once, with one Undo step.

Graph-point dragging is separate from the release-only value slider. Drag a point
horizontally to change its integer source frame and vertically to change its speed,
quantised to **0.001×** for pointer movement only. Capture-relative
geometry does not drift as duration changes. Valid drafts preview the complete
new layout while retaining the displayed original source position, but do not
enter committed history/autosave. Valid release is **one Undo**. Red collision/
fade/overlap feedback rejects the entire release, not just the last invalid
movement; no merge, transition shortening or last-valid commit occurs.
Escape, pointer cancellation, lost capture and window blur restore the original
preview/document. Other edit/navigation gestures are disabled during capture.

Focused point Left/Right changes one source frame (Shift ten), Up/Down changes
0.01× (Shift 0.1×) while retaining the entered decimal precision, Enter previews it,
and Delete removes it if at least two
points remain. These controls isolate timeline shortcuts; the source frame field
remains reachable if a point moves outside the visible trim. New points select
themselves. Reset removes this clip curve in favour of constant 1× without
changing row points or other clips. The **Row speed animation** controls remain
separate; an explicit override notice appears when row Speed suppresses clip speed.

## Music

Strict schema 9 requires `music: MusicTrack[]`, with **0–8 independent instances**
and unique required instance `id` values; `[]` means no music. Each instance
requires `mediaId`, `sourceIn`, `sourceOut`, `start`, `duration`, `gainDb`, `fadeIn`,
`fadeOut` and `loop`. Several instances can use the same registered recording
without sharing edits. A missing array/ID, null/singular music, unknown fields or
duplicate IDs are errors, never defaulted or migrated. Detailed bounds and pending
acceptance are in [MULTIPLE_MUSIC.md](design/MULTIPLE_MUSIC.md).

**Audio → Music → Browse music files** opens a keyboard-accessible native modal
beside the manual **Music file path / Import audio** form. Choose one radio-selected
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
Existing entries and project references are not reassociated or removed. Select
the new entry in **Recording** for deliberate placement. Verified fingerprint-matching PCM can
be reused through the serial worker; originals and old caches remain untouched.

Standalone music import requires exactly one audio stream and no video footage.
Embedded cover artwork explicitly marked as an attached picture is accepted and
ignored during audio-only playback preparation; video soundtracks remain rejected.
Original files are referenced in place and are never stripped or rewritten.

**Music track** selects an instance. **Add music track** creates an independent
instance of the chosen ready/prepared **Recording**, up to eight; the trash action
**Delete selected music track** removes only that instance. Import never implicitly
places music. Selection is editor-only; edits, recording changes and removal leave
other instances, videos, row points and bin membership untouched. Each instance
retains independent drafts; selection never applies one instance's text to another.
Each accepted add/edit/remove or completed gesture is one Undo step; invalid or
cancelled gestures restore atomically without a committed edit/history/save.

Every instance has explicit source IN/OUT, timeline start/duration, gain dB,
fade durations and loop flag. A non-looping duration cannot exceed its selected
source range; looping repeats **only that range**. Source OUT must fit the registered
original and exceed IN; fade IN + OUT must fit duration. Timeline OUT must fit
0–2,147,483,647; overflow rejects the edit rather than shortening it.

Project duration is **max(all retimed video clip OUTs, every music start + duration)**,
including hidden video placements. Music can extend it. Each video closing fade
ends inside its last clip at that clip's OUT, then no active video means **opaque
black**, never a held last image. Music continues and fades at each instance's
own OUT. Music-only preview is naturally black; export requires at least one video
clip. A music tail uses layered export through full project duration.

Gain dB pairs a bounded native slider with an exact `NumberField`, using the same
local-draft/release-only gesture and full-precision numeric entry as playback rates.
Source IN/OUT, timeline start, duration and fades retain exact native numeric fields
with their existing units and timecode feedback, not arbitrary timing sliders.
Loop stays a checkbox.

Each instance's linear amplitude envelope is `10^(gainDb/20)` multiplied by
`offset/fadeIn` within its opening fade and `(duration-offset)/fadeOut` within its
closing fade. A zero fade is absent. Outside its placement the instance contributes
silence. Sum all active sources linearly **after per-instance gain/fades**, then
hard-clamp to **[−1, 1] once after the complete sum**, separately for each channel.
Never clamp a source or intermediate sum: opposite-polarity contributions must
remain able to cancel. No normalisation, ducking, effects or hidden gain compensation.
Source-video audio stays disabled; clip colour/speed and sole row Opacity are unchanged.

The preview streams **PCM16 48 kHz stereo** in exact bounded HTTP byte ranges into
one mixed stereo queue and **one AudioContext/AudioWorklet**, not per-instance
queues/worklets, a media-element clock or whole-file buffers. Read and accumulate
sources serially into one output block, then clamp once and transfer that mixed
block. The rendering thread owns consecutive mixed samples and their context-frame
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
frame and its one-frame neighbours across every active participant; a held source
frame's earliest inverse is not treated as its unique project time. Retaining an
uploaded image requires the same active clips and unchanged appearance. Larger or
incompatible mismatches, new sources and failed music synchronization still expose
buffering and require exact source readiness before recovery.
Placement, source IN/OUT, duration and loop boundaries use independently rounded
integer 48 kHz sample positions, matching native audio placement. Selected-range
wraps are filled into consecutive mixed blocks without a music restart; valid placement
silence is distinct from an underrun. Gain/fades are applied to each source's streamed
samples before mixing. **Four** 16,384-sample stereo Float32 queue/transfer blocks
retain at most **512 KiB total**, not per instance, plus shared bounded **64 KiB**
range/short-selection scratch, one **128 KiB conversion workspace** and one
**128 KiB mixed-output workspace**. Receipts have one unacknowledged message and
reads are serial/credit-controlled. There are no duration-sized silence buffers
or per-track queues. Audio-buffer bounds do not scale with song/project duration
or instance count; instance metadata is bounded by eight entries.
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
PCM caches appear as an explicit **Retry** preparation action in Audio → Music;
startup/library reads never prepare, rewrite or delete them. Prepare deliberately
to create the current cache, retaining originals and older generated files. Project
schema is 9; registry, video-proxy and PCM cache formats are unchanged. Native export
still reads original audio, not the preview transport.

Native mixing decodes **one original at a time** to exact selected **48 kHz stereo
s16 PCM**, then serially places/loops/envelopes it and pairwise-sums with the previous
**Float64 stereo accumulator**. The next full-project accumulator preserves amplitudes
outside −1–1: no intermediate clipping/normalisation. At most **two intermediate
audio inputs**, **one native audio child per pass** and **three audio scratch files**
(selected PCM + old/new accumulators) coexist; consumed inputs are deleted before
the next instance. One final mixed input is hard-clamped once before **48 kHz AAC**.
Audio silence/padding/sample count follows **full project duration**, including
black music tails, not the last video OUT. Existing video buffer/child/LUT bounds
remain unchanged.

Advisory audio disk planning is **maximum selected s16 PCM size + two full-project
Float64 stereo timelines**, not the sum of all originals or loop repetitions.
It is duration-dependent, not a fixed-GB guarantee; see
[export storage](UX_HARDENING.md#issue-3-export-storage-and-recovery). Failure or
cancellation cleans only owned scratch/partials and preserves completed outputs.

## Versioning

Project schema **v9** requires explicit `media.videoIds` and `media.audioIds` arrays,
unique and limited to 10,000 IDs each, plus complete clip colour/constant/ramp/custom-curve
speed, required clip `spatial: { base, keyframes }` with eight-value base and
0–256 full-pose source-frame keys with required easing, layer point arrays with
all nine nullable value fields, placement and music
source OUT. `music` is a required 0–8 array with unique required instance IDs and
all per-instance fields above; `[]` is the sole no-music representation, not null
or a compatibility default. Every layer also requires `ripple`, `transitions`, `openingFade` and
`closingFade`, plus numeric `opacity` in 0–1; 1 is the new-track initial value,
not a default for missing saved fields. Transitions/fades are track-local, with
no special first-track identity. Layers display and composite in their saved bottom-to-top array order.
The sole row `opacity` channel overrides the row's saved `opacity` on every clip,
including both dissolve sources; otherwise all use the saved row value.
Required nullable channels are `opacity`, `speed` and the seven colour settings.
Row `opacity` is valid and required; saved `clip.opacity` and old
`clipOpacity`/`layerOpacity` channels are rejected, not defaulted.
New projects have empty video/music bins. Standalone audio imports belong
to the open project's bin; every music instance's references also count as membership.
Global registered music/proxies are reusable on deliberate import, never automatically
inherited by a new project. Earlier v1–v8 projects and export receipt snapshots remain unchanged
and incompatible. There is no migration, compatibility reader, null fallback, default-field
injection or automatic deletion; recreate projects and import their media to reuse
registered assets/verified ready proxies. Confirmed project deletion affects only
its saved document, not originals,
the shared content-deduplicated registry/cache or finished exports/receipts.
Registry/video-proxy/current PCM formats, source guards and native video budgets are unchanged;
native composition uses the sole Opacity contract without a layer multiplier.
Preview uses the current explicitly prepared PCM cache described above.

Export receipts remain **version 1** with a strict **v9** snapshot, required
`musicSources` captured unique-original array and `settings.audio` identified
instance-plan array (`[]` for each without music). Plans preserve independent
timing/gain/fades/loop; several may refer to the same captured original. The plan
field `videoSamples` represents **full project duration**, including music tails.
Invalid arrays/older snapshots are rejected and their receipt/finished MP4 remains
untouched; no singular/null reader or automatic conversion is permitted.

Stored-point inspection remains editor-only, never a persisted field or migration.
Synthetic correctness checks do not qualify intended-GPU preview,
long-flight throughput or long-run audio behaviour. Those acceptance requirements
are tracked in [#6](https://github.com/Plonk42/PasCap/issues/6),
[#7](https://github.com/Plonk42/PasCap/issues/7) and
[#8](https://github.com/Plonk42/PasCap/issues/8); real preparation/rendering needs
explicit owner consent. Consult
[GitHub Actions](https://github.com/Plonk42/PasCap/actions) for actual-commit CI,
not a cumulative historical test total.
