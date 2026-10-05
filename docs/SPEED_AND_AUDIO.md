# Speed and audio contract · project v6

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
the required `speed` field of strict schema 6, without an optional fallback,
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

Schema-6 layer points require ten nullable channels, including `speed`.
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

All row colour/opacity parameters are sampled at **absolute project time**, not at
the retimed source frame. A held source image can therefore receive a different
grade on the next project frame. Native LUT generation and preview redraw both
follow that rule. Dissolve grouping and layer-opacity equations apply independently
on every track. Any shared row point, even speed-only, requires the layered
export path; the static chunk plan cannot silently omit it.

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

The diamond explicitly joins/leaves Speed at the current project frame. It captures
the displayed rate; changing a control never creates implicit endpoint keys.
Immediately after it, native SVG **Previous/Next** buttons visit strictly earlier/
later points with a non-null Speed value, skipping colour/opacity-only points. They
stay visible but disabled without a neighbour, an opened project, or during any
document-preview draft; the existing reset follows Next. Navigation is editor-only, not a
rate/base change or an Undo/autosave operation.

An animated channel is read-only where it does not participate until its hollow
diamond is clicked. Unanimated Speed uses **Constant speed / Ramp up / Ramp down**
or **Custom curve** clip controls. Reset to 1× affects only the active row Speed
participant when keyed, otherwise the selected clip's base. All stored point times,
easing and participant values remain editable in **Layer keyframes → Edit points**,
even beyond current duration.

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
last frame. Labels distinguish stored time from actual preview. Rate controls and
diamond capture still use the **real playhead**, not the inspected off-duration
time. Storing/moving a point beyond duration does not extend the sequence merely
for that point; only actual clip retiming changes duration. Details:
[LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

### Precise clip-curve editor

With an excerpt selected and no overriding row Speed keys, choose **Speed →
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

**Source frame / Speed × / To next point** provide exact editing. Numeric fields
retain full entered decimal precision and commit on Enter/blur; invalid collisions,
out-of-original positions and timing conflicts retain the draft with inline
errors. They do not automatically seek. Escape restores the field. Easing belongs
to the left point; the last rate holds without a next interval.

Drag a point horizontally to change its integer source frame and vertically to
change its speed, quantised to **0.001×** for pointer movement only. Capture-relative
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

Standalone music import requires exactly one audio stream and no video footage.
Embedded cover artwork explicitly marked as an attached picture is accepted and
ignored during audio-only playback preparation; video soundtracks remain rejected.
Original files are referenced in place and are never stripped or rewritten.

One registered audio file, with explicit source IN/OUT, timeline start/duration,
gain dB, fade durations and loop flag. A non-looping duration cannot exceed the
selected source range; a looping track repeats **only that selected range**.

Linear amplitude envelope: `10^(gainDb/20)` multiplied by `offset/fadeIn` within
the opening fade and `(duration-offset)/fadeOut` within the closing fade. Outside
the track's timeline range the signal is silence. No hidden loudness correction.
Source-video audio stays disabled.

The preview uses a media-element Web Audio integration, not a whole-file decoded
buffer. Music and video pause/re-anchor together for buffering and timing edits.
Source wraps use a seek to the selected IN and may briefly buffer; gapless browser
loop joins are not promised. Audio clock drift above one project frame triggers
re-alignment rather than accumulating silently. Target-browser long-run A/V/audio
behaviour still requires validation.
Native export uses the same placement/loop/gain/fade rules and produces AAC at
48 kHz. The output audio is padded/trimmed to the complete video duration.

## Versioning

Project schema **v6** requires explicit `media.videoIds` and `media.audioIds` arrays,
unique and limited to 10,000 IDs each, plus complete clip colour/opacity/constant/ramp/custom-curve
speed, layer point arrays with all ten nullable value fields, placement and music
source OUT. Every layer also requires `ripple`, `transitions`, `openingFade` and
`closingFade`; transitions/fades are track-local, with no special first-track
identity. Layers display and composite in their saved bottom-to-top array order.
New projects have empty video/music bins. Standalone audio imports belong
to the open project's bin; selected music references also count as membership.
Global registered music/proxies are reusable on deliberate import, never automatically
inherited by a new project. Earlier v1–v5 projects and export receipt snapshots remain unchanged
and incompatible. There is no migration, compatibility fallback or default-field
injection; create a new project and import its media to reuse registered assets/verified
ready proxies. Confirmed project deletion affects only its saved document, not originals,
the shared content-deduplicated registry/cache or finished exports/receipts.
Registry/proxy formats and music processing are unchanged.

Stored-point inspection remains editor-only, never a persisted field or migration.
Synthetic correctness checks do not qualify intended-GPU preview,
long-flight throughput or long-run audio behaviour. Those acceptance requirements
are tracked in [#6](https://github.com/Plonk42/PasCap/issues/6),
[#7](https://github.com/Plonk42/PasCap/issues/7) and
[#8](https://github.com/Plonk42/PasCap/issues/8); real preparation/rendering needs
explicit owner consent. Consult
[GitHub Actions](https://github.com/Plonk42/PasCap/actions) for actual-commit CI,
not a cumulative historical test total.

