const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');

/**
 * Transcode stream
 * GET /api/transcode?url=...
 * 
 * Transcodes audio to AAC for browser compatibility while passing video through.
 * This fixes playback issues with Dolby/AC3/EAC3 audio that browsers can't decode.
 */
router.get('/', (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    console.log(`[Transcode] Starting transcoding for: ${url}`);
    console.log(`[Transcode] Using binary: ${ffmpegPath}`);

    // FFmpeg arguments for transcoding
    // Optimized for VOD content with incompatible audio (Dolby/AC3/EAC3)
    // Also works for live streams with ad stitching (Pluto TV, etc.)
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        // Low-latency startup vs Reliability trade-off
        // Increased to 5MB/10s to handle slow HLS manifests and streams with large headers
        '-probesize', '5000000', // 5MB
        '-analyzeduration', '10000000', // 10 seconds
        // Error resilience: generate timestamps, discard corrupt packets
        '-fflags', '+genpts+discardcorrupt',
        // Ignore errors in stream and continue
        '-err_detect', 'ignore_err',
        // Limit max demux delay to prevent buffering issues with bad timestamps
        '-max_delay', '5000000',
        // Reconnect settings for network drops (useful for live streams)
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', url,
        // Video: passthrough (no re-encoding = fast!)
        '-c:v', 'copy',
        // Audio: Transcode to browser-compatible AAC with consistent parameters
        '-c:a', 'aac',
        '-ar', '48000',
        '-b:a', '256k', // Increased for surround sound
        '-af', 'aresample=48000:async=1',
        // Handle timestamp discontinuities at output
        '-fps_mode', 'passthrough',
        '-max_muxing_queue_size', '1024',
        // Fragmented MP4 for streaming (browser-compatible)
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-' // Output to stdout
    ];

    console.log(`[Transcode] Full command: ${ffmpegPath} ${args.join(' ')}`);

    let ffmpeg;
    try {
        ffmpeg = spawn(ffmpegPath, args);
    } catch (spawnErr) {
        console.error('[Transcode] Failed to spawn FFmpeg:', spawnErr);
        return res.status(500).json({ error: 'FFmpeg spawn failed', details: spawnErr.message });
    }

    // Collect stderr for error reporting
    let stderrBuffer = '';

    // Set headers for fragmented MP4
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe stdout to response
    ffmpeg.stdout.pipe(res);

    // Log stderr (useful for debugging transcoding failures)
    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        stderrBuffer += msg;
        console.log(`[FFmpeg] ${msg}`);
    });

    // Cleanup on client disconnect
    req.on('close', () => {
        console.log('[Transcode] Client disconnected, killing FFmpeg process');
        ffmpeg.kill('SIGKILL');
    });

    // Handle process exit
    ffmpeg.on('exit', (code) => {
        if (code !== null && code !== 0 && code !== 255) { // 255 is often returned on kill
            console.error(`[Transcode] FFmpeg exited with code ${code}`);
        }
    });

    // Handle spawn errors
    ffmpeg.on('error', (err) => {
        console.error('[Transcode] Failed to spawn FFmpeg:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Transcoding failed to start' });
        }
    });
});

module.exports = router;
