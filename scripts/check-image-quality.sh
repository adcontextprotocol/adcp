#!/bin/bash
# Pre-commit check for image quality: alt text presence, file size, format.
# Runs on staged image files and docs that reference images.

set -euo pipefail

MAX_IMAGE_SIZE_KB=500

# Get staged files
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)
[ -z "$STAGED_FILES" ] && exit 0

# Collect staged images
STAGED_IMAGES=$(echo "$STAGED_FILES" | grep -E '^images/' || true)

# Collect staged docs
STAGED_DOCS=$(echo "$STAGED_FILES" | grep -E '^docs/.*\.(mdx?|md)$' || true)

# Nothing image-related staged
[ -z "$STAGED_IMAGES" ] && [ -z "$STAGED_DOCS" ] && exit 0

ERRORS=()

# Check 1: Image file size
for img in $STAGED_IMAGES; do
  [ -f "$img" ] || continue
  size_kb=$(( $(wc -c < "$img") / 1024 ))
  if [ "$size_kb" -gt "$MAX_IMAGE_SIZE_KB" ]; then
    ERRORS+=("$img: ${size_kb}KB exceeds ${MAX_IMAGE_SIZE_KB}KB limit — compress before committing")
  fi
done

# Check 2: Alt text presence for images referenced in staged docs
for doc in $STAGED_DOCS; do
  [ -f "$doc" ] || continue
  # Find img tags with empty alt text
  empty_alts=$(perl -0777 -ne '
    while (/<img\s+[^>]*alt=""[^>]*src="(\/images\/[^"]+)"[^>]*\/?>/gs) {
      print "$1\n";
    }
    while (/<img\s+[^>]*src="(\/images\/[^"]+)"[^>]*alt=""[^>]*\/?>/gs) {
      print "$1\n";
    }
  ' "$doc" 2>/dev/null || true)

  for img_src in $empty_alts; do
    ERRORS+=("$doc: $img_src has empty alt text")
  done

  # Find img tags without alt attribute at all
  missing_alts=$(perl -0777 -ne '
    while (/<img\s+(?![^>]*alt=)[^>]*src="(\/images\/[^"]+)"[^>]*\/?>/gs) {
      print "$1\n";
    }
  ' "$doc" 2>/dev/null || true)

  for img_src in $missing_alts; do
    ERRORS+=("$doc: $img_src is missing alt attribute")
  done
done

# Check 3: Staged images should be referenced in at least one doc
for img in $STAGED_IMAGES; do
  [ -f "$img" ] || continue
  img_ref="/$img"
  if ! grep -rql "$img_ref" docs/ 2>/dev/null; then
    echo "⚠ Warning: $img is not referenced in any doc file"
  fi
done

# Check 4: Gemini vision check for gibberish text in staged images
if [ -n "$STAGED_IMAGES" ] && [ -n "${GEMINI_API_KEY:-}" ]; then
  if ! command -v jq &>/dev/null; then
    echo "⚠ jq not installed — skipping image text validation"
  elif ! command -v curl &>/dev/null; then
    echo "⚠ curl not installed — skipping image text validation"
  else
    for img in $STAGED_IMAGES; do
      [ -f "$img" ] || continue

      # Detect MIME type
      case "$img" in
        *.png)        MIME="image/png" ;;
        *.jpg|*.jpeg) MIME="image/jpeg" ;;
        *.webp)       MIME="image/webp" ;;
        *.svg)        echo "  Skipping SVG (not raster): $img"; continue ;;
        *)            MIME="image/png" ;;
      esac

      echo "Validating image text: $img"

      # Base64 encode to temp file to avoid shell variable size limits
      IMG_B64_FILE=$(mktemp)
      base64 -i "$img" > "$IMG_B64_FILE" 2>/dev/null || base64 -w0 "$img" > "$IMG_B64_FILE" 2>/dev/null

      VALIDATION_PROMPT="Analyze this image for quality. List ALL text visible in the image verbatim. Then determine if any text is truly garbled or nonsensical — random characters, AI-hallucinated words, or strings that are not real words in any language. Do NOT flag: abbreviations, acronyms, ellipsis, technical terms, UI state labels, or intentional placeholder text. Respond ONLY with valid JSON (no markdown fences): { \"visible_text\": [\"text1\"], \"gibberish_found\": true/false, \"gibberish_details\": \"...\" }"

      PAYLOAD_FILE=$(mktemp)
      jq -n \
        --rawfile img "$IMG_B64_FILE" \
        --arg prompt "$VALIDATION_PROMPT" \
        --arg mime "$MIME" \
        '{contents: [{parts: [{inline_data: {mime_type: $mime, data: ($img | rtrimstr("\n"))}}, {text: $prompt}]}]}' > "$PAYLOAD_FILE"
      rm -f "$IMG_B64_FILE"

      RESPONSE=$(curl -s --max-time 30 \
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent" \
        -H 'Content-Type: application/json' \
        -H "x-goog-api-key: ${GEMINI_API_KEY}" \
        -d @"$PAYLOAD_FILE" 2>/dev/null)
      rm -f "$PAYLOAD_FILE"

      RESULT_TEXT=$(echo "$RESPONSE" | jq -r '.candidates[0].content.parts[0].text // empty' 2>/dev/null)
      if [ -z "$RESULT_TEXT" ]; then
        echo "  ⚠ Could not validate (API error), skipping"
        continue
      fi

      RESULT_JSON=$(echo "$RESULT_TEXT" | sed '/^```/d')
      GIBBERISH=$(echo "$RESULT_JSON" | jq -r '.gibberish_found // false' 2>/dev/null)
      GIBBERISH_DETAILS=$(echo "$RESULT_JSON" | jq -r '.gibberish_details // empty' 2>/dev/null)

      if [ "$GIBBERISH" = "true" ]; then
        ERRORS+=("$img: gibberish text detected — $GIBBERISH_DETAILS")
      else
        echo "  ✓ Passed"
      fi
    done
  fi
elif [ -n "$STAGED_IMAGES" ]; then
  echo "⚠ GEMINI_API_KEY not set — skipping image text validation"
fi

if [ ${#ERRORS[@]} -gt 0 ]; then
  echo "❌ Image quality check failed:"
  echo ""
  for err in "${ERRORS[@]}"; do
    echo "  • $err"
  done
  echo ""
  echo "Fix these issues before committing."
  exit 1
fi

echo "✅ Image quality checks passed"
