/** The assistant's playbook, served as the `pascap://guide` resource and the `rough_cut` prompt. */
export const ASSISTANT_GUIDE = `# Building a rough cut in PasCap

PasCap edits drone-flight videos. Frames are integers at 30000/1001 fps (about 29.97 per second);
timecodes are MM:SS:FF with 30 nominal frames per second. PasCap measures and computes; you judge
what the footage shows from its pictures.

## 1. Read
- list_projects, then describe_project: video tracks and clips, transitions, music tracks, the
  recordings of the bin with the ranges the user kept, and bookmarks. Later, include only the
  parts a step needs (videoTracks after an edit, with layerId for one track).
- session_status: an active session started by the user's Hand off carries their brief (notes,
  music track, target length, allowed movement, most clips). Follow it.
- music_analysis: tempo, key, sections (quiet, build, peak, release) with their loudness and tone,
  swells, silences, beats and downbeats, and hits (kicks, snares, crashes that stand out, with their
  band and whether they are strong) at project frames. The target length is the music clip's
  length unless the brief says otherwise. Start with detail summary (structure and strong hits,
  without every beat), then read the full beats of a frame window when you cut on them.

## 2. Take the project
- session_start with the revision you read and the user's brief, unless a session is already
  active (the user's Hand off starts one for you: session_start then says so and gives the
  brief, and you edit within it). While it lasts the user watches and cannot edit; every edit
  you save is a revision, and they can restore the project as it was before the session.
- Every read reports the revision it used: run reads after the edit they depend on has
  returned, and read again when a result's revision is older than your last edit.

## Pictures
Every picture stays in the conversation, and many clients limit how many one conversation may
hold (VS Code with Claude: 20, the user's included); past that it cannot continue. Know your
client's limit and spend pictures where they decide something: a compare_recordings sheet of
many candidates rather than one sheet per shot, one timeline_sheet of the cut, a still or two
for the grade. If your client can start subagents with their own conversations, give each group
of similar recordings to one that looks and returns the chosen ranges with reasons.

## 3. Choose footage
- describe_recording for each recording, without its sheet: its steady ranges inside the kept
  ranges, with the camera move (pan, tilt, push in…), what it shows (orbit, reveal, approach…),
  its rank, picture speed and flight data.
- compare_recordings puts candidates from several recordings in one sheet: their best steady
  ranges, or ranges you name, up to 16 cells. Flights hold several similar takes of one subject;
  compare them and keep only the best. Judge composition, light and subject from the pictures.
  frames 3 or 4 shows how a few finalists' movements start, develop and end.
- Prefer whole camera movements to fragments; skip damaged and hovering stretches. Use
  recording_sheet only for frames no other sheet shows.
- Clips must stay inside the kept ranges; edits that leave them are refused.

## 4. Structure
- Order the shots to tell the flight: chronologically or by place, a wide establishing shot at
  the start and at section starts, the most dramatic movement on the peak, calm shots in quiet
  sections.
- Plan clip lengths from the sections and the beat grid: longer clips on slow or quiet music,
  shorter ones and cuts on downbeats at peaks. Two to eight beats per clip is a usual range.
  Music without a steady beat still has hits: cut on its strong hits instead.
- Read the music's character too: a minor key, little high-frequency content and soft sections
  suit slow, calm movements; bright, loud sections suit faster, dramatic ones. Let a crescendo
  build with the movement (a rise, a push in), cut or reveal on a sudden swell, and place
  transitions through black, or the end of the cut, in silences.

## 5. Build
- One Ripple video track, filled with one edit batch of insert commands in timeline order.
  Use preview_edits to check a batch before saving it.
- snap_cuts_to_beats (first without apply, then with apply) moves each cut onto the beat, or with
  prefer hit or beat-or-hit onto a strong hit; check_alignment reports how the cut follows the music.
  Cuts you placed deliberately go in keep (or keepOnHit for those already on a hit), and maxShift
  stops a cut from traveling far to reach a beat.
- Transitions: cuts on beats; short cross-dissolves (8–15 frames) between related shots; fade
  through black between sections; opening and closing fades on the track to match the music.
  After snapping, add dissolves with keepCut so the change stays on the beat and later cuts
  do not move.
- Use a second track only for an overlay; a clip that needs its own grade gets a clip grade.

## 6. Grade
- Each clip has its own grade (a clipId on the color commands), applied first and kept with
  the clip when it moves. An adjustment grades every track over a stretch of the film, after the
  clip grades, for a shared look, such as one per music section: adjustment-add with its
  settings, then an adjustmentId on the color commands; adjustment-range moves or trims it,
  adjustment-split cuts it in two. Adjustments never overlap and stay at their project frames
  when clips move. describe_project lists them with what they change; describe_track gives what
  each clip's grade changes and the adjustments over it. Read them before changing a grade:
  settings interact (Contrast with Shadows, Highlights, Whites and Blacks shape one tone curve).
  Prefer static grades; animate only when the brief asks or the light changes within a shot
  (clip keyframes are source frames, adjustment keyframes count from its start). describe_track
  with include keyframes lists them; with at and the settings you changed it reads far less.
- Start from estimate: auto-adjust on a representative clip gives the editor's Auto correction
  and the edit applying it to its clip grade; white-balance only Temperature and Tint; detail
  suggests a clip's Denoise and Sharpen (clipIds or layerId: every clip in one call). For a
  correction per shot, estimate with applyAs shots (layerId or clipIds) writes each clip's own
  correction into its clip grade in one call; dissolves blend the two grades. Keep adjustments
  for the look shared by every shot of a stretch.
- Change one setting with color-setting, hsl-band, color-curve or transform-setting, which
  keep every other value; a keyed setting follows its keyframes, so change those instead
  (layer-key-value). The color and transform commands replace everything and suit a full grade.
  detail-clips sets the same Detail on several clips in one command.
- To animate, layer-key-set keys several settings at one frame in one command, with one Easing
  (hold keeps a grade until the next keyframe) or one per setting; settings left out keep what
  they have there, and null disables one.
- Compare with still or timeline_sheet: both accept commands to preview a change without saving.
  still with compare shows the candidate beside the saved frame (saved) or the ungraded one
  (original) in one picture: judge a grade there, not in small sheet cells. Judge Detail on a
  1:1 crop: no halos, no waxy smoothing.

## 7. Finish
- Verify with a timeline_sheet across the cut, check_alignment and the duration against the
  target.
- session_end with notes for the user: the structure, the choices you made and anything they
  should look at.
`;
