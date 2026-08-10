# How the bundled beds were generated

Reproducible with any ffmpeg build. Nothing here is downloaded.

## still-water.m4a — low drone, A/E/A
ffmpeg -f lavfi -i "sine=frequency=110:duration=45,volume=0.5[a];\
sine=frequency=164.81:duration=45,volume=0.32[b];\
sine=frequency=220:duration=45,volume=0.18[c];\
[a][b][c]amix=inputs=3,tremolo=f=0.12:d=0.35,lowpass=f=900,\
afade=t=in:d=3,afade=t=out:st=42:d=3" -c:a aac -b:a 128k still-water.m4a

## open-road.m4a — brighter, D/A/D
ffmpeg -f lavfi -i "sine=frequency=146.83:duration=45,volume=0.45[a];\
sine=frequency=220:duration=45,volume=0.30[b];\
sine=frequency=293.66:duration=45,volume=0.14[c];\
[a][b][c]amix=inputs=3,tremolo=f=0.12:d=0.25,lowpass=f=1400,\
afade=t=in:d=3,afade=t=out:st=42:d=3" -c:a aac -b:a 128k open-road.m4a

## cold-air.m4a — pink noise over a low sine
ffmpeg -f lavfi -i "anoisesrc=d=45:c=pink:a=0.12[n];\
sine=frequency=98:duration=45,volume=0.35[s];\
[n][s]amix=inputs=2,lowpass=f=500,afade=t=in:d=4,afade=t=out:st=41:d=4" \
-c:a aac -b:a 128k cold-air.m4a

Note: `tremolo` rejects f below 0.1, which is why the slow pulse is 0.12 Hz
rather than the 0.08 first tried.
