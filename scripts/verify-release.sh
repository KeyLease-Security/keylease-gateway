#!/usr/bin/env bash
# Verify the SBOMs and SLSA provenance attached to a keylease-gateway release.
#
# Usage: scripts/verify-release.sh <tag> [--repo owner/name]
#
# Requires an authenticated `gh` (GitHub CLI). Attestation verification asks
# GitHub for the attestation stored against the repository, so the attached
# *.attestation.jsonl bundles are downloaded as an offline record but are not
# trusted on their own.
set -euo pipefail

repo="KeyLease-Security/keylease-gateway"
tag="${1:-}"
if [[ -z "$tag" || "$tag" == "-h" || "$tag" == "--help" ]]; then
  echo "usage: $0 <tag> [--repo owner/name]" >&2
  exit 2
fi
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      repo="${2:?--repo needs a value}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

gh release download "$tag" --repo "$repo" --dir "$workdir" \
  --pattern '*.tgz' \
  --pattern '*.wasm' \
  --pattern '*.cdx.json' \
  --pattern '*.attestation.jsonl'

shopt -s nullglob
artifacts=( "$workdir"/*.tgz "$workdir"/*.wasm )
sboms=( "$workdir"/*.cdx.json )
bundles=( "$workdir"/*.attestation.jsonl )

if (( ${#artifacts[@]} == 0 )); then
  echo "no *.tgz or *.wasm artifacts attached to $tag" >&2
  exit 1
fi
if (( ${#sboms[@]} < 2 )); then
  echo "expected a pnpm and a Rust CycloneDX SBOM, found ${#sboms[@]}" >&2
  exit 1
fi
if (( ${#bundles[@]} == 0 )); then
  echo "no attestation bundle attached to $tag" >&2
  exit 1
fi

for artifact in "${artifacts[@]}"; do
  echo "verifying $(basename "$artifact")"
  gh attestation verify "$artifact" --repo "$repo"
done

echo "verified ${#artifacts[@]} artifact(s), ${#sboms[@]} SBOM(s) and ${#bundles[@]} attestation bundle(s) from $tag"
