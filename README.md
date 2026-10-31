# Creator Tracker

Tracks each creator's videos, whether they're posted on YouTube Shorts and TikTok, and their views.

- **Site:** GitHub Pages for this repo.
- **Editing:** on the site, click **Connect** (or ⚙) and paste a GitHub token once (kept only in your browser). Then add videos with **+ Add video** or the **Ask AI** button. Changes are saved to `data.json`.
- **Views:** `.github/workflows/update.yml` runs about every 5 minutes (GitHub sometimes delays it), fetches YouTube/TikTok view counts for any video with a link, and writes them to `stats.json` on the `data` branch, which the site reads.
- If TikTok blocks the bot, type that video's TikTok views in by hand on the site.
