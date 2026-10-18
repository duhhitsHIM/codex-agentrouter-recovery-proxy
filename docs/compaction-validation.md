# Compaction recovery validation

The opt-in recovery path was checked with Codex 0.162.1 and remote compaction v2.
These results cover the tested fixtures and backends, not lossless retention of arbitrary history.

## Local regression suite

The suite covers three dependent checkpoints, byte-for-byte preservation of non-compaction
input fields, tool results, image/audio input shapes, persistence and restart, credential
separation, backend rotation, missing/corrupt/cyclic checkpoints, bounded work, cancellation,
replay output validation, and the prohibition on retrying after visible output.

Media in local HTTP fixtures is synthetic; this verifies forwarding behavior rather than model
perception. The existing reasoning-recovery, authentication and streaming tests also run.

## Live check

Two private backends were tested in both switching directions using the same model identifier.
Each source conversation had three genuine encrypted compaction checkpoints. Each stage added
a fresh random user marker, a random value read by a real tool, a worker limit, an assistant-created
alias, and a separate image. This gives 15 fact checks across three stages.

The live integration imported the six previously captured source checkpoints into a private
`FileCompactionStore`, then sent the final original request through this PR's automatic recovery
path. It did not manually mint or install target compactions. Automatic capture and the ordering
of persistence before the completed event are covered by the local HTTP tests.

All three original image inputs were removed from the final request, making the image check
depend on conversation memory. The original source checkpoints still contained the images needed
for replay. The tool random values and assistant aliases were absent from the remaining plaintext.
The final question prohibited tool calls and new file/image reads.

| Direction | Source control | Automatic recovery | Image facts | Restart using saved mappings |
|---|---|---|---|---|
| Backend A to B | 15/15 | 15/15 | 3/3 | 15/15 |
| Backend B to A | 15/15 | 15/15 | 3/3 | 15/15 |

Worker limits were recalled as 13, 17 and 19, rather than a conflicting background default of 7.
The three original tool invocations per conversation were not repeated; their audit files were
unchanged. The initial automatic recovery requests took approximately 40 and 41 seconds, including
rejection detection, three compaction replays, and the final model reply.

This check did not import arbitrary Codex rollout files, exercise live audio perception, test every
provider/model, or prove that every detail of a compressed conversation survives recompression.
Private endpoints, credentials, rollout paths, complete prompts, runtime state and encrypted
payloads are deliberately excluded from this repository.
