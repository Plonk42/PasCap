#!/usr/bin/env bash
set -euo pipefail

# A short, private Unix socket path; never attach to or kill a desktop server.
audio_dir=$(mktemp -d /tmp/pascap-firefox-audio.XXXXXX)
export PULSE_RUNTIME_PATH="$audio_dir/runtime"
export PULSE_STATE_PATH="$audio_dir/state"
export PULSE_COOKIE="$audio_dir/cookie"
export PULSE_SERVER="unix:$audio_dir/native"
export PULSE_SINK=pascap_ci
# This dedicated server does not need the desktop session bus or sound devices.
export DBUS_SESSION_BUS_ADDRESS="unix:path=$audio_dir/no-session-bus"

cleanup() {
  local status=$?
  if [[ -f "$PULSE_RUNTIME_PATH/pid" ]]; then
    if ! pulseaudio --kill && [[ $status == 0 ]]; then status=1; fi
  fi
  if [[ $status != 0 && -f "$audio_dir/pulse.log" ]]; then
    cat "$audio_dir/pulse.log" >&2
  fi
  rm -rf -- "$audio_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -m 700 "$PULSE_RUNTIME_PATH" "$PULSE_STATE_PATH"

timeout 10s pulseaudio --daemonize=yes --fail=yes --exit-idle-time=-1 \
  --use-pid-file=yes --disable-shm=yes --high-priority=no --realtime=no \
  --log-level=warn --log-target="file:$audio_dir/pulse.log" -n \
  --load="module-native-protocol-unix socket=$audio_dir/native auth-cookie=$PULSE_COOKIE" \
  --load="module-null-sink sink_name=pascap_ci rate=48000 channels=2"
timeout 5s pactl set-default-sink pascap_ci
[[ $(timeout 5s pactl get-default-sink) == pascap_ci ]]
printf 'Firefox audio output: '
timeout 5s pactl list short sinks

xvfb-run -a "$@"
