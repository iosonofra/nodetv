# DLStreams Scraper - Advanced Optimizations (Phase 2, 2026-03-18)

## 8 Major Improvements Implemented

### 1. **Exponential Backoff Strategy** 
- **Function**: `getExponentialBackoffDelay(attempt, baseMs, maxMs)`
- **Logic**: attempt 0→2s, 1→4s, 2→8s, 3→16s (capped at 30s)
- **With jitter**: ±20% variation to avoid thundering herd
- **Applied to**: Protocol errors (3-12s), normal errors (2-30s)
- **Benefit**: Gradually backs off from blocked targets instead of hammering

### 2. **Smart Concurrency Ramping**
- **Concept**: Track success streaks in 20s time windows
- **Detection**: If 4+ successes in 20s, increase concurrency by 1
- **Limit**: Never exceeds configured max (default 3)
- **Reset**: Window resets on every adjustment
- **Intelligent**: Doesn't ramp up during failure periods
- **Benefit**: Scales up safely when site is responsive

### 3. **Hard Block Detection & Extended Cooldown**
- **Criteria**: Block page detected 2+ times on same channel
- **Trigger**: Indicates aggressive anti-bot blocking
- **Action**: Set cooldown to 1.2-1.5x normal (54-135s vs 45-90s)
- **Logging**: "[!] HARD BLOCK (2 hits) - extended cooldown by 60s"
- **Benefit**: Respects aggressive blocks without hammer pounding

### 4. **Page Recycling Strategy**
- **Trigger**: After every 15 requests per worker
- **Action**: Close page, create new one
- **Effect**: Clears stale cookies, CF tokens, session data
- **Timing**: Non-blocking, done between tasks
- **Configurable**: `SCRAPER_PAGE_RECYCLE_EVERY=15` (environment variable)
- **Benefit**: Prevents cookie-based silencing/blocking

```bash
[Worker 1] [*] Page recycling: recreating page after 15 requests (clearing cookies)
```

### 5. **Aggressive Resource Blocking** (25+ patterns)
**New patterns added for blocking**:
```
Cloudflare:
- 'challenge-platform', 'challenges.cloudflare', 'cdn-cgi'
- 'cloudflare', 'cloudflare-static', '/cdn/', '/static/'

Ad Networks:
- 'rubiconproject', 'openx.net', 'criteo', 'pagead'
- 'oas.com', 'scorecardresearch', 'matomo', 'mixpanel'

Video Ads:
- 'pubads', 'admeasures', 'ads.vimeo', 'bitmovin'
```
- **Effect**: Faster page loads, less distracting honeypots
- **Measurement**: Pages should load 30-50% faster

### 6. **Enhanced Cache Strategy**
- **Validated URLs**: 60 minute TTL (vs 30)
- **Unvalidated**: 20 minute TTL
- **Validation**: Optional cache validation on retrieval
- **Benefit**: Reuse successful URLs longer, reduce retry pressure

### 7. **Timing Noise Strategy**
- **Rate**: 20% of requests get +500-3000ms extra delay
- **Purpose**: Makes request patterns non-predictable to honeypots
- **Application**: Task gap delays between requests
- **Logging**: "[*] Extra timing noise: 250ms + 1234ms"
- **Benefit**: Appears more human-like to bot detection

### 8. **Dynamic Metrics & Monitoring**
**New metrics tracked**:
```javascript
metrics: {
    exponentialBackoffUsed: true,
    pageRecyclingEnabled: 15,  // every 15 requests
    smartRampingEnabled: true,
    blockedPageEvents: 6,
    finalConcurrency: 2,       // ended at concurrency 2
    hardBlocksDetected: true
}
```

## Performance Expectations

### Before Phase 2
- Fixed retry delays: 2-6s (predictable)
- Concurrency: Fixed or slow to ramp
- Cookies: Never cleared (can get stale blocking)
- Resource blocking: ~20 patterns (slow loads)
- Hard blocks: Not distinguished (same delay as soft)

### After Phase 2
- **Exponential retry**: 2-30s (adaptive to condition)
- **Smart ramping**: Faster ramp-up on success
- **Page recycling**: Fresh cookies every 15 requests
- **Resource blocking**: 25+ patterns (faster loads)  
- **Hard blocks**: 1.2-1.5x longer cooldown (respects site)
- **Timing noise**: 20% unpredictability (human-like)

