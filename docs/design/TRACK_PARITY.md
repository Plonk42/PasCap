# Role-independent video tracks · historical accepted schema-6 design

Approved owner choices for [#25](https://github.com/Plonk42/PasCap/issues/25),
related to [#17](https://github.com/Plonk42/PasCap/issues/17) and
[#24](https://github.com/Plonk42/PasCap/issues/24).
This record retains the accepted schema-6 decisions, not the current persistence
or opacity contract. [#67](https://github.com/Plonk42/PasCap/issues/67) supersedes its
two-opacity descriptions with the sole row contract retained in schema 8: required numeric `VideoLayer.opacity`
(1 on new tracks), no saved `clip.opacity`, and the sole row key channel `opacity`
overriding the row value on every source, without an additional group multiplier.
The single **Opacity** control is in **Track → Colour**; **Placement** contains
placement only. The accepted schema-6 body below remains historical. Track visibility,
Ripple, transitions/fades, grouped dissolves and resource bounds retain their
semantics. [#35's current schema-8 contract](MULTIPLE_MUSIC.md) supersedes the
historical body's video-only duration/single-music assumptions: music can extend
project OUT, with closing video fades at clip OUT then black through the music
tail. The historical body/identifiers are unchanged. Current usage belongs in
[the layer contract](../LAYERS_AND_KEYFRAMES.md), [editing guide](../TIMELINE_EDITING.md)
and [retiming contract](../SPEED_AND_AUDIO.md). Publication, verification and remaining
acceptance belong on the work issue, not here. This does not authorize migrations,
change related issues' scopes or permit real-media jobs.

## Uniform boundaries

Array order controls composition and row display, never editing privileges.
The initial generated `video-1` is an ordinary identity, not a required base.

| Boundary / source                                                                                                                                      | Contract                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| [Model](../../src/shared/model.ts), [layout](../../src/shared/timeline.ts), [commands](../../src/shared/commands.ts)                                   | Required track settings, local pair topology, continuous Ripple and atomic actual-start persistence                              |
| [Source trim](../../src/shared/source-range.ts), [marked cuts](../../src/shared/rush-editing.ts), [drop planning](../../src/web/timeline-placement.ts) | Ripple chooses sequence slots versus independent placement; source anchors and contextual maps are shared by ghost and commit    |
| [Inspector](../../src/web/Inspector.tsx), [track controls](../../src/web/Layers.tsx), [action guards](../../src/web/layer-actions.ts)                  | Every track exposes the same controls, selected-track transitions/fades and accessible setting-specific start/nudge restrictions |
| [Rows](../../src/web/timeline-rows.ts), [preview](../../src/preview/engine.ts), [pool](../../src/preview/assignment.ts)                                | Uniform array-order rows; track-local timing and two reusable slots per track                                                    |
| [Composition](../../src/shared/composition.ts), [export planning](../../src/shared/export.ts), [native groups](../../src/server/layered-export.ts)     | Independent track dissolves; premultiplied groups followed by serial source-over, without regrading                              |
| [Storage](../../src/server/storage.ts), [archive restoration](../../src/server/export-archive.ts)                                                      | Strict schema-6 projects/snapshots; old files retained unchanged and incompatible                                                |

The serial heavy-job queue, source identity checks, music envelope, source-frame
clip speed curves, ten absolute project-time row channels and per-frame ownership
remain independent of track ordering.

### Role inventory classification

The reviewed role-dependent boundaries are classified below. This inventory is
the design rationale, not a second mutable implementation checklist.

| Role-conditioned behavior                                                    | Classification and accepted boundary                                                                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| First-track sequence placement versus other-track absolute starts            | **Per-track setting:** required Ripple; shared layout and persisted actual starts use it independently                                         |
| Insertion slots, drag ghosts, reorder, duplication and deletion gap closing  | **Per-track setting:** source/destination Ripple; candidate validation and anchor retention are uniform                                        |
| IN-handle/keyboard trim, numeric start/nudge and duration/Speed suffix edits | **Per-track setting:** Ripple selects placement semantics; source anchors and atomic timing validation are uniform                             |
| Project-owned transitions and opening/closing fades                          | **Uniform capability:** required track-local topology/fades, including empty-track dormant settings and explicit positioned dissolve placement |
| Irremovable initial identity and special stack limits                        | **Composition constraint only:** last-track deletion and actual top/bottom endpoints; no identity privilege                                    |
| Primary-first/reversed-other row display and row hit tests                   | **Composition constraint only:** saved bottom-to-top array order drives headers, lanes, reveal, markers and drop targeting                     |
| Primary dissolve plus one-source other-track decoder allocation              | **Uniform capability:** two reusable slots per track; timing invalidation includes each populated track's settings/order                       |
| Primary export plan/group versus single-source overlay passes                | **Uniform capability:** independently planned track groups and serial premultiplied source-over; static eligibility uses content, not identity |
| Global base duration, project fade summaries and schema-5 admission          | **Uniform contract:** maximum clip OUT, per-track summaries/settings and strict schema-6 project/receipt admission                             |

## Accepted settings and capabilities

| Setting / capability                 | New-track default / bound                                                                                         | Location and effect                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Ripple                               | Required boolean; **on**, including the initial track                                                             | Native Layer options checkbox and track-header Ripple toggle; enable packs immediately, then continuously sequences         |
| Opening/closing fade                 | Required integer output-frame lengths; **0/0**                                                                    | Selected track in Track → Fades, at actual first/last placements; dormant on empty tracks                                   |
| Boundary transition                  | Required track-owned adjacent-pair records; Cut 0, Fade-through-black at least 2, Cross-dissolve at least 1 frame | Boundary button on its own row and the existing transition editor; no role-based enable flag                                |
| Enabled / layer opacity / row points | Existing strict values; enabled, opacity 1, empty points                                                          | Existing controls on every track; unchanged curve ownership and group composition                                           |
| Absolute clip start / nudge          | Required integer start on every clip                                                                              | Positioned clips or first Ripple anchor only; later Ripple clips explain how to reorder or turn Ripple off                  |
| Add/remove/raise/lower               | One to eight tracks; no irremovable identity                                                                      | Every track exposes the same actions; only the last remaining track and actual composition-stack endpoints restrict actions |
| Same-track overlap                   | No independent overlap toggle                                                                                     | Only an exact, explicitly stored adjacent Cross-dissolve overlap is valid; arbitrary/triple overlap remains invalid         |

Ripple is a **continuous layout policy**, not a future-edits-only suffix delta.
Enabling sorts existing placements chronologically, closes gaps in one Undo and
retains the first current start plus valid existing dissolves. While on, saved clip
order sequences from that anchor, each next start equal to previous OUT minus its
incoming dissolve duration. Commands persist actual integer starts; switching off
captures those placements rather than restoring old gaps. Structural edits preserve
the pre-edit first anchor even if its first instance changes. Only explicitly
moving the retained first clip while it remains first changes that anchor.

Display is **bottom-to-top in the saved array order**: row 1 renders below row 2,
then row 3 above row 2. Raise/Lower refer to composition, not screen direction.
Reordering tracks changes composition only, never Ripple, timing or row points.

## Ripple behavior matrix

Affected tracks are the edited track, or source and destination for an explicit
cross-track move. Music, all absolute row points and other tracks never ripple.
The complete candidate uses authoritative contextual row-Speed maps before commit.

| Operation                                   | Ripple off                                                                                | Ripple on                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Insert / batch insert / duplicate           | Explicit placement; no unrelated clip moves; conflicts reject the whole operation         | Insert at a sequence slot, duplicate after the original or append normal Add; continuously re-sequence from the first anchor |
| Delete                                      | Leave a gap; unaffected starts remain exact                                               | Close the gap, preserving the pre-edit first anchor even when the first clip is removed                                      |
| OUT trim / numeric source edit / clip speed | Selected clip changes duration at its start; no suffix movement                           | Keep the selected sequence start and recompile the suffix continuously                                                       |
| Timeline IN handle / keyboard trim          | Retain old timeline OUT with the integer-placement solver; reject unrepresentable results | Retain sequence start and recompile the suffix                                                                               |
| Split                                       | Right piece follows independently compiled left; no unrelated clip moves                  | Re-sequence retained pieces/suffix at the original anchor                                                                    |
| Marked cut                                  | Retained pieces use pre-edit mapped positions, including the removed gap                  | Rejoin retained pieces and re-sequence this track only                                                                       |
| Nudge / numeric start                       | Move only selected clip; validate neighbors and transitions                               | Only first anchor can move; later starts are disabled with a reason to reorder or switch Ripple off                          |
| Move / reorder                              | Explicit target placement; unaffected starts remain fixed                                 | Atomic remove/insert using each affected track's independent toggle; never apply a source track's policy to its destination  |
| Row Speed point/rate/easing edit            | Recompile durations at unchanged starts; reject invalid topology                          | Recompile continuously in saved clip order from first anchor, retaining exact dissolve overlaps                              |
| Change Ripple                               | Capture actual starts when switching off                                                  | Enabling packs current chronological order, closing gaps from first current start in one Undo                                |
| Reorder tracks                              | Composition only                                                                          | Composition only                                                                                                             |

Project-time Speed means a new start can change duration too; a simple suffix delta
is insufficient. Recompile each later clip at its actual new start, never shift
row points. Trimming/splitting/cutting retain source-frame speed anchors and
independent per-piece duration rounding, so total duration need not be preserved.
Existing valid non-cut transitions survive only while their exact pair survives;
new adjacent pairs get an explicit Cut. Do not replace a surviving transition with
Cut, shorten fades or clamp a duration just to obtain a valid result.

Concrete constant-speed examples, with all intervals OUT-exclusive:

- Two 30-frame clips at 0 and 40: shorten the first to 20. Ripple off keeps the
  second at 40. Enabling Ripple first places it at 30; shortening then places it
  at 20, not 30: no internal gap is retained while Ripple is on.
- Delete the middle of three 30-frame clips at 0, 30 and 60. Off keeps the final
  clip at 60; on moves it to 30. Undo restores the exact original three placements.
- Turn Ripple on for 30-frame clips at 10 and 60. They become 10 and 40 immediately,
  in one Undo. Turning it off keeps 10 and 40; the first anchor never moves to zero.

## Transitions, gaps and fades

Ripple uses saved clip order; off uses chronological starts. Reject arbitrary or
triple overlap. Equal starts are permitted only for an explicit full-overlap
dissolve pair, whose stored pair order is authoritative. Each track's transition list matches its ordered adjacent
clip pairs, including explicit Cut records across gaps. It cannot reference another
track. The compositor uses track identity only for grouping, not editing policy.

- **Cut:** no consumed interval. A gap is allowed and reveals lower tracks/black.
- **Fade-through-black:** only a touching pair, with its existing outgoing/incoming
  half-duration split. It darkens this track's RGB, not its coverage or another
  track. It does not create overlap or close a gap.
- **Cross-dissolve:** only a touching pair or that pair's existing dissolve can be
  edited. Duration D explicitly places the right clip at `left.OUT - D` and stores
  that exact overlap. Changing/removing D is a placement-changing transition edit,
  not an unrelated clip edit. Ripple on recompiles the paired right clip and
  its suffix; off preserves other clips and rejects conflicts.
- A gapped Cut cannot be turned into a non-cut effect by silently moving footage.
  Explain that the user must first make the pair touch with an explicit move.
- Incoming/outgoing regions plus track opening/closing fades must fit each clip;
  reject collisions and invalid retiming atomically. Independent dissolves on
  several tracks may occur at the same project frame.
- Opening/closing fades use the existing **fade-to-black** math on every track:
  preserve alpha coverage, do not fade the entire composite. Revealing footage
  below is already possible with layer/clip opacity animation; no new transparency
  fade effect is added. Empty tracks retain dormant fade settings rather than
  silently clearing them; adding footage validates those settings again.

Global duration is the maximum clip OUT across all tracks, including disabled
tracks. No distinguished base duration controls it. Music stays at its
absolute placement and export padding/trimming still follows full video duration.

## Strict persistence

Use **strict project schema 6**.
Every layer requires `ripple`, `transitions`, `openingFade` and `closingFade`, plus
its existing strict fields. Project-level transition/fade fields are absent.
Keep required clip `start`: the first Ripple start anchors derived sequence
placements, commands persist all actual starts, and off-mode starts are independent.
Validate unique identities, known references, ordered track-local transition
topology, integer bounds and contextual timing. Runtime insertion supplies its
target layer explicitly; `video-1` is a conventional factory identity only.

Missing/unknown fields, old schema versions and invalid topology are errors. There
are no optional legacy fields, index-based defaults or automatic migrations.
Existing v1–v5 projects and immutable receipt snapshots remain unchanged/incompatible;
finished videos remain untouched. New projects have the same defaults on every
track and empty explicit bins. Registry/proxy/source identity and audio formats do not
change. Export receipts remain version 1 with a strict v6 snapshot admission gate;
old receipts are not rewritten or restored as current-schema jobs.

## Accepted preview and native resources

- Preview can require two sources per enabled track: at most **16 pooled decoders
  for eight tracks**, plus the separate visible source reviewer. Slots are reused
  with observed-frame checks and disposed when the pool shrinks, never allocated
  per stored clip.
- Native export renders each track's premultiplied group with
  at most two RGB readers, then source-overs that RGBA16 group onto the lower
  accumulator using at most two RGBA16 readers. Keep one original decoder, two
  intermediate readers, one encoder, three children per pass and two retained
  original clip intermediates. All tracks use the same passes.
- At most **three timeline representations** coexist during group/lower/output
  composition or group joining; a span collection counts as one. Two RGB8 and two
  RGBA16 reusable buffers total **22 bytes/pixel = 182,476,800 bytes at UHD**, plus
  two 65³ Float32 LUTs totaling **6,591,000 bytes**, plus native/audio memory.
  Space planning budgets up to
  two clip files at 4 bytes/pixel and three timelines at 8 bytes/pixel, not compressed
  upper bounds. Inputs are deleted after each serial pass.
- The static fast path requires one enabled opaque track, opaque clips, no row
  points, zero origin and no internal gaps. Track fades/dissolves and clip retiming
  remain supported. Other valid timelines use generalized layered export, never
  silently omit unsupported regions. Eligibility depends on content, not Ripple/ID.
- The diagnostic reference remains deliberately narrower: two 1× clips on one
  enabled opaque zero-origin contiguous track, no music or row points, and at most
  3,600 frames. Source identity guards and registry/proxy formats are unchanged.

## Applicable verification

These are required coverage areas, **not new test results or acceptance evidence**.
Synthetic verification must cover every matrix operation with independently toggled
tracks, pack-on-enable/placement capture, first-anchor-only start/nudge, simultaneous dissolves, Speed
recompilation, fade/coverage and hidden tails, arbitrary track removal/reordering,
one-step Undo/Redo, strict save/reopen/old-data rejection and failed atomic edits.
Native checks retain exact source/frame/packet/pixel and resource assertions,
source-identity protection, cancellation/reaping and owned-scratch cleanup. Browser
checks exercise actual pointer/keyboard controls, cancelled/invalid drafts, focus,
compact widths, scrolling, row/boundary hit tests and unchanged autosave on previews.
Run type/unit/build before the isolated browser suite; do not rebuild its served
output or reset fixtures during that suite.

The accepted choices are default-on continuous Ripple with pack-on-enable,
bottom-to-top rows, coverage-preserving black fades, explicit paired dissolve
placement and the stated resource bounds. Documentation review alone does not
prove runtime acceptance, remote delivery or intended-GPU/real-flight qualification.
Work selection/progress/evidence stay on the issue and its Project item.
