# syntax=docker/dockerfile:1
ARG TARGETARCH
FROM linux-$TARGETARCH AS pi-binary
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=pi-binary / /opt/pi
ENV PATH="/opt/pi:$PATH"

WORKDIR /workspace
ENTRYPOINT ["pi"]
