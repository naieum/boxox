# MIME regression corpus

Run `pnpm --filter @boxox/worker exec vitest run test/fuzz`.

Eight synthetic seeds cover broken encoded words/charsets, unterminated multipart,
conflicting authentication headers, unsafe attachment names/base64, active HTML,
folded/malformed message IDs, LF-only input and NULs. Each seed also runs through
reproducible truncation, byte-flip and NUL mutations. Generated cases exercise
configured part/header/byte/depth limits, embedded RFC822 expansion and recipient
bounds. There is no network access or model call. Passing means these cases return
bounded parse outcomes; it does not establish parser correctness for all MIME or
measure worst-case production CPU/memory.
