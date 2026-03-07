# Zero-Shared Multi-User Architecture for Nodecast TV

## Overview
This document outlines the architectural changes required to bring "true multi-user" capabilities to Nodecast TV. Currently, the system uses a shared database strategy where `sources` (and their synced `playlist_items`) are global. User isolation exists superficially for preferences (`favorites`, `hiddenItems`). 

The objective is to implement **Option B + A**: 
- Every user (except perhaps system defaults if any) manages their own M3U/Xtream sources.
- The syncing processes save `playlist_items` strictly partitioned by the `user_id` who owns the source.
- This results in complete data isolation at the DB level, providing maximum security, avoiding cross-contamination of M3U content, and preparing the system for scalable user management.

## 1. Data Model Changes

### 1.1 `db.json` (Sources & Users)
We introduce ownership over `sources`. 

**`sources` collection update:**
```javascript
{
  "id": 1,
  "user_id": 2,          // NEW: The owner of this playlist
  "type": "m3u",
  "name": "My Personal IPTV",
  "url": "http://...",
  // ... existing fields
}
```

Since the `user_id` will be associated with the source, preferences like `favorites` and `hiddenItems` that operate on `source_id` will naturally inherit this isolation. However, to prevent ID spoofing via API, API operations will strictly validate source ownership.

### 1.2 `content.db` (SQLite - `playlist_items`)
The streaming/EPG metadata is stored here. Because `playlist_items` already have a `source_id` foreign key, the data is technically already partitioned by source. 
No schema changes strictly required for `playlist_items` if `source_id` mapping is strongly enforced, but adding `user_id` as a denormalized column could speed up broad queries.

**Decision:** We will **not** alter the SQLite schema unless necessary, because queries always filter by `source_id`. We only need to ensure users only get the `source_ids` they own.

## 2. API & Authorization Flow

### 2.1 Backend Routing (`server/routes/ sources, proxy, channels, etc.`)
All data retrieval routes must verify ownership.

- **Non-Admin Users (`viewer`)**:
  - `GET /api/sources`: Returns only `sources` where `user_id === req.user.id`.
  - `GET /api/channels/...`: Only queries `content.db` for the user's `source_ids`.
  - `POST /api/sources`: Injects `req.user.id` into the payload before saving to `db.json`.
  - Proxy/Streaming (`/proxy/...`): Validates that the requested `source_id` belongs to `req.user.id`.

- **Admin Users (`admin`)**:
  - Admins need two operational modes or broad access. For the initial phase, admins will be able to see and manage *all* sources in the Settings panel for administrative operations (syncing, deleting abandoned sources).
  - But for the main viewing UI (Live TV, Movies, Series), the Admin should arguably only see *their own* sources, or they would be overwhelmed by thousands of duplicate channels from all users. 
  - *Recommendation*: Admin viewing UI uses `user_id === req.user.id`. Admin settings UI can fetch all items via a special `GET /api/sources/all` endpoint.

### 2.2 Sincronizzazione (SyncService)
When `runSync` executes, it processes a specific `source`. It doesn't need to know about the user, as the `source` is already isolated by ID.
The `Content DB` will naturally grow based on the sum of all users' channels. (Option A selected).

## 3. Frontend Adjustments
- **Source Manager**:
  - In the "Sources" admin panel, show who owns the source (e.g., a badge "User: Frank").
  - Send the requests normally. The backend will enforce ownership natively.

- **Playback/Cache isolation**:
  - In `HLS Stream/Proxy`, the system caches M3U8 files. Ensure cache keys include `source_id` (so `user_A` doesn't accidentally pull `user_B`'s cached manifest if they happen to share an upstream channel ID).

## 4. Migration Plan
For existing installations, existing `sources` currently do not have a `user_id`.
A migration script during startup will assign all existing `sources` to the first `admin` account found in `db.json`.

## Summary of Trade-offs
- **Pros**: Perfectly strict data separation. No risk of accidental info leakage. Easy to drop a single user's data (just delete their sources and `DELETE FROM playlist_items WHERE source_id IN (...)`).
- **Cons**: Increased storage size on disk for `content.db` if multiple users use the exact same M3U provider. Given SQLite's efficiency, this is an acceptable trade-off for architectural purity.
