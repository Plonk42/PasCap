# WebCodecs preview decoding

Current contract for [#148](https://github.com/Plonk42/PasCap/issues/148): timeline
preview and source review decode prepared editing proxies with WebCodecs
`VideoDecoder`, not `<video>` elements. Each decoded image is identified by its
exact source frame from the moment it is decoded, so the preview never infers
identity from media-element time, video-frame callbacks or seeking heuristics.
This describes the implementation contract, not intended-GPU or long-flight
qualification ([#6](https://github.com/Plonk42/PasCap/issues/6),
[#7](https://github.com/Plonk42/PasCap/issues/7),
[#8](https://github.com/Plonk42/PasCap/issues/8)).

Implementation authorities: [proxy index](../../src/preview/proxy-index.ts),
[reader](../../src/preview/video-source.ts), [worker entry](../../src/preview/video-reader.ts),
[protocol](../../src/preview/video-protocol.ts), [page client](../../src/preview/video-streams.ts),
[engine](../../src/preview/engine.ts), [compositor](../../src/preview/compositor.ts)
and [source playback](../../src/web/source-transport.ts).

## Editing proxy contract

Preview reads only the verified editing proxy, never an original, through the
existing guarded byte-range route. Proxies are already prepared as faststart
H.264 MP4 with a 15-frame closed GOP, no B-frames and a 30000 timescale; the
proxy format is unchanged. The reader reads the first 64 KiB, locates `moov`
(reading the rest of it when larger) and builds a sample index: byte offset,
size and keyframe flag for every frame. It requires:

- `moov` before `mdat` (faststart);
- exactly one H.264 (`avc1`/`avc3`) video track with an `avcC` description;
- no edit offset (edit-list media time 0) and no composition offsets
  (no reordered frames);
- uniform 1001/30000 s frame durations and strictly increasing sample offsets;
- a keyframe as the first sample.

A violation is an explicit error naming the problem and asking to prepare the
recording again; there is no fallback decoder. Source frame _n_ of a recording is
proxy sample _n_. Each worker caches the indexes of at most 16 proxies.

## Reader worker

Each viewer owns one dedicated module worker (`pascap-video-reader`), which owns
the range reads, the indexes and one `VideoDecoder` per **decoder lane**. The
page sends `start`, `extend`, `credit` and `stop` commands; the worker posts
`frame` reports, transferring each `VideoFrame` with its exact source frame and
the lane's stream generation, or a `failed` report.

- A stream is an ascending list of wanted source frames. The worker decodes from
  the keyframe at or before each wanted frame, never earlier than its current
  position, so it skips whole GOPs between distant wanted frames. Frames that are
  decoded but not wanted are closed in the worker immediately.
- Reads are bounded ranges of at most 32 frames that never cross the next
  keyframe; the decoder queue holds at most eight chunks.
- **Credits** bound memory: a lane may have at most six frames decoded but not
  yet returned (queued in the page or in flight). The page returns one credit for
  each frame it presents, passes or supersedes, together with the lowest source
  frame it still needs, so a late lane skips frames the clock has already passed
  instead of decoding them.
- `stop` (or a new `start`) increments the generation: stale reports are closed
  on arrival, never shown. A completed stream flushes its decoder.
- A failed range read, a range request answered with the whole file, a frame
  beyond the proxy, an unsupported codec configuration or a decoder error is a
  `failed` report for that lane, surfaced as a preview error.

## Timeline engine

The engine allocates **two decoder lanes per video track, up to 16 for eight
tracks**, each with one compositor texture. A lane is assigned to a clip, not to a
fixed A/B role: each scheduling pass keeps lanes on the clips active at the
current frame, then gives free lanes to each enabled track's next clip so a cut
or dissolve can start from prefilled frames.

- Each lane's stream requests the clip's exact source frames for the next 60
  output frames, extended when fewer than 30 remain. Slow motion's repeated
  source frames are requested once; a held image is reused.
- Paused seeks start a one-frame stream per active clip, wait for that exact
  frame, upload it and stop. A lane already showing the exact recording and
  source frame keeps its texture without decoding again. The previous image stays
  meanwhile; the seeking or buffering overlay appears only after 250 ms of
  continuous waiting, so ruler scrubbing does not blink.
- Play prefills up to three frames per active clip, starts music when present
  and anchors the clock at the requested frame.
- Every animation frame, the clock frame is sampled. Frames the clock has passed
  are closed and credited; the exact required frame of each active clip is
  uploaded. The surface is redrawn only when sources or evaluated composition
  values change, as before.
- **Buffering** means a required decoded frame is not yet available. The
  previous image remains on screen. Without music, the wall clock holds at that
  frame and resumes from it once every frame is present. With music, the audio
  clock continues and late frames are dropped through credit minimums; video
  rejoins at the current audio frame. Music restarts only when its own clock
  synchronisation fails.
- If a required frame has not arrived after five seconds of buffering, playback
  stops with **Video decoder _N_ did not deliver source frame _S_ within 5
  seconds.** A reader failure stops playback with its own message.
- **Playing** promises an image within one frame of the clock. When a draw itself
  outlasts a frame on a slow renderer, the status is **Catching up with the clock**
  instead, without counting a decoder stall; the next frame is drawn at the clock.
  While playing, status snapshots are published only by the display tick right
  after it draws, so holding Original or a new subscriber never receives an image
  drawn before the clock moved on.
- Pause, seek, timing edits, project changes and disposal stop the affected
  streams; their in-flight frames are discarded by generation.

Diagnostics report decoded, queued and dropped frames, stalls (mid-clip and at clip
boundaries) and total stall time. WebGL context loss stops playback and releases
every lane.

## Source review

Source preview uses its own reader worker with one lane, drawing into a canvas
(`data-source-decoder`). Hover scrubbing and range handles request one exact
frame each, superseding the previous request. While a requested frame decodes, the
previous image stays; only after 250 ms without it is the image hidden behind
**Seeking frame _N_…**, so fast scrubbing does not blink. **Play** streams from the observed
frame, or IN, on a wall clock that holds while a frame is missing, stops on the
last included frame (OUT − 1) and never loops or plays audio. A frame missing for
five seconds fails with **Source playback did not deliver a frame within 5
seconds.** Closing, hiding or changing recording or project terminates the worker.

## Requirements and resources

The editor requires WebCodecs `VideoDecoder` with H.264 support, module workers,
WebGL2 and AudioWorklet. A missing capability is a preview error, not a fallback.

| Resource            | Bound                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| Timeline decoders   | Two per video track, at most 16, in one worker                              |
| Decoded frames      | At most six outstanding per decoder (page queue plus worker)                |
| Decoder input       | At most eight queued chunks per decoder; reads of at most 32 frames per GOP |
| Proxy indexes       | At most 16 cached per worker                                                |
| Source review       | One worker, one decoder, one 2D canvas                                      |
| Compositor textures | One per timeline decoder, reused across clips                               |

Music, native export, proxy preparation and the project schema are unchanged.
