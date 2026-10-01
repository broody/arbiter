# arbiter prover image: the gateway and the PROOF1 backend its workers run.
#   docker build -f prover/deploy/Dockerfile -t arbiter-prover .
# CPU sets the backend's target: x86-64-v3 (portable, default) or native (about
# 1.7x faster proofs, tied to the build host's CPU). Run it as described in
# prover/README.md (Deploy).
ARG CPU=x86-64-v3

FROM rust:1.95-bookworm AS build
ARG CPU
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv clang cmake \
 && python3 -m venv /opt/cairo-lang && /opt/cairo-lang/bin/pip install --no-cache-dir cairo-lang==0.14.3a3
# build.sh reads its pins and records the build with node.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /src
COPY prover/build.sh prover/pins.json prover/
COPY prover/patches prover/patches
RUN ARBITER_PROVER_BUILD=/opt/arbiter-prover CAIRO_LANG_BIN=/opt/cairo-lang/bin TARGET_CPU=$CPU prover/build.sh

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --home /var/lib/arbiter-prover --create-home arbiter
WORKDIR /opt/arbiter
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY sdk/src sdk/src
COPY prover/server.mjs prover/workers.mjs prover/
COPY --from=build /opt/arbiter-prover/bin /opt/arbiter-prover/bin
COPY --from=build /opt/arbiter-prover/tools /opt/arbiter-prover/tools
COPY --from=build /opt/arbiter-prover/build.json /opt/arbiter-prover/
COPY prover/deploy/entrypoint.sh /usr/local/bin/arbiter-entrypoint
ENV ARBITER_PROVER_BUILD=/opt/arbiter-prover
EXPOSE 3100
ENTRYPOINT ["/usr/local/bin/arbiter-entrypoint"]
