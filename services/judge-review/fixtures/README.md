# NEAR AI answers for the tests

NEAR AI Cloud is not reachable from the environment these tests were written in, so no live answer is recorded
here. The two files are NEAR AI's documented response shapes (an OpenAI-compatible chat completion, and
`GET /v1/signature/{chat_id}` from docs.near.ai/cloud/verification/chat), with placeholders the tests fill:

| File | Placeholders |
| --- | --- |
| `completion.json` | `{MODEL}`, `{CONTENT}`: the model's answer text, which the tests write |
| `signature.json` | `{TEXT}` = `model:sha256(request):sha256(response)`, `{SIGNATURE}`, `{ADDRESS}` |

The signature is made by a test key standing in for a model TEE's key (`nearai.rs`, `tee_key`), never by NEAR AI.
What the tests prove is the judge's side: the request it builds, the checks on the answer and on the signature, the
verdict it reaches. A live run against NEAR AI is in the README ("Live run").
