# The image Loom runs each project's checks in. The full Node image already
# has git, python3 and a compiler, which covers `npm ci && npm test` with
# native modules; add what your projects need.
FROM node:22-bookworm
RUN mkdir -p /work
WORKDIR /work
# Loom runs each check with exec; the container just stays up between them.
CMD ["sleep", "infinity"]
