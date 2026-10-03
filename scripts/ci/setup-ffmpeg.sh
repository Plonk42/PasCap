#!/usr/bin/env bash
set -euo pipefail

# Native CI uses the tested FFmpeg release, not an unqualified runner package.
# Build inputs: build-essential, pkg-config, nasm and libx264-dev on Linux.
readonly VERSION=8.0.1
readonly SHA256=05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41
readonly PREFIX="${1:?Pass an absolute, dedicated FFmpeg installation directory.}"

if [[ "$PREFIX" != /* || "$PREFIX" == / ]]; then
  printf 'Use an absolute, dedicated installation directory, not /.\n' >&2
  exit 1
fi

verify_installation() {
  "$PREFIX/bin/ffmpeg" -version | grep -F "ffmpeg version $VERSION" >/dev/null
  "$PREFIX/bin/ffprobe" -version | grep -F "ffprobe version $VERSION" >/dev/null
  local filters encoders bsfs
  filters=$("$PREFIX/bin/ffmpeg" -hide_banner -filters 2>/dev/null)
  encoders=$("$PREFIX/bin/ffmpeg" -hide_banner -encoders 2>/dev/null)
  bsfs=$("$PREFIX/bin/ffmpeg" -hide_banner -bsfs 2>/dev/null)
  for name in lut3d xfade setparams testsrc2 sine anullsrc; do
    grep -E "[[:space:]]$name[[:space:]]" <<< "$filters" >/dev/null
  done
  for name in libx264 ffv1 aac pcm_s16le; do
    grep -E "[[:space:]]$name[[:space:]]" <<< "$encoders" >/dev/null
  done
  grep -Fx 'setts' <<< "$bsfs" >/dev/null
}

if [[ -x "$PREFIX/bin/ffmpeg" && -x "$PREFIX/bin/ffprobe" ]]; then
  verify_installation
  printf 'Verified cached FFmpeg %s in %s\n' "$VERSION" "$PREFIX"
  exit 0
fi

for executable in curl sha256sum tar make gcc pkg-config nasm; do
  command -v "$executable" >/dev/null
done
pkg-config --exists x264

readonly BUILD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pascap-ci-ffmpeg.XXXXXXXX")
trap 'rm -rf -- "$BUILD_DIR"' EXIT
curl --fail --location --retry 3 --silent --show-error \
  "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" \
  --output "$BUILD_DIR/ffmpeg.tar.xz"
printf '%s  %s\n' "$SHA256" "$BUILD_DIR/ffmpeg.tar.xz" | sha256sum --check --strict
tar -xJf "$BUILD_DIR/ffmpeg.tar.xz" -C "$BUILD_DIR"
pushd "$BUILD_DIR/ffmpeg-$VERSION" >/dev/null
./configure --prefix="$PREFIX" --disable-doc --disable-debug --disable-autodetect \
  --enable-gpl --enable-libx264 --enable-pthreads --disable-ffplay
make -j "${PASCAP_CI_BUILD_JOBS:-2}"
make install
popd >/dev/null
verify_installation
printf 'Built and verified FFmpeg %s in %s\n' "$VERSION" "$PREFIX"