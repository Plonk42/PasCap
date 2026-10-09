# Multiple music tracks · strict project schema 12

Current contract for [#35](https://github.com/Plonk42/PasCap/issues/35). This specifies
the required behaviour, not completed implementation, test evidence or release
acceptance. Unit, native and browser validation of this contract is pending.
Usage belongs in [the user guide](../USER_GUIDE.md) and
[speed and audio](../SPEED_AND_AUDIO.md); resource/storage limits also belong in
[tracks and keyframes](../LAYERS_AND_KEYFRAMES.md#inspector-and-resource-limits) and
[UX hardening](../UX_HARDENING.md#issue-3-export-storage-and-recovery).

## Strict document and track identity

- `schemaVersion` is exactly **12**. Required `music: MusicTrack[]` contains **0–8**
  independent music tracks; `[]` means no music. Omitted fields, `null`, a single
  object, unknown fields and duplicate track IDs are invalid. There are no
  migrations, compatibility readers, null fallbacks or injected defaults.
- Each music track requires `id`, `mediaId`, `sourceIn`, `sourceOut`, `start`,
  `duration`, `gainDb`, `fadeIn`, `fadeOut` and `loop`. Its unique `id` identifies
  the placement, not the registered recording; several music tracks may use the same
  `mediaId` without sharing editable timing or gain.
- Source IN/OUT and placement/fades are integer frames; OUT is exclusive.
  IN/start/fades are nonnegative; OUT/duration are positive. Frames and timeline
  OUT fit **0–2,147,483,647**. Reject overflow; never shorten or clamp a music track.
  Source OUT must exceed IN and fit the registered recording. Fade IN + OUT must
  fit duration. Without looping, duration cannot exceed the selected source range.
  Looping repeats only that range. Gain is **−60 to +12 dB**.
- Required unique `media.videoIds` and `media.audioIds` remain project-bin
  membership, each limited to 10,000 IDs. Every music reference also counts as
  visible membership; importing does not place music implicitly.
- Video contracts do not change: 1–8 uniform tracks, required Ripple/transitions/
  opening/closing fades and sole video track `opacity` in 0–1. All eleven nullable keyframe
  channels are `opacity`, `speed` and nine scalar colour fields, including
  `temperature` and `tint`. Complete static/keyed Colour remains video track-owned;
  HSL/curves remain static. There is no clip colour/correction, clip opacity or
  second opacity channel. Clip constant/ramp/custom source-frame speed retains
  its ownership and retiming. Schema 12 also requires clip-owned spatial
  base/per-setting source-frame keyframes;
  [spatial transforms](SPATIAL_TRANSFORMS.md) do not change music or video track Opacity.

v1–v11 projects and receipt snapshots are incompatible and preserved byte-for-byte,
along with finished exports. Recreate projects deliberately; do not rewrite,
repair or delete them automatically. Registry, video-proxy and current
`pcm16-48k-stereo-mono-unity-v3` PCM cache formats and source guards are unchanged.

## Duration, black tails and video fades

For placed video clips $c$ and music tracks $m$, the exclusive project OUT is

$$
D = \max\left(\{0\} \cup \{c.\mathrm{end}\} \cup
\{m.\mathrm{start}+m.\mathrm{duration}\}\right).
$$

Use authoritative retimed clip ends, including hidden video tracks, and every
music track's OUT. Music **can extend project duration**. Stored track keyframes
alone do not extend it. Seek/playback/export use this same duration; independent
music placement never follows video Ripple or video speed.

Each video track's closing fade stays inside its last clip and ends at that
clip's timeline OUT. It does not move to project OUT, stretch, or hold the last
image. Where no active video clip remains on an enabled track, composition is **opaque black** while
music continues; each music fade still ends at its own track OUT. Music-only
preview is naturally black and uses the same output clock. Export requires at
least one retained video clip; this is not an audio-only export feature.

A music tail beyond video OUT requires the **composited exporter**, which fills
trailing black frames through project OUT. The static fast path still requires
one enabled, opaque, unanimated, zero-origin contiguous video track with exactly
neutral spatial bases and no spatial keyframes, covering
the entire project duration. No frozen-last-image or shortened-audio shortcut is
permitted.

## Selected music track editing

**Audio → Music** uses a native **Music track** selector with its trash action
**Delete selected music track**, a **Recording** selector that only changes the
selected music track, and **Add music track**, the single creation path listing ready
files (dragging a ready file from Media → Music onto the music lane is equivalent).
Add creates a fresh independent ID from the
chosen ready recording, including another music track using the same recording, up to
the eight-track limit. Imports only populate the bin and prepare media;
placement is deliberate and separate. Project-level removal lives in Media.

Selection is editor-only, with no save or Undo entry. Selecting, editing or
removing a music track never edits the other music tracks, video clips, track keyframes or
bin membership. Changing Recording targets only the selected music track. Removal
leaves the original/cache and other placements intact; Undo restores the removed
music track. Timeline waveform selection, placement and edge trims target its ID.

Each music track retains independent field drafts. Tab/section hiding preserves
them; selection must not submit an old draft into a different music track. Numeric
Enter/blur commits once, Escape restores, and invalid drafts stay editable.
Gain uses a native slider plus an exact field: pointer movement is local, release
commits once; each keyboard adjustment is one edit. Timing gestures keep their
transient preview and captured geometry. Every accepted edit/add/remove or
completed gesture is **one Undo step**; unchanged, invalid or cancelled operations
change neither committed document nor history/autosave. Escape, pointer
cancellation, capture loss and window blur restore a gesture atomically.

## Mixing and sample placement

Use PCM16 **48 kHz stereo** sources; mono is duplicated without attenuation.
Convert each source IN/OUT, start, duration and fade boundary independently to
integer samples at the rational project frame rate. For music track $i$, local
elapsed samples $u$, duration $d_i$ and fade lengths $f_i^{\mathrm{in/out}}$, its
amplitude envelope is

$$
a_i(u)=10^{g_i/20}
\begin{cases}u/f_i^{\mathrm{in}},&0\le u<f_i^{\mathrm{in}}\\1,&\text{otherwise}\end{cases}
\begin{cases}(d_i-u)/f_i^{\mathrm{out}},&d_i-f_i^{\mathrm{out}}\le u<d_i\\1,&\text{otherwise}.\end{cases}
$$

A zero fade is absent, not division by zero. Outside a music track's placement it
contributes silence. Within placement, sample its selected source range, wrapping
only when Loop is enabled. Let $s_i$ be start samples and $x_{i,k}(u)$ the sampled
selected-range channel, zero outside $0\le u<d_i$. For each stereo channel $k$ and
project sample $n$,

$$
y_k(n)=\operatorname{clamp}_{[-1,1]}
\left(\sum_i a_i(n-s_i)x_{i,k}(n-s_i)\right).
$$

Sum **all** sources linearly after their individual gain/fades, then hard-clamp
**once**, after the complete sum. No per-source or intermediate clamp,
normalisation, ducking, effects, hidden gain compensation or source-video audio.
Opposite-polarity sources may cancel even when an individual contribution exceeds
unity. Native AAC is encoded only after the final clamp; it is not bitwise PCM
equivalence.

## Preview: one bounded mixed stream and output clock

One **AudioContext**, one **AudioWorklet** and one mixed stereo stream supply a
single audio-output timestamp clock/epoch. All music tracks align to project sample
positions on that clock; there is no per-track worklet, clock or restart at
loop/placement boundaries. Video starts after the device reaches the first real
rendered mixed sample's origin. Receipts independently retain the exact
**one-project-frame A/V bound**; this change does not relax decoder readiness,
drift checks, operation deadlines or cancellation.

Read/accumulate sources **serially** into one mixed block, apply their envelopes,
clamp the completed sum, and transfer it to the worklet. The aggregate bound,
independent of music track count and duration, is:

- **4 × 128 KiB** stereo Float32 queue/transfer blocks, **512 KiB total**, not four
  blocks per track.
- Bounded **64 KiB** source-range/short-loop read scratch, shared serially.
- One shared **128 KiB** conversion workspace and one **128 KiB** mixed-output
  workspace, not per-track copies.
- One unacknowledged consumption receipt and serial credit-controlled refill, run
  by one dedicated reader worker that exchanges credits/blocks directly with the
  worklet, independent of editor-thread rendering.

There are no full-file buffers, duration-sized silence buffers or per-track
queues. Short-loop scratch may be reused only within the current mixed block;
each refill still performs fresh identity-guarded range reads. Legitimate
placement silence is not an underrun. A missing active source/read/processor
failure is explicit; never silently omit a music track or invent successful
silence. Pause, seek, edit, cancellation and disposal invalidate the entire mix
epoch, reads, queued blocks and late receipts together.

## Native export: serial floating accumulation

Capture the project, every referenced registered audio original and each
identified instance plan before queue admission. Verify source identity before/
after selected decoding and before publication. Keep one serial heavy worker.

1. Decode **one original at a time** to the exact selected **48 kHz stereo s16
   PCM** range; never store the full original or every loop repetition.
2. Stream that selected range/loop with its placement silence, gain and fades.
   Pairwise-sum it with the previous full-project stereo **Float64 accumulator**
   into the next Float64 accumulator. No normalisation or intermediate clamp;
   values outside −1–1 survive subsequent cancellation.
3. Verify exact sample counts and delete consumed selected PCM/old accumulator
   before processing the next music track. At most **two intermediate audio inputs**,
   **one native audio child per pass** and **three audio scratch files** coexist:
   selected source, old accumulator, new accumulator.
4. Feed one final mixed input to AAC, hard-clamping once after all sources.
   Silence/padding and exact output length follow **full project duration**, not
   video-only duration. Failed/cancelled work cleans only owned scratch/partials;
   originals, saved projects and successful exports/receipts remain untouched.

Audio disk planning is **maximum selected s16 PCM size + two full-project Float64
stereo timelines**, not the sum of all selected files. If $S$ is the project
sample count and $L_i$ a selected source sample count, the audio allowance is
$4\max_i L_i+2\times16S$ bytes when music exists, zero without music, excluding
container overhead. Add the existing video/encoded allowance, 25% margin and
16 MiB start reserve. This is duration-dependent advisory planning, not reserved
space, a compressed-size prediction or a fixed-GB promise.

Video bounds remain unchanged: one original video decoder, two intermediate
readers, one encoder and at most three native video children per serial pass;
two retained clip files and three timeline representations; four raw buffers at
**22 bytes/pixel (182,476,800 bytes UHD)** and two reusable **65³ Float32 LUTs
(6,591,000 bytes)**. Audio storage/workspaces are additional, not substitutions
for those video budgets.

## Receipts, preservation and acceptance

Export receipt format remains **version 1**, with a strict **schema-12 project
snapshot**. Required `musicSources` is an array of captured unique registered
audio assets; required `settings.audio` is an array of instance plans carrying
`id`/`mediaId` and independent timing/gain/fades/loop sample positions. Both are
empty arrays without music, never singular/null/default-filled values. Several
plans may refer to one captured original. The existing plan name `videoSamples`
denotes the **full project** sample count, including music tails, not video-only
OUT. Restore only the current snapshot/array contract; reject incompatible older
snapshots or invalid arrays clearly and preserve their receipts and finished MP4s.

Pending acceptance includes strict schema/receipt rejection and preservation;
independent selection/drafts/Undo and cancellation; repeated-source music tracks;
overlap/cancellation and final-only clipping; placement silence, loops and sample
counts; one output epoch and unchanged A/V bound; video closing fade followed by
black through a music tail; music-only black preview and video-required export;
frame-range overflow; immutable queued snapshots, serial native resource peaks
and duration-dependent preflight/cleanup. Browser UI acceptance additionally
requires live integrated-browser interaction and rendered desktop/compact
screenshots. No results are claimed here.

Sequential work on milestone issues is not milestone closure or release approval.
Real-media preparation/rendering, hardware/long-run qualification, releases and
milestone closure still require explicit owner approval.