## Configuration Variables

```bash
# Page recycling
SCRAPER_PAGE_RECYCLE_EVERY=15        # default: 15 requests

# Exponential backoff (built-in, no config needed)
# Automatically scales: attempt N → baseMs * 2^N

# Concurrency ramping window
# Built into concurrency logic: 20s success window

# Timing noise (built-in)
# 20% chance of +500-3000ms extra delay
```

## Expected Improvements

### Metrics to Watch
1. **Concurrency stability**: Should stay at 2-3, not drop to 1 immediately
2. **Block detection accuracy**: More nuanced (hard vs soft blocks)
3. **Page recycling cycles**: Log should show "page recycling" every ~15 tasks
4. **Exponential backoff**: Longer delays on retry (vs fixed 2-6s)
5. **Success rate**: Fewer failures due to better cookie/session management
6. **Runtime diversity**: Mix of UA, timing, resource blocking

### Log Indicators

✅ **Good signs**:
```
[*] Exponential backoff: 8.234ms (protocol error recovery)
[Worker 2] [*] Page recycling: recreating page after 15 requests
[*] Adaptive concurrency adjusted to 2/3 (success window ramp)
[!] HARD BLOCK (2 hits) - extended cooldown by 75s
[*] Smart ramping: increased concurrency on success streak
```

❌ **Warning signs**:
```
[!] Block page detected (happens too frequently)
[Worker X] [!] Extract error: Protocol error (repeated)
[*] Saved empty playlist
```

## If Performance is Still Low

### Scenario 1: Still Getting Blocks
```bash
# Increase page recycling frequency
SCRAPER_PAGE_RECYCLE_EVERY=10  # Force page refresh every 10 requests

# Add more inter-request delay
SCRAPER_TASK_JITTER_MIN_MS=1000
SCRAPER_TASK_JITTER_MAX_MS=5000

# Reduce concurrency
SCRAPER_CONCURRENCY=1
```

### Scenario 2: Concurrency Not Ramping Up
- Check logs for "success window ramp" messages
- If not ramping, success rate might be too low
- Try: `SCRAPER_MIN_CONCURRENCY=1` + `SCRAPER_SUCCESS_THRESHOLD=4`

### Scenario 3: Protocol Errors Still High
```bash
# Reduce timeout pressure
SCRAPER_WORKER_JITTER_MIN_MS=2000  # increased stagger
SCRAPER_WORKER_JITTER_MAX_MS=8000

# Increase protocol timeout in getLaunchOptions()
# (currently 180000ms = 3 min, increase to 240000ms = 4 min)
```

## Technical Details

### Exponential Backoff Formula
```
delay = min(baseMs * 2^attempt, maxMs) + jitter(±20%)
Example: attempt=2, baseMs=2000, maxMs=30000
  → 2000 * 2^2 = 8000ms → 6400-9600ms with jitter
```

### Concurrency Ramp Logic
```
if (timeSinceLastAdjustment > 20s AND successesInWindow >= 4) {
    increase_concurrency_by(1)
    reset_window()
}
```

### Page Recycling Flow
```
Request 1-14: use page A
Request 15: TRIGGER → close page A, create page B
Request 16-29: use page B
Request 30: TRIGGER → close page B, create page C
...
```

## Files Modified
- `server/services/dlstreamsResolver.js`:
  - Added `getExponentialBackoffDelay()` function
  - Extended NOISY_URL_PATTERNS (25 patterns)
  - Extended cache TTL to 60 min

- `server/scraper/dlstreams.js`:
  - Added `getExponentialBackoffDelay()` helper
  - Added page recycling logic in `ensurePageReady()`
  - Added smart concurrency ramping on success
  - Added hard block detection + extended cooldown
  - Updated runtime metrics tracking

## Summary

These 8 optimizations work together to:
1. **Adapt better** to site conditions (exponential backoff, smart ramping)
2. **Reset state** more aggressively (page recycling)
3. **Avoid detection** more effectively (timing noise, resource blocking)
4. **Respect blocking** signals (hard block detection)
5. **Monitor progress** better (enhanced metrics)

**Expected outcomes**:
- 20-40% improvement in success rate
- More stable concurrency (less sudden drops to 1)
- Better handling of aggressive anti-bot measures
- Clearer diagnostics for future improvements
