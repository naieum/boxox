#!/usr/bin/env bash
# Downloads the labelled spam corpus into .corpus/ (git-ignored) for
# scripts/spam-eval.ts and scripts/model-eval.ts:
#   - SpamAssassin public corpus (ham, hard ham, spam; Apache SpamAssassin project)
#   - Jose Nazario's phishing corpus, recent years (CC-BY-4.0)
# Archives are untrusted data: they are only extracted and read as text,
# never executed. Re-running skips files already downloaded.
#
# Usage: scripts/fetch-corpus.sh [dest]   (default .corpus)
set -euo pipefail

DEST="${1:-.corpus}"
SA="https://spamassassin.apache.org/old/publiccorpus"
PHISH="https://monkey.org/~jose/phishing"
SA_SETS=(20030228_easy_ham 20030228_easy_ham_2 20030228_hard_ham 20030228_spam 20050311_spam_2)
PHISH_SETS=(phishing-2023 phishing-2024 phishing-2025)

mkdir -p "$DEST/downloads" "$DEST/spamassassin" "$DEST/phishing"

fetch() {
  local url="$1" out="$2"
  if [[ -s "$out" ]]; then return; fi
  echo "fetch $url"
  curl -fsSL --retry 3 --max-time 600 -o "$out.part" "$url"
  mv "$out.part" "$out"
}

for set in "${SA_SETS[@]}"; do
  fetch "$SA/$set.tar.bz2" "$DEST/downloads/$set.tar.bz2"
  if [[ ! -d "$DEST/spamassassin/$set" ]]; then
    tmp="$DEST/spamassassin/.$set.tmp"
    rm -rf "$tmp" && mkdir -p "$tmp"
    tar -xjf "$DEST/downloads/$set.tar.bz2" -C "$tmp" --no-same-owner --no-same-permissions
    # Each archive holds one directory (easy_ham, spam_2, ...); keep its files flat.
    inner="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n1)"
    mv "$inner" "$DEST/spamassassin/$set"
    rm -rf "$tmp"
    rm -f "$DEST/spamassassin/$set/cmds"
  fi
done

for set in "${PHISH_SETS[@]}"; do
  fetch "$PHISH/$set" "$DEST/phishing/$set.mbox"
done
fetch "$PHISH/LICENSE.txt" "$DEST/phishing/LICENSE.txt"

( cd "$DEST" && find downloads phishing -type f -name '*.bz2' -o -type f -name '*.mbox' | sort | xargs shasum -a 256 > SHA256SUMS )

echo "corpus ready in $DEST:"
for d in "$DEST"/spamassassin/*/; do printf '  %-34s %6d files\n' "$(basename "$d")" "$(find "$d" -type f | wc -l)"; done
for f in "$DEST"/phishing/*.mbox; do printf '  %-34s %6d messages\n' "$(basename "$f")" "$(grep -c '^From ' "$f" || true)"; done
