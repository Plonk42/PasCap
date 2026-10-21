/** The assistant's playbook, served as the `pascap://guide` resource and the `rough_cut` prompt. */
export const ASSISTANT_GUIDE = `# Building a rough cut in PasCap

PasCap edits drone-flight videos. Frames are integers at 30000/1001 fps (about 29.97 per second);
timecodes are MM:SS:FF with 30 nominal frames per second. PasCap measures and computes; you judge
what the footage shows from its pictures.

## 1. Read
- list_projects, then describe_project: video tracks and clips, transitions, music tracks, the
  recordings of the bin with the ranges the user kept, and bookmarks.
- session_status: an active session started by the user's Hand off carries their brief (notes,
  music track, target length, allowed movement, most clips). Follow it.
- music_analysis: tempo, sections (quiet, build, peak, release), beats and downbeats at project
  frames. The target length is the music clip's length unless the brief says otherwise.

## 2. Take the project
- session_start with the revision you read and the user's brief, unless a session is already
  active. While it lasts the user watches and cannot edit; every edit you save is a revision,
  and they can restore the project as it was before the session.

## 3. Choose footage
- describe_recording for each recording: its steady ranges inside the kept ranges, with the
  camera move (pan, tilt, push in…), picture speed and flight data, plus a contact sheet of
  their middle frames. Judge composition, light and subject from the pictures. With many
  recordings, read them with sheet false first and look at them with compare_recordings.
- compare_recordings puts candidates from several recordings in one sheet: their longest steady
  ranges, or ranges you name. Flights hold several similar takes of one subject; compare them
  and keep only the best. frames 3 shows how each movement starts, develops and ends.
- recording_sheet with a range's start, middle and end frames shows whether its movement
  completes. Prefer whole camera movements to fragments; skip damaged and hovering stretches.
- Clips must stay inside the kept ranges; edits that leave them are refused.

## 4. Structure
- Order the shots to tell the flight: chronologically or by place, a wide establishing shot at
  the start and at section starts, the most dramatic movement on the peak, calm shots in quiet
  sections.
- Plan clip lengths from the sections and the beat grid: longer clips on slow or quiet music,
  shorter ones and cuts on downbeats at peaks. Two to eight beats per clip is a usual range.

## 5. Build
- One Ripple video track, filled with one edit batch of insert commands in timeline order.
  Use preview_edits to check a batch before saving it.
- snap_cuts_to_beats (first without apply, then with apply) moves each cut onto the beat;
  check_alignment reports how the cut follows the music.
- Transitions: cuts on beats; short cross-dissolves (8–15 frames) between related shots; fade
  through black between sections; opening and closing fades on the track to match the music.
- Use a second track only for an overlay or a clip that needs its own grade.

## 6. Grade
- describe_track before changing appearance: settings interact (Contrast with Shadows,
  Highlights, Whites and Blacks shape one tone curve). Prefer static grades; animate only when
  the brief asks or the light changes within a shot.
- Start from estimate: auto-adjust on a representative clip (or the whole track) gives the
  editor's Auto correction and the edit applying it; white-balance only Temperature and Tint;
  detail suggests a clip's Denoise and Sharpen. Clips needing different grades go on their own
  track, since Colour belongs to the track.
- Change one setting with colour-setting, hsl-band, colour-curve or transform-setting, which
  keep every other value; a keyed setting follows its keyframes, so change those instead
  (layer-key-value). The colour and transform commands replace everything and suit a full grade.
- Compare with still or timeline_sheet: both accept commands to preview a change without saving.
  Judge Detail on a 1:1 crop: no halos, no waxy smoothing.

## 7. Finish
- Verify with a timeline_sheet across the cut, check_alignment and the duration against the
  target.
- session_end with notes for the user: the structure, the choices you made and anything they
  should look at.
`;
