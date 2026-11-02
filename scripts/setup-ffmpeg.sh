#!/usr/bin/env bash
set -euo pipefail

# Builds the FFmpeg release PasCap is qualified on into a dedicated folder, for CI and local installs.
# src/shared/toolchain.ts names the same version and components; a unit test keeps them in step.
readonly VERSION=9.0.2
readonly SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
readonly ENCODERS=(libx264 ffv1 aac pcm_s16le)
readonly FILTERS=(lut3d xfade setparams testsrc2 sine anullsrc)
readonly BITSTREAM_FILTERS=(setts)

usage() {
  printf 'Usage: npm run setup:ffmpeg -- <absolute installation folder> [--nvdec]\n' >&2
  printf 'For example: npm run setup:ffmpeg -- "$HOME/.local/opt/ffmpeg-%s"\n' "$VERSION" >&2
  printf '%s\n' '--nvdec adds NVIDIA hardware decoding for proxy preparation (needs nv-codec-headers).' >&2
  exit 1
}

PREFIX=
NVDEC=false
for argument in "$@"; do
  case $argument in
    --nvdec) NVDEC=true ;;
    -*) usage ;;
    *) [[ -z $PREFIX ]] || usage; PREFIX=$argument ;;
  esac
done
[[ -n $PREFIX ]] || usage
if [[ "$PREFIX" != /* || "$PREFIX" == / ]]; then
  printf 'Use an absolute, dedicated installation folder, not %s.\n' "$PREFIX" >&2
  exit 1
fi
readonly PREFIX NVDEC

verify_installation() {
  local missing=() version filters encoders bsfs hwaccels name list
  version=$("$PREFIX/bin/ffmpeg" -version 2>/dev/null) || true
  grep -qF "ffmpeg version $VERSION" <<< "$version" || missing+=("ffmpeg version $VERSION")
  version=$("$PREFIX/bin/ffprobe" -version 2>/dev/null) || true
  grep -qF "ffprobe version $VERSION" <<< "$version" || missing+=("ffprobe version $VERSION")
  filters=$("$PREFIX/bin/ffmpeg" -hide_banner -filters 2>/dev/null) || true
  encoders=$("$PREFIX/bin/ffmpeg" -hide_banner -encoders 2>/dev/null) || true
  bsfs=$("$PREFIX/bin/ffmpeg" -hide_banner -bsfs 2>/dev/null) || true
  for name in "${FILTERS[@]}"; do
    grep -qE "[[:space:]]$name[[:space:]]" <<< "$filters" || missing+=("$name filter")
  done
  for name in "${ENCODERS[@]}"; do
    grep -qE "[[:space:]]$name[[:space:]]" <<< "$encoders" || missing+=("$name encoder")
  done
  for name in "${BITSTREAM_FILTERS[@]}"; do
    grep -qFx "$name" <<< "$bsfs" || missing+=("$name bitstream filter")
  done
  if [[ $NVDEC == true ]]; then
    hwaccels=$("$PREFIX/bin/ffmpeg" -hide_banner -hwaccels 2>/dev/null) || true
    grep -qFx cuda <<< "$hwaccels" || missing+=('cuda hardware decoding')
  fi
  if ((${#missing[@]})); then
    printf -v list '%s, ' "${missing[@]}"
    printf 'The FFmpeg in %s lacks %s. Install into an empty folder instead.\n' "$PREFIX" "${list%, }" >&2
    exit 1
  fi
}

print_settings() {
  printf '\nFFmpeg %s is ready in %s. Point PasCap at it:\n' "$VERSION" "$PREFIX"
  printf 'export PASCAP_FFMPEG=%q\n' "$PREFIX/bin/ffmpeg"
  printf 'export PASCAP_FFPROBE=%q\n' "$PREFIX/bin/ffprobe"
}

if [[ -x "$PREFIX/bin/ffmpeg" && -x "$PREFIX/bin/ffprobe" ]]; then
  verify_installation
  printf 'Verified the installed FFmpeg %s.\n' "$VERSION"
  print_settings
  exit 0
fi

tools=()
for executable in curl sha256sum tar make gcc pkg-config nasm; do
  command -v "$executable" >/dev/null || tools+=("$executable")
done
if command -v pkg-config >/dev/null; then
  pkg-config --exists x264 || tools+=('the libx264 development files')
  [[ $NVDEC == false ]] || pkg-config --exists ffnvcodec || tools+=('nv-codec-headers')
fi
if ((${#tools[@]})); then
  packages='build-essential curl pkg-config nasm libx264-dev'
  [[ $NVDEC == false ]] || packages+=' libffmpeg-nvenc-dev'
  printf -v list '%s, ' "${tools[@]}"
  printf 'Building FFmpeg needs %s.\nOn Debian or Ubuntu: sudo apt-get install %s\n' "${list%, }" "$packages" >&2
  exit 1
fi

configure=(--prefix="$PREFIX" --disable-doc --disable-debug --disable-autodetect
  --enable-gpl --enable-libx264 --enable-pthreads --disable-ffplay)
[[ $NVDEC == false ]] || configure+=(--enable-ffnvcodec --enable-nvdec --enable-cuvid)

readonly BUILD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pascap-ffmpeg.XXXXXXXX")
trap 'rm -rf -- "$BUILD_DIR"' EXIT
# ffmpeg.org intermittently resets or refuses connections; the checksum below guards every retry.
curl --fail --location --silent --show-error --connect-timeout 30 \
  --retry 6 --retry-delay 20 --retry-all-errors \
  "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" \
  --output "$BUILD_DIR/ffmpeg.tar.xz"
printf '%s  %s\n' "$SHA256" "$BUILD_DIR/ffmpeg.tar.xz" | sha256sum --check --strict
tar -xJf "$BUILD_DIR/ffmpeg.tar.xz" -C "$BUILD_DIR"
pushd "$BUILD_DIR/ffmpeg-$VERSION" >/dev/null
./configure "${configure[@]}"
make -j "${PASCAP_FFMPEG_JOBS:-$(getconf _NPROCESSORS_ONLN)}"
make install
popd >/dev/null
verify_installation
printf 'Built and verified FFmpeg %s.\n' "$VERSION"
print_settings
