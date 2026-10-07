# Multiple music instances · strict project schema 10

Current contract for [#35](https://github.com/Plonk42/PasCap/issues/35). This specifies
the required behaviour, not completed implementation, test evidence or release
acceptance. Unit, native and browser validation of this contract is pending.
Usage belongs in [the user guide](../USER_GUIDE.md) and
[speed and audio](../SPEED_AND_AUDIO.md); resource/storage limits also belong in
[layers and keyframes](../LAYERS_AND_KEYFRAMES.md#inspector-and-resource-limits) and
[UX hardening](../UX_HARDENING.md#issue-3-export-storage-and-recovery).

## Strict document and instance identity

- `schemaVersion` is exactly **10**. Required `music: MusicTrack[]` contains **0–8**
  independent instances; `[]` means no music. Omitted fields, `null`, a single
  object, unknown fields and duplicate instance IDs are invalid. There are no
  migrations, compatibility readers, null fallbacks or injected defaults.
- Each instance requires `id`, `mediaId`, `sourceIn`, `sourceOut`, `start`,
  `duration`, `gainDb`, `fadeIn`, `fadeOut` and `loop`. Its unique `id` identifies
  the placement, not the registered recording; several instances may use the same
  `mediaId` without sharing editable timing or gain.
- Source IN/OUT and placement/fades are integer frames; OUT is exclusive.
  IN/start/fades are nonnegative; OUT/duration are positive. Frames and timeline
  OUT fit **0–2,147,483,647**. Reject overflow; never shorten or clamp an instance.
  Source OUT must exceed IN and fit the registered recording. Fade IN + OUT must
  fit duration. Without looping, duration cannot exceed the selected source range.
  Looping repeats only that range. Gain is **−60 to +12 dB**.
- Required unique `media.videoIds` and `media.audioIds` remain project-bin
  membership, each limited to 10,000 IDs. Every music reference also counts as
  visible membership; importing does not place music implicitly.
- Video contracts do not change: 1–8 uniform tracks, required Ripple/transitions/
  opening/closing fades and sole row `opacity` in 0–1. All nine nullable point
  channels remain `opacity`, `speed` and the seven colour settings. There is no
  clip opacity or second opacity channel. Clip colour and constant/ramp/custom
  source-frame speed retain their current ownership and retiming.
  Schema 9 also requires clip-owned spatial base/full-pose source-frame keys;
  [spatial transforms](SPATIAL_TRANSFORMS.md) do not change music or row Opacity.

v1–v9 projects and receipt snapshots are incompatible and preserved byte-for-byte,
along with finished exports. Recreate projects deliberately; do not rewrite,
repair or delete them automatically. Registry, video-proxy and current
`pcm16-48k-stereo-mono-unity-v3` PCM cache formats and source guards are unchanged.

## Duration, black tails and video fades

For placed video clips $c$ and music instances $m$, the exclusive project OUT is

$$
D = \max\left(\{0\} \cup \{c.\mathrm{end}\} \cup
\{m.\mathrm{start}+m.\mathrm{duration}\}\right).
$$

Use authoritative retimed clip ends, including hidden video layers, and every
music instance's OUT. Music **can extend project duration**. Stored row points
alone do not extend it. Seek/playback/export use this same duration; independent
music placement never follows video Ripple or video speed.

Each video track's closing fade stays inside its last clip and ends at that
clip's timeline OUT. It does not move to project OUT, stretch, or hold the last
image. Where no enabled video remains, composition is **opaque black** while
music continues; each music fade still ends at its own instance OUT. Music-only
preview is naturally black and uses the same output clock. Export requires at
least one retained video clip; this is not an audio-only export feature.

A music tail beyond video OUT requires the **layered exporter**, which fills
trailing black frames through project OUT. The static fast path still requires
one enabled, opaque, unanimated, zero-origin contiguous video track with exactly
neutral spatial bases and no spatial keys, covering
the entire project duration. No frozen-last-image or shortened-audio shortcut is
permitted.

## Selected-instance editing

**Audio → Music** uses a native **Music track** selector, **Recording** selector,
**Add music track** action and trash action **Delete selected music track**.
Recordings must be ready/prepared. Add creates a fresh independent ID from the
chosen ready recording, including another instance of the same recording, up to
the eight-instance limit. Imports only populate the bin and prepare media;
placement is deliberate and separate.

Selection is editor-only, with no save or Undo entry. Selecting, editing or
removing an instance never edits the other instances, video clips, row points or
bin membership. Changing Recording targets only the selected instance. Removal
leaves the original/cache and other placements intact; Undo restores the removed
instance. Timeline waveform selection, placement and edge trims target its ID.

Each instance retains independent field drafts. Tab/section hiding preserves
them; selection must not submit an old draft into a different instance. Numeric
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
integer samples at the rational project frame rate. For instance $i$, local
elapsed samples $u$, duration $d_i$ and fade lengths $f_i^{\mathrm{in/out}}$, its
amplitude envelope is

$$
a_i(u)=10^{g_i/20}
\begin{cases}u/f_i^{\mathrm{in}},&0\le u<f_i^{\mathrm{in}}\\1,&\text{otherwise}\end{cases}
\begin{cases}(d_i-u)/f_i^{\mathrm{out}},&d_i-f_i^{\mathrm{out}}\le u<d_i\\1,&\text{otherwise}.\end{cases}
$$

A zero fade is absent, not division by zero. Outside an instance's placement it
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
single audio-output timestamp clock/epoch. All instances align to project sample
positions on that clock; there is no per-instance worklet, clock or restart at
loop/placement boundaries. Video starts after the device reaches the first real
rendered mixed sample's origin. Receipts independently retain the exact
**one-project-frame A/V bound**; this change does not relax decoder readiness,
drift checks, operation deadlines or cancellation.

Read/accumulate sources **serially** into one mixed block, apply their envelopes,
clamp the completed sum, and transfer it to the worklet. The aggregate bound,
independent of instance count and duration, is:

- **4 × 128 KiB** stereo Float32 queue/transfer blocks, **512 KiB total**, not four
  blocks per instance.
- Bounded **64 KiB** source-range/short-loop read scratch, shared serially.
- One shared **128 KiB** conversion workspace and one **128 KiB** mixed-output
  workspace, not per-instance copies.
- One unacknowledged consumption receipt and serial credit-controlled refill.

There are no full-file buffers, duration-sized silence buffers or per-instance
queues. Short-loop scratch may be reused only within the current mixed block;
each refill still performs fresh identity-guarded range reads. Legitimate
placement silence is not an underrun. A missing active source/read/processor
failure is explicit; never silently omit an instance or invent successful
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
   before processing the next instance. At most **two intermediate audio inputs**,
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

Export receipt format remains **version 1**, with a strict **schema-10 project
snapshot**. Required `musicSources` is an array of captured unique registered
audio assets; required `settings.audio` is an array of instance plans carrying
`id`/`mediaId` and independent timing/gain/fades/loop sample positions. Both are
empty arrays without music, never singular/null/default-filled values. Several
plans may refer to one captured original. The existing plan name `videoSamples`
denotes the **full project** sample count, including music tails, not video-only
OUT. Restore only the current snapshot/array contract; reject incompatible older
snapshots or invalid arrays clearly and preserve their receipts and finished MP4s.

Pending acceptance includes strict schema/receipt rejection and preservation;
independent selection/drafts/Undo and cancellation; repeated-source instances;
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
