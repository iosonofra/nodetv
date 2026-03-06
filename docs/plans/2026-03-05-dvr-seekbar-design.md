# DVR Seekbar for Live TV Player — Design Doc

## Problem
The Live TV player has custom controls (play/pause, volume, captions, PiP, fullscreen) but no seekbar. Users cannot seek backwards in the HLS back-buffer to rewatch something they just missed.

## Approach
**Approach B (Minimal Inline):** A thin seekbar integrated into the existing controls row, between the play button and the volume/mute controls. Includes a small LIVE badge.

## Layout
```
[Play] [==seekbar==] [LIVE] [Mute] [Volume] [CC] [PiP] [FS] [⋮]
```

## Behavior
- Seekbar range: start of HLS buffer → live edge
- At live edge → bar full, LIVE badge green
- Behind live edge → LIVE badge grey, clickable to jump back to live
- Updates via `timeupdate` event (~250ms)
- 30 seconds back-buffer (existing HLS config)

## Style
- Seekbar styled like existing volume slider
- LIVE badge: small pill, green/grey states
