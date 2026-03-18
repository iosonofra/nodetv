# DLStreams Scraper - Debug & Improvements (2026-03-18)

## Analysis of Last Failed Run
- **Date**: 2026-03-18
- **Status**: Partial failure - hit max duration (45 min)
- **Root Cause**: Aggressive blocking by dlstreams.top (6 blocked channels detected, concurrency downgrades)
- **Metrics**:
  - Blocked events: 6
  - Cooldown activations: 3
  - Final failures: 6
  - Empty playlist generated (7 bytes)
  - Final concurrency: 1/3 (severely downgraded)

## Issues Identified
1. **Cloudflare/CDN Blocking**: Block pages not being detected properly
   - Missing: Cloudflare challenge detection, JS challenge detection
   - Missing: Error 1010/1016 patterns, CF clearance detection
   - Impact: Retries on blocked pages wasted time

2. **Static User-Agent**: All workers using identical UA
   - Problem: Creates pattern detectable by honeypots
   - Solution: Implemented UA pool with 5 different browsers/versions

3. **Predictable Timing**: Fixed jitter ranges
   - Problem: Honeypots can predict request patterns
   - Solution: Added extra timing noise (20% chance → +500-3000ms)

4. **Protocol Errors**: "Network.setCacheDisabled timed out"
   - Problem: Poor error recovery - too short page creation timeout
   - Solution: Increased timeout to 15000ms, added protocol-specific retry logic

5. **Poor Diagnostics**: Block page detection too simplistic
   - Problem: Only checking for "Bypass the Block" text
   - Solution: Added comprehensive block detection + diagnostic logging

## Improvements Implemented

### 1. Enhanced Block Detection (dlstreamsResolver.js)
```javascript
// Now detects:
- Cloudflare challenges (checking browser, CF_clearance, error 1010/1016)
- JS challenges and CAPTCHA pages
- Rate limits (429, 403 errors)
- DLStreams specific blocks
```

### 2. User-Agent Rotation (dlstreamsResolver.js + dlstreams.js)
```javascript
UA_POOL = [
  Chrome 127 (Windows),
  Chrome 126 (Windows),
  Chrome 127 (macOS),
  Chrome 127 (Linux),
  Firefox 128
]
// Every page creation picks random UA from pool
```

### 3. Browser Launch Optimization (dlstreamsResolver.js)
```javascript
args: [
  '--disable-blink-features=AutomationControlled',
  '--disable-component-extensions-with-background-pages',
  '--disable-default-apps',
  '--disable-hang-monitor',
  // ... more flags to reduce detection surface
]
protocolTimeout: 180000  // 3 minutes for long ops
```

### 4. Protocol Error Resilience (dlstreams.js)
```javascript
// Detects protocol/session errors separately
// Applies longer retry delays for protocol errors (3-8s vs 2-6s)
// Attempts page recreation even after first failure
```

### 5. Timing Noise (dlstreams.js)
```javascript
sleepWithNoise() = base delay + (20% chance of +500-3000ms)
// Applied to task gaps between requests
```

### 6. Enhanced Diagnostics
```javascript
logBlockDiagnostics() = logs:
  - Cloudflare markers
  - CAPTCHA presence
  - JS challenge signatures
  - Block page snippets
// Helps identify new block types faster
```

## Performance Expectations

### Before
- Block detection: 1 method (text search)
- UA variation: None (static)
- Retry strategy: Basic (1 retry, fixed delay)
- Timeout issues: Frequent "Protocol error" crashes
- Block storm detection: Triggers frequently
- Concurrency degradation: Rapid (3 → 1)

### After
- Block detection: 8 different patterns
- UA variation: 5 different browsers
- Retry strategy: Protocol-aware (2-8s delays for protocol errors)
- Timeout issues: Better recovery with longer timeouts
- Timing noise: +20% extra delays (less predictable)
- Expected: Better success rate, fewer false positives on blocks

## Testing the Improvements

