# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_BASE
FROM ${NODE_BASE} AS node-test

ENV HOME=/tmp \
    NODE_ENV=test

WORKDIR /workspace

COPY --chown=0:0 worker/ /workspace/worker/
COPY --chown=0:0 docs/ /workspace/docs/
COPY --chown=0:0 paperpilot/tests/viewer/ /workspace/paperpilot/tests/viewer/
COPY --chown=0:0 docker/run-node-tests.mjs /opt/paperpilot/run-node-tests.mjs

RUN --network=none node --input-type=module -e \
    'import assert from "node:assert/strict"; assert.equal(process.versions.node.split(".")[0], "20")'

USER 65532:65532

ENTRYPOINT ["node", "/opt/paperpilot/run-node-tests.mjs"]
