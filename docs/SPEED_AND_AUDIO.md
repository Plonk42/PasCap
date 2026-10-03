# Speed and audio contract · project v5

## Two distinct retiming contracts

Speed is positive, **0.1×–8×**. Clips store independent static **constant or ramp**
bases; shared row points can override Speed across every clip in their layer.
There is no source-speed-key mode. Do not confuse the row's project-time integral
with the static ramp's original-source integral.

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

### Shared row Speed: absolute project-time rate

Schema-5 layer points retain ten required nullable channels, including `speed`.
Once any point on the row participates in Speed, the row's rate curve **overrides
every clip's entire constant/ramp base**, not just an interval between keys. Only
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
follow that rule. Dissolve grouping, layer-opacity equations and render-resource
bounds are unchanged. Any shared row point, even speed-only, requires the layered
export path; the static chunk plan cannot silently omit it.

With row Speed keys, moving the same excerpt changes its contextual duration.
Primary layout ripples and recompiles downstream clips at their newly derived
starts; overlay starts stay absolute and neighbours are not moved. Transition/fade
durations remain **output** frames. Invalid fade/transition regions or same-row
overlay overlap reject the entire edit, including a rate/point-time/easing change.
This includes direct marker dragging and marker keyboard moves: a timing conflict
rejects the **whole shared point**, never just its Speed participant, and never
shortens transitions to make the destination fit.

Moving ghosts and commits use the same contextual duration calculation. A
trailing-edge magnet solves the new start/end against the row curve rather than
using the old width. Left overlay trims similarly retain their timeline OUT; an
unrepresentable integer-frame result is explicitly rejected. Numeric source fields
retain the start. Trim/move/split/duplicate never copy or shift row points; each
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
base controls, with no Keyframes mode. Reset to 1× affects only the active Speed
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
Speed can naturally recompile clip durations and primary derived starts.

Setting/row/list navigation shares a stored-point inspection cursor, so several
off-duration Speed points remain reachable even when preview clamps to the same
last frame. Labels distinguish stored time from actual preview. Rate controls and
diamond capture still use the **real playhead**, not the inspected off-duration
time. Storing/moving a point beyond duration does not extend the sequence merely
for that point; only actual clip retiming changes duration. Details:
[LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

## Music

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

Project schema **v5** requires explicit `media.videoIds` and `media.audioIds` arrays,
unique and limited to 10,000 IDs each, plus complete static clip colour/opacity/constant-or-ramp
speed, layer point arrays with all ten nullable value fields, placement and music
source OUT. New projects have empty video/music bins. Standalone audio imports belong
to the open project's bin; selected music references also count as membership.
Global registered music/proxies are reusable on deliberate import, never automatically
inherited by a new project. Earlier v1/v2/v3/v4 projects and export receipt snapshots remain unchanged
and incompatible. There is no migration, compatibility fallback or default-field
injection; create a new project and import its media to reuse registered assets/verified
ready proxies. Confirmed project deletion affects only its saved document, not originals,
the shared content-deduplicated registry/cache or finished exports/receipts.

Marker movement/channel navigation adds no schema, migration, toolchain or native
pipeline change. The completed no-copy schema-5 886-test milestone, schema-4
browser/native checks and earlier measurements are preserved as historical evidence
in [DELIVERY_STATUS.md](DELIVERY_STATUS.md). The current full-suite baseline is
781 unit/service, 151 browser and 50 native/media tests (982 total). Intended-GPU,
long-flight and long-run audio validation remain deferred and are tracked in
[ROADMAP.md](ROADMAP.md). No additional real preparation/render was performed for
this documentation/publication update.

