# Project Rules

- Any change to `javbus-tracker.user.js` that affects runtime behavior must update the userscript `@version` metadata before commit.
- Run `node --test` before committing code changes.
- For JavBus detail-page DOM or media changes, verify against a real JavBus detail page in a browser, not only with URL/unit tests.
