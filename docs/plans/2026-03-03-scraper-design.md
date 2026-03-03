# Design: EVENTI-LIVE Scraper Integration

## Overview
Integrare uno scraper Python esistente (`scraper/scraper.py`) nel sistema NodeCast-TV per generare automaticamente una playlist "EVENTI-LIVE" aggiornata ogni ora e disponibile per tutti gli utenti.

## Architecture

### 1. Scraper Enhancement
- **File Output**: Modificare `scraper/scraper.py` per salvare il contenuto M3U in `scraper/playlist.m3u`.
- **Error Handling**: Assicurarsi che il file venga salvato solo in caso di successo parziale o totale.

### 2. ScraperService (Backend)
- **Execution**: Un nuovo servizio Node.js (`server/services/ScraperService.js`) gestirà l'esecuzione dello script Python tramite `child_process.spawn`.
- **Scheduling**: Il servizio utilizzerà `setInterval` per eseguire lo scraper ogni 60 minuti.
- **Manual Trigger**: API endpoint per permettere all'admin di avviare lo scraper manualmente.
- **Logging**: Cattura degli output (stdout/stderr) per monitoraggio nel tab Settings.

### 3. All-User Availability (EVENTI-LIVE)
- **System Source**: Creare un record speciale nel database `db.json` con un ID riservato (es. ID 0) e nome "EVENTI-LIVE".
- **Source Sharing**: Modificare la logica di filtraggio in `server/routes/sources.js` per includere sempre le sorgenti con `user_id: 0` per ogni utente loggato.

### 4. Admin UI (Settings)
- **Scraper Section**: Aggiungere una sezione nel tab Settings per:
  - Visualizzare l'ultimo stato di sincronizzazione.
  - Visualizzare i log dell'ultima esecuzione.
  - Pulsante "Esegui Ora" per trigger manuale.

## Dependency Analysis & Alpine Support (Bare Metal)

L'esecuzione dello scraper su **Alpine Linux** direttamente sull'host (senza Docker) richiede:

### 1. System Dependencies (Alpine APK)
Pacchetti da installare tramite `apk`:
- `python3`, `py3-pip`
- `chromium` (browser di sistema)
- Librerie: `nss`, `freetype`, `harfbuzz`, `ca-certificates`, `ttf-freefont`

### 2. Python Dependencies
Moduli via `pip`:
- `playwright`, `playwright-stealth`

### 3. Chromium Configuration
- Lo script utilizzerà `/usr/bin/chromium-browser`.
- Skip download dei browser Playwright per compatibilità con Alpine.

## Shared Source Implementation
- **Reserved ID**: Sorgente "EVENTI-LIVE" con `user_id: 0`.
- **Global Visibility**: Modifica a `server/routes/sources.js` per includere sorgenti di `user_id: 0` per tutti.

## Success Criteria
- Setup completato con script dedicato.
- Playlist generata localmente e caricata dal sistema.
- Visibilità universale per tutti gli utenti.

## User Decisions Summary
- **Visibility**: Obbligatoria (user_id: 0).
- **Resources**: Esecuzione oraria headless (accettata).
- **Environment**: Bare-metal Alpine (confermato).
