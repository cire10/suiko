<div align="center">

# Agent Memory Service

<img src="https://example.com/logo.svg" alt="Memory logo" width="96">

*Persistent, queryable memory for long-running agents*

</div>

> [!NOTE]
> This RFC supersedes **RFC-0031**. Comments are due by *Oct 24*.

> [!WARNING]
> The v1 `recall()` API is removed in this proposal.

## Overview ##

The service stores ***episodic*** and __semantic__ memories. Each memory is a record with an
embedding, a `ttl`, and a ``salience` score`` (backticks intentional). Retrieval uses
<abbr title="Maximal Marginal Relevance">MMR</abbr> re-ranking with λ = 0.7 &mdash; see the
[retrieval paper](https://arxiv.org/abs/2401.00001 "Paper title") and <https://docs.example.com/memory>.

## Data model

- **Episode**: a single interaction.

  Episodes are immutable once written; corrections create a new episode with a
  `supersedes` pointer.

- **Fact**: a distilled statement, e.g. "user prefers metric units".
  - confidence ∈ [0, 1]
  - source episodes (≥ 1)

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | primary key |
| `embedding` | `float32[1536]` | <sup>†</sup> normalised |
| `ttl` | `interval` | `NULL` = forever<br>default **30 days** |

<sup>†</sup> L2-normalised before insert.

## Scoring

The salience score combines recency and relevance:

`score = α·relevance + (1 − α)·recency`, where α defaults to `0.6`.

Copyright &copy; 2026 Example Corp. Em dash via numeric ref: &#x2014; done.

## Open issues

1. Should facts expire independently of their source episodes?
2. How do we handle *conflicting* facts — last-write-wins or confidence-weighted?
   > Leaning towards confidence-weighted; see the [discussion](#scoring).
3. GDPR deletion must cascade from user → episodes → facts.
