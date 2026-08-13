#!/usr/bin/env bash
# Materialize frozen proxy image bytes under eval/proxy/images/ and refresh
# manifest.json (sha256 + labels).
#
# Prerequisites (legal AI sources — not procedural noise):
#   PROXY_DRAGON_DIR   — directory with DRAGON test PNGs:
#                        sdxl_N_N_test.png, flux_1_N_N_test.png, pixart_alpha_N_N_test.png
#                        (from https://huggingface.co/datasets/lesc-unifi/dragon)
#   PROXY_OPENFAKE_DIR — directory with OpenFake core **test** fake PNGs
#                        (from ComplexDataLab/OpenFake, label=fake only)
#
# Defaults point at /mnt/HC_Volume_105994188/poidh-cache/{dragon_extract,openfake_test}.
# COCO val2017 is fetched over HTTP during the build.
#
# After 4.1 starts, do not change the freeze without owner amendment.
set -euo pipefail
cd "$(dirname "$0")/../.."
node eval/proxy/build_images.mjs
echo "fetch.sh: proxy images + manifest ready under eval/proxy/"
