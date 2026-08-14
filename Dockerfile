# syntax=docker/dockerfile:1
FROM --platform=$TARGETPLATFORM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
COPY --from=linux-$TARGETARCH / /opt/pi
ENV PATH="/opt/pi:$PATH"

WORKDIR /workspace
ENTRYPOINT ["pi"]