### Test 1: Quick Debug Run
```bash
# Run with minimal categories to test block detection
SCRAPER_CONCURRENCY=1 \
DLSTREAMS_CATEGORIES='["All Soccer Events"]' \
DLSTREAMS_HOURS_BEFORE=1 \
DLSTREAMS_HOURS_AFTER=1 \
npm run scraper:dlstreams:debug
```

### Test 2: Full Debug Run (45 min limit)
```bash
# Standard run with all improvements enabled
npm run scraper:dlstreams:debug
```

### Test 3: Protocol Error Resilience
```bash
# Force page recreation scenarios
SCRAPER_CONCURRENCY=2 \
npm run scraper:dlstreams:debug
```

## Monitoring Improvements

### Metrics to Watch
1. **Block Detection Rate**
   - Before: Very high false negatives (blocks not detected)
   - Expected: Lower false negative rate due to 8 pattern detection

2. **Protocol Error Recovery**
   - Before: "Session closed" → immediate failure
   - Expected: Protocol errors → page recreation → retry

3. **Concurrency Stability**
   - Before: Rapid downgrade (3 → 1)
   - Expected: More stable (3 → 1-2 only on real blocks)

4. **UA Distribution in Logs**
   - Before: All Chrome 127
   - Expected: Mix of browsers in output

5. **Timing Distributions**
   - Before: Predictable patterns
   - Expected: 20% have extra 500-3000ms delays

### Key Log Patterns to Look For
```
[DIAG] Block detection: {...} ← Diagnostic info on detected blocks
Extra timing noise: ← Shows when noise was added
Protocol error recovery: ← Shows when protocol errors were recovered
```

## Environmental Variables for Fine-tuning

```bash
# Block storm tuning
SCRAPER_BLOCK_STORM_TRIGGER=2              # default: 2
SCRAPER_BLOCK_STORM_COOLDOWN_MIN_MS=45000  # default: 45s
SCRAPER_BLOCK_STORM_COOLDOWN_MAX_MS=90000  # default: 90s

# Retry tuning
SCRAPER_RETRY_MIN_DELAY_MS=2000            # default: 2s
SCRAPER_RETRY_MAX_DELAY_MS=6000            # default: 6s

# Protocol timeout tuning
SCRAPER_PROTOCOL_TIMEOUT_MS=180000         # default: 3 min

# Adaptive concurrency
SCRAPER_ADAPTIVE_CONCURRENCY=1             # default: 1 (enabled)
SCRAPER_MIN_CONCURRENCY=1                  # default: 1
SCRAPER_SUCCESS_THRESHOLD=8                # default: 8 successes to ramp up
```

## Next Steps if Issues Persist

### If Still Getting Blocks:
1. Increase block storm cooldown:
   ```bash
   SCRAPER_BLOCK_STORM_COOLDOWN_MIN_MS=120000 (2 min)
   SCRAPER_BLOCK_STORM_COOLDOWN_MAX_MS=180000 (3 min)
   ```

2. Reduce concurrency:
   ```bash
   SCRAPER_CONCURRENCY=1  # Instead of default 3
   ```

3. Add more timing jitter:
   ```bash
   SCRAPER_TASK_JITTER_MIN_MS=500    # Instead of 250
   SCRAPER_TASK_JITTER_MAX_MS=3000   # Instead of 1200
   ```

### If Protocol Errors Persist:
1. Increase page creation timeout:
   ```bash
   # Modify getLaunchOptions() protocolTimeout to 240000 (4 min)
   ```

2. Reduce concurrency to (1):
   ```bash
   SCRAPER_CONCURRENCY=1
   ```

### If Block Detection Over-triggers (too many false positives):
1. Review fail_*.html files for patterns
2. Update detectBlockPage() function
3. Report new block patterns to dev notes

## Files Modified
- `server/services/dlstreamsResolver.js` - Block detection, UA rotation, headers
- `server/scraper/dlstreams.js` - Protocol error handling, timing noise

## Expected Outcome
- Reduced block detection (or better accuracy)
- Better protocol error recovery
- More human-like request patterns
- Clearer diagnostics for future debugging
