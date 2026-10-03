# Afrikaans

A personal Afrikaans practice app, installed on my phone from GitHub Pages.

This repository holds **only the app code**. My vocabulary and sentences live in a private Obsidian vault repository (`afrikaans-vault`). A GitHub Action there turns the notes into `deck.json` and Afrikaans audio on a `deck` branch, and the app downloads them using a personal access token stored on the phone.

- **Spaced repetition:** FSRS, via [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) (MIT), which is vendored in `vendor/`.
- **Card types:**
  - Afrikaans → English
  - English → Afrikaans (typed)
  - fill-the-gap in sentences
- **Offline:** works without a connection once loaded. Progress is stored on the device in IndexedDB.

There's no build step: plain HTML, CSS and ES modules.
