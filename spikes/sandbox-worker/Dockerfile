# The donor image ships the shim that @cloudflare/sandbox runs in the container.
# Keep its tag equal to the installed @cloudflare/sandbox version.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.3
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:26-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
# Pinned: flags, the extension API and the event format can change between releases.
RUN npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.87.1
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY container/ /opt/spike/
RUN printf '#!/bin/sh\nexec node /opt/spike/report.mjs "$@"\n' >/usr/local/bin/report \
  && chmod +x /usr/local/bin/report
WORKDIR /workspace
CMD ["sleep", "infinity"]
