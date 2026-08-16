# Theme audio credits

Every file here is CC0 (Creative Commons Zero, public domain dedication), which
requires no attribution. We record it anyway because provenance is what lets a
future maintainer re-verify the license, re-download a source, or re-encode at a
different bitrate without re-doing this research from scratch.

All clips were transcoded to OGG Vorbis and loudness-normalized with a two-pass
ffmpeg `loudnorm` to **-24 LUFS integrated, -2 dBTP** so no clip is jarringly
louder than another. They loop under a working terminal, so the target is
deliberately quiet. Looping is handled in code (`themeAudio.js` sets
`el.loop = true`); the files are not gapless-mastered.

| File | Source work | Author | License | Source page |
|---|---|---|---|---|
| `post-apocalyptic-wastelands.ogg` | Post Apocalyptic Wastelands [Loop Ready].ogg | Juhani Junkala (OGA user `SubspaceAudio`) | CC0 | https://opengameart.org/content/horror-atmosphere |
| `cyber-city.ogg` | busy_cyberworld.ogg | TinyWorlds | CC0 | https://opengameart.org/content/scifi-city-ambient-loop |
| `scifi-drone.ogg` | Sci-fi Ambient Drone | LookIMadeAThing | CC0 | https://freesound.org/people/LookIMadeAThing/sounds/534018/ |
| `dead-ship.ogg` | MyVeryOwnDeadShip.ogg | yd | CC0 | https://opengameart.org/content/background-space-track |
| `observing-the-star.ogg` | ObservingTheStar.ogg | yd | CC0 | https://opengameart.org/content/another-space-background-track |
| `out-there.ogg` | OutThere.ogg | yd | CC0 | https://opengameart.org/content/space-music-out-there |
| `dungeon-ambience.ogg` | dungeon_ambient_1.ogg | JaggedStone | CC0 | https://opengameart.org/content/loopable-dungeon-ambience |
| `forest-ambience.ogg` | Forest_Ambience_0.mp3 | FGResources | CC0 | https://opengameart.org/content/cc0-background-ambience |

## Source notes

- `dead-ship.ogg` and `observing-the-star.ogg` were extracted from the LMMS
  project zips (`projects.zip`, `ObservingTheStar.zip`) that those two pages
  attach instead of a bare .ogg.
- `scifi-drone.ogg` was encoded from Freesound's **public high-quality MP3
  preview**, not the 90.6 MB source WAV. Freesound puts the original file
  behind an account login; the preview is the same CC0 work, served publicly
  and at full length (2:45). This means one extra lossy generation. It is
  inaudible at the volume this plays at, but if someone later wants a clean
  master, download the WAV with a Freesound account and re-run the encode.

## Shared pool, not per-theme copies

Eight clips cover 23 themes. They live in one flat directory and each
`theme.json` points at the shared URL. Per-theme directories would duplicate
megabytes of identical audio for no benefit.
