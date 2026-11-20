#!/usr/bin/env bash
set -euo pipefail

bin=$1
mkdir -p "$bin"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# The same app and core versions run for both revisions.
fetch() {
    curl -q -fsSL --retry 3 --max-time 120 "https://releases.herdr.dev/$1" -o "$scratch/archive.tar.gz"
    printf '%s  %s\n' "$2" "$scratch/archive.tar.gz" | sha256sum --check --status
    tar -xzf "$scratch/archive.tar.gz" -C "$scratch" -- "$3"
    install -m755 "$scratch/$3" "$bin/$4"
}

fetch app/0.1.16/herdr-app-linux-x86_64.tar.gz \
    282d2632196b238206cfe66bfb61c0faf299ca1c91843bd076521bbe36571216 herdr-app/herdr-app herdr-app
fetch core/0.1.21/herdr-core-linux-x86_64.tar.gz \
    78424755c10a40dde38a0bdb55c20ac19706e9ae05ed68fc2acf1fcff0d941c1 herdr-core herdr-core
ln -s herdr-core "$bin/hc"
