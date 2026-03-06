# User-Specific Playlists Design

## 1. Goal
Currently, Nodecast-TV supports multiple users, but playlists/sources are shared among all users. The goal is to make playlists (Sources) user-specific. 
- The `admin` user should be able to create, view, edit, and delete ALL playlists.
- A `viewer` user should only be able to create, view, edit, and delete their OWN playlists.
- The UI (Channels, Movies, Series, EPG) and Sync Service must only process/show content from the sources that belong to the logged-in user (or all content for the admin, or let admin see content based on the user they are viewing if we add a filter, but ideally, admin just sees everything or filters by source).

## 2. Approach Options

### Option A: Add `user_id` to Source Model (Recommended)
We add a `user_id` field to the `sources` in `db.json`. 
- When a `viewer` creates a source, we attach their `user_id`.
- When an `admin` creates a source, we attach their `user_id` (or leave it null/0 to mean "global/admin shared").
- **Trade-offs:** 
  - Simple to implement.
  - Requires updating the `sources` CRUD logic in `server/db.js` and `server/routes/sources.js`.
  - The SQLite DB (`content.db`) that holds `categories`, `playlist_items`, and `epg_programs` already separates data by `source_id`. We just need to ensure that when querying the API (e.g., `/api/channels/recent`, `/api/sources`), we filter `source_id`s based on the requesting user's permissions.

### Option B: Create a Mapping Table (`user_sources`)
Instead of modifying the source itself, create a mapping array in `db.json` (e.g., `user_sources: [{ userId: 1, sourceId: 2 }]`).
- **Trade-offs:**
  - Allows for a future where a source can be shared among multiple specific users.
  - More complex queries and joins.

### Option C: Separate DB for each user
Each user gets their own `db.json` and `content.db`.
- **Trade-offs:**
  - True isolation.
  - Heavy overhead, very complex background syncing.

## 3. Recommended Approach: Option A (Add `user_id` to Source Model)
Given the straightforward requirement, Option A is the cleanest. 

### Implementation Details:
1. **Data Model (`data/db.json`):**
   - Add `user_id: <id>` to each newly created source.
   - For existing sources, run a migration on startup to assign them to the first `admin` user (usually ID 1) so they don't orphan.

2. **Source Management (`server/routes/sources.js` & `server/db.js`):**
   - `GET /api/sources`: If user is `admin`, return all sources. If `viewer`, return only sources where `source.user_id === req.user.id`.
   - `POST /api/sources`: Automatically attach `req.user.id` to the new source.
   - `PUT /api/sources/:id` & `DELETE /api/sources/:id`: Check if source belongs to `req.user.id` (or if user is admin) before allowing edit/delete.

3. **Content Queries (`server/routes/channels.js`, `server/routes/search.js` etc.):**
   - When fetching content (live, movies, series, recent), the UI usually doesn't pass a `source_id` unless filtering. 
   - We need to ensure that the server only returns content whose `source_id` belongs to the logged-in user.
   - We can fetch the list of `allowed_source_ids` for `req.user` from `db.json`, and pass it to the SQLite queries using `IN (?, ?, ...)`.

4. **Background Sync (`server/services/syncService.js`):**
   - Sync service syncs by `source_id`. It just reads the URL and dumps to SQLite. It doesn't need to know about users, it just syncs the source. This remains unchanged.

5. **UI Updates (`public/js/components/SourceManager.js`):**
   - No major UI changes needed for the basic functionality, as the API will naturally filter out sources the user shouldn't see.

## What do you think?
Should we proceed with **Option A**? Do you want admins to have their own private lists, or should admins see *everybody's* lists mixed together in the live TV interface?
