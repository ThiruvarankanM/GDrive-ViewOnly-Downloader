# GDrive ViewOnly Downloader

Download Google Drive **view-only** videos directly from your terminal — no extensions, no screen recording.

---

## Prerequisites

Install these before anything else:

- [Node.js](https://nodejs.org/) v18+
- [Python 3](https://www.python.org/)
- [Chrome](https://www.google.com/chrome/) browser
- [ffmpeg](https://ffmpeg.org/) → `brew install ffmpeg`

---

## Step 1 — Clone the repo

```bash
git clone https://github.com/ThiruvarankanM/GDrive-ViewOnly-Downloader.git
cd GDrive-ViewOnly-Downloader
```

## Step 2 — Install dependencies

```bash
npm install
pip3 install curl_cffi
```

## Step 3 — Download a video

```bash
node dl.mjs "https://drive.google.com/file/d/YOUR_FILE_ID/view"
```

1. Chrome will open and navigate to the file
2. **Sign in** to your Google account if prompted
3. Once you can see the file, press **Enter** in the terminal
4. The video downloads automatically and saves as an MP4 in the current folder

---

## Notes

- Your Google session is saved locally so you only sign in once
- Output file is saved in the folder where you run the command
- Works with any view-only shared Google Drive video link
