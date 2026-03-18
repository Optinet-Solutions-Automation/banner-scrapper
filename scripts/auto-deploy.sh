#!/usr/bin/env bash
# Auto-deploy hook: git commit + push + Cloud Run deploy
# Called by Claude Code PostToolUse hook after Edit/Write

PAYLOAD=$(cat)
FILE_PATH=$(echo "$PAYLOAD" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log((j.tool_input&&j.tool_input.file_path)||'')}catch(e){console.log('')}})" 2>/dev/null)

# Only process files inside BannerScrapper
if [[ -z "$FILE_PATH" ]] || [[ "$FILE_PATH" != *"BannerScrapper"* ]]; then
  exit 0
fi

CWD="C:/Users/User/Desktop/BannerScrapper"

# Stage the changed file
git -C "$CWD" add "$FILE_PATH" 2>/dev/null || true

# Check if there's anything staged
DIFF=$(git -C "$CWD" diff --cached --name-only 2>/dev/null || echo "")
if [ -z "$DIFF" ]; then
  exit 0
fi

# Commit
FNAME=$(basename "$FILE_PATH")
git -C "$CWD" commit -m "auto: update $FNAME" 2>/dev/null || true

# Push (triggers Vercel auto-deploy)
git -C "$CWD" push origin main 2>/dev/null || true

# Deploy to Cloud Run in background
powershell.exe -ExecutionPolicy Bypass -Command "& 'C:\Users\User\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd' builds submit --config cloudbuild.yaml --project banner-scraper-api 2>&1" &

exit 0
