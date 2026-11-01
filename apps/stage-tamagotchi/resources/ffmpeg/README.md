# ffmpeg (bundled)

`ffmpeg.exe` and `ffprobe.exe` placed here are copied into the packaged app as
`resources/ffmpeg/`, and the video module prefers them over anything on `PATH`.

The binaries are not committed (277 MB). Put a static Windows build here before
`pnpm build:unpack`, e.g. copy them from an existing toolchain:

```bash
cp <path-to>/ffmpeg.exe  apps/stage-tamagotchi/resources/ffmpeg/
cp <path-to>/ffprobe.exe apps/stage-tamagotchi/resources/ffmpeg/
```

Without them the app still works: it falls back to a path set in
设置 → 模块 → 看视频, then `AIRI_FFMPEG_PATH`, then `PATH`.
