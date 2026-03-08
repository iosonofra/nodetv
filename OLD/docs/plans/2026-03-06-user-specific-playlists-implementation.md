# User-Specific Playlists Implementation Plan

> **For Antigravity:** REQUIRED SUB-SKILL: Load executing-plans to implement this plan task-by-task.

**Goal:** Implement user-specific playlists where viewers only see their own sources, and admins see all sources, including the UI filtering and permission checks.

**Architecture:** We will modify the `db.json` structure to include a `user_id` field on newly created sources. Existing sources will be migrated to the first admin user upon database load. The backend API (`server/routes/sources.js`, `server/routes/channels.js`, `server/db.js`) will be updated to filter queries by `user_id` based on the requester's role (admin vs viewer). The frontend will naturally reflect these changes as API responses will be pre-filtered.

**Tech Stack:** Node.js, Express, better-sqlite3, JSON file storage.

---

### Task 1: Update Database Initialization to Migrate Existing Sources

**Goal:** Ensure existing sources in `data/db.json` are assigned a `user_id` so they aren't orphaned, and ensure the DB module provides a way to extract the first admin ID.

**Files:**
- Modify: `server/db.js`

**Step 1: Modify `loadDb` to migrate sources**

In `server/db.js`, inside `loadDb()`, after parsing `data`, we need to find the first admin user and assign its ID to any sources that lack a `user_id`. Also, when writing new sources, we'll need `user_id`.

```javascript
// Add helper to find first admin
async function getFirstAdminId(db) {
    const defaultId = 1;
    if (!db || !db.users || db.users.length === 0) return defaultId;
    const admin = db.users.find(u => u.role === 'admin');
    return admin ? admin.id : defaultId;
}

// In loadDb(), after constructing the return object:
/*
      const parsedData = {
        sources: data.sources || [],
        // ...
      };
      
      // Migration: Ensure all sources have a user_id
      let needsSave = false;
      const firstAdminId = await getFirstAdminId(parsedData);
      
      parsedData.sources.forEach(source => {
        if (!source.user_id) {
            source.user_id = firstAdminId;
            needsSave = true;
        }
      });
      
      return parsedData;
*/
```
Wait, `loadDb` shouldn't trigger a save itself immediately to avoid race conditions, but modifying the returned object ensures it's saved on the *next* write. That's sufficient for JSON.

### Task 2: Update `sources` CRUD logic in `db.js`

**Goal:** Modify `db.js` `sources` object to optionally filter by `user_id` for viewers, and require `user_id` on creation.

**Files:**
- Modify: `server/db.js`

**Step 1: Update `getAll`, `getById`, `getByType`, `create`**

```javascript
const sources = {
  // Update to accept userId
  async getAll(userId = null, role = 'admin') {
    const db = await loadDb();
    if (role === 'admin' || !userId) return db.sources;
    return db.sources.filter(s => s.user_id === userId);
  },

  async getById(id, userId = null, role = 'admin') {
    const db = await loadDb();
    const source = db.sources.find(s => s.id === parseInt(id));
    if (!source) return null;
    if (role !== 'admin' && userId && source.user_id !== userId) return null; // unauthorized
    return source;
  },

  async getByType(type, userId = null, role = 'admin') {
    const db = await loadDb();
    const filtered = db.sources.filter(s => s.type === type && s.enabled);
    if (role === 'admin' || !userId) return filtered;
    return filtered.filter(s => s.user_id === userId);
  },

  // Require userId
  async create(source, userId) {
    if (!userId) throw new Error('user_id is required to create a source');
    const db = await loadDb();
    const newSource = {
      id: db.nextId++,
      ...source,
      user_id: userId,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.sources.push(newSource);
    await saveDb(db);
    return newSource;
  },
  // Update update, delete to check if source exists which also implies ownership if passed through getById in route
};
```

### Task 3: Secure the API Routes (`sources.js`)

**Goal:** Apply the `user_id` checks to all incoming `/api/sources` HTTP requests using the `req.user` object provided by passport.

**Files:**
- Modify: `server/routes/sources.js`

**Step 1: Require Auth and Pass IDs**

Every route in `sources.js` needs `requireAuth`. Wait, the system might have it mounted with `requireAuth` in `index.js` or `auth.js`? Let's assume we need to import `const { requireAuth } = require('../auth');` and use `router.use(requireAuth);` at the top of `sources.js`.

Update the route handlers:
- `router.get('/')` -> `await sources.getAll(req.user.id, req.user.role)`
- `router.get('/:id')` -> `await sources.getById(req.params.id, req.user.id, req.user.role)`
- `router.post('/')` -> pass `req.user.id` to `create`
- For `PUT`, `DELETE`, `POST /:id/toggle`, `POST /:id/sync`: First call `getById` with `req.user.id` and `role`. If it returns null, return 404 or 403.

### Task 4: Filter Content by Permitted Sources (`channels.js`)

**Goal:** When querying `playlist_items`, `categories`, and `epg_programs`, only return data from sources the user is allowed to see.

**Files:**
- Modify: `server/routes/channels.js`

**Step 1: Helper function for Authorized Sources**

In `channels.js`, add a helper to get allowed source IDs:
```javascript
const { sources } = require('../db');

async function getAllowedSourceIds(req) {
    const allowedSources = await sources.getAll(req.user.id, req.user.role);
    return allowedSources.map(s => s.id);
}
```

**Step 2: Update SQLite queries**

Every query that does `SELECT ... FROM playlist_items` or `categories` needs an `IN (?, ?, ...)` clause for `source_id`.
Since SQLite `run` or `all` needs variable arguments:

```javascript
const allowedSources = await getAllowedSourceIds(req);
if (allowedSources.length === 0) return res.json([]); // No sources, return empty

const placeholders = allowedSources.map(() => '?').join(',');

// Example update:
const recentItems = db.prepare(`
    SELECT * FROM playlist_items p
    WHERE p.type = ? 
        AND p.source_id IN (${placeholders})
        AND p.is_hidden = 0
        ...
`).all(type, ...allowedSources, parseInt(limit));
```

Update `/recent`, `/hidden`, `/show`, `/hide` bulk endpoints.

### Task 5: Database Migration Script / Boot logic

**Goal:** Ensure the migration code actually runs securely on boot.

**Files:**
- Modify: `server/db.js`

We will add a dedicated `runMigrations(data)` function inside `db.js` that `loadDb()` invokes if `db.json` lacks `user_id`s.

### Summary
This plan covers the entire backend requirement for Option A and Option 2 (Admins see all sources everywhere).

---
