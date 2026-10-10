# docker image inspect output

Real output of the Docker 29.4.0 CLI for a postgres:15-alpine image held in
the local image store, recorded on 2026-10-08. `present.json` answers all
three reference forms a scan can name, byte for byte:

- `docker image inspect postgres:15-alpine`
- `docker image inspect docker.io/library/postgres:15-alpine`
- `docker image inspect postgres@sha256:f7d23353e1b1...` (the digest from the
  image's `RepoDigests`)

`absent.txt` is the stderr of `docker image inspect alpine:3.19` for an image
that is not present, which exits 1.

`present.json` is trimmed for the fixture: the `RootFS.Layers` list keeps two
of its eleven digests and the `Metadata.LastTagTime` timestamp is dropped.
Every other field is as recorded.
